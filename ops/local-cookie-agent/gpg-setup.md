# gpg key exchange — one key, one direction

The cookie blob is encrypted **on this machine** to a key that only **n8n-vm**
can open. That is what makes the blob safe to sit in a drop-box, safe in an
off-host backup, and (in the tailnet-down last resort) safe to send as a
Telegram *document* — it is ciphertext to everyone but the VM.

Exactly one piece of key material ever moves: the VM's **public** key, VM →
here. The private key is generated on the VM and never leaves it.

## On the VM (once)

```bash
# NOTE the --batch --passphrase '' — this is not optional. See below.
gpg --batch --passphrase '' \
    --quick-generate-key "aries-cookie-vm <brendan3394@gmail.com>" default default never

gpg --armor --export aries-cookie-vm > /tmp/aries-cookie-vm.pub
# copy /tmp/aries-cookie-vm.pub to this machine (scp over the tailnet), then:
rm /tmp/aries-cookie-vm.pub
```

### Why the key must have no passphrase

`cookie-ingest.py` runs from **cron**: no TTY, no pinentry. A passphrase-
protected key makes the first automated decrypt hang or die with
`Inappropriate ioctl for device`. The visible symptom is not an error — it is
sessions quietly going stale and never being refreshed, which is the hardest
version of this to debug.

If you insist on a passphrase, the VM must be configured for it explicitly:
put the passphrase in a `0600` file and set `ARINGEST_PASSPHRASE_FILE=/that/path`;
the ingest then adds `--pinentry-mode loopback --passphrase-file …`. Both paths
are covered by `cookie-ingest.py --self-test`.

A passphrase on this key buys little anyway: it lives on the same host as the
cookies it protects, so anyone who can read one can read the other.

## On this machine (once)

```bash
gpg --import aries-cookie-vm.pub
rm aries-cookie-vm.pub

gpg --list-keys aries-cookie-vm          # confirm it is there
```

`refresh-cookies.sh` encrypts with `--trust-model always --recipient
"$GPG_RECIPIENT"`, so you do **not** need to sign or ultimately-trust the key —
which is right: trust here means "this is the VM's key", established by the fact
that you carried it over the tailnet yourself, not by a web of trust.

## Rotation

If the VM key is ever suspected compromised, or the VM is rebuilt:

1. Generate a new key on the VM (same command).
2. Export and re-import the new public key here; delete the old one:
   `gpg --delete-keys aries-cookie-vm` before importing the replacement.
3. `./refresh-cookies.sh` with every platform — the old blobs in the drop-box
   are now undecryptable and will be quarantined into `~/.agent-reach-inbox/rejected/`
   by the ingest. Delete them there.
4. Treat every cookie that was ever encrypted to the old key as burned: log the
   throwaway accounts out everywhere and re-mint. Rotating the transport key
   without rotating the sessions protects nothing.
