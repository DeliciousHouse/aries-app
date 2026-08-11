# Durable media storage — provisioning and rollout

**Status:** code shipped dark in v0.2.8.0. Requires one-time GCP provisioning
before the flag can be turned on.

## Why

On 2026-08-11 scheduled posts 163 (Instagram, 08:00 PDT) and 166 (Facebook,
09:05 PDT) dead-lettered after four retries each:

```
Instagram API error (status 400): Only photo or video can be accepted as media
type. - The media could not be fetched from this URI: https://aries.sugarand
leather.com/api/public/media/<token>/openai_codex_gpt-image-2-low_20260810_141122_2824f893.png
```

The URL, the HMAC token and Meta were all fine. Each retry minted a *fresh*
token, so expiry was not the cause. The PNG simply did not exist any more —
not in the app container, not on the host, not in the Hermes cache mount.

Every asset generated on 08-10 was gone. Nine pending posts (165, 167-174, all
tenant 15, all from job `mkt_f2a3ed4c-497f-4292-aa5e-fef0892e9d10`) referenced
six files that no longer existed.

The Hermes image cache is a **working cache owned by another process**. It is not
backed up and nothing guarantees a file survives from generation to publish. That
gap used to be hours — every one of the 51 successful dispatches went out
essentially same-day — but the growth pipeline now schedules up to **twelve days**
ahead, so the media has to survive twelve days. It does not.

## What shipped

Object storage as a **third read root behind the existing public proxy**, after
the Hermes mount and `DATA_ROOT/ingested-assets`.

The public URL contract is deliberately unchanged: Meta still fetches
`/api/public/media/<hmac-token>/<basename>` from the same origin with the same
content-type logic. It never sees a bucket URL, a query string or a second TTL.
That shape was frozen on purpose (see `backend/marketing/signable-basename.ts`)
to keep the live Meta-fetch contract stable, and handing Meta a GCS signed URL
would have re-opened exactly that contract.

- Write: production asset ingestion stores the final bytes, keyed on
  `basename(creative_assets.storage_key)` — the exact key the proxy signs.
- Read: the media route falls back to the durable copy only after both local
  roots miss, so the hot path is unchanged when the local file is present.
- Every entry point fails open. A dead bucket, a missing grant, an expired token
  or a hung metadata server degrades to today's behaviour, never to an error.

## Provisioning (one-time, needs an account with project IAM rights)

The VM's attached service account is
`938341276279-compute@developer.gserviceaccount.com` in project
`rare-hull-488101-v9` (zone `us-central1-a`). It already has the
`cloud-platform` scope and mints a valid token from the metadata server, but it
currently has **no** storage permission:

```
938341276279-compute@developer.gserviceaccount.com does not have
storage.buckets.list access to the Google Cloud project.
```

`gcloud` on the VM is authenticated as `brendan@sugarandleather.com` but its
token needs an interactive re-auth, so these must be run from a workstation or
after `gcloud auth login`.

### 1. Create the bucket

Same region as the VM so reads are fast and egress stays internal.

```bash
gcloud storage buckets create gs://aries-media-rare-hull-488101-v9 \
  --project=rare-hull-488101-v9 \
  --location=us-central1 \
  --default-storage-class=STANDARD \
  --uniform-bucket-level-access
```

Keep the bucket **private**. Nothing external reads it — the app proxies the
bytes, so public access would be strictly worse for no benefit.

### 2. Grant the VM service account object access

Object-level only, scoped to this bucket. Do not grant project-wide
`roles/storage.admin`.

```bash
gcloud storage buckets add-iam-policy-binding gs://aries-media-rare-hull-488101-v9 \
  --member=serviceAccount:938341276279-compute@developer.gserviceaccount.com \
  --role=roles/storage.objectAdmin
```

`objectAdmin` (not `objectViewer`) because ingestion writes and the proxy reads.

### 3. Lifecycle

Retention must comfortably exceed the scheduling horizon. The queue currently
runs 12 days out; 90 days leaves room and costs almost nothing at this volume
(~2MB per image, ~7 posts/week, well under 1GB/year).

```bash
cat > /tmp/lifecycle.json <<'JSON'
{"rule":[{"action":{"type":"Delete"},"condition":{"age":90}}]}
JSON
gcloud storage buckets update gs://aries-media-rare-hull-488101-v9 \
  --lifecycle-file=/tmp/lifecycle.json
```

### 4. Verify from the VM before enabling

```bash
TOKEN=$(curl -s -H "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

# write
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: text/plain" -d 'ok' \
  "https://storage.googleapis.com/upload/storage/v1/b/aries-media-rare-hull-488101-v9/o?uploadType=media&name=healthcheck.txt"

# read back
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://storage.googleapis.com/storage/v1/b/aries-media-rare-hull-488101-v9/o/healthcheck.txt?alt=media"
```

Expect `200` then `ok`. If either fails, the grant has not propagated yet —
wait a minute and retry rather than turning the flag on.

## Rollout

In `/home/node/aries-app/.env` (back it up first; the deploy does not manage it):

```
ARIES_DURABLE_MEDIA_ENABLED=1
ARIES_DURABLE_MEDIA_BUCKET=aries-media-rare-hull-488101-v9
```

Then recreate only the services that read these vars. **Never** run a bare
`docker compose up -d` in that directory: it also tries to start `aries-hermes`,
which is deliberately down because Hermes runs on the host.

```bash
cd /home/node/aries-app
docker compose up -d --no-deps --no-build aries-app
```

Before doing that, check `ARIES_APP_IMAGE` in `.env` matches what is actually
running — the deploy does not write it back, and a stale pin silently rolls the
app back:

```bash
docker inspect aries-app-aries-app-1 \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
grep ^ARIES_APP_IMAGE /home/node/aries-app/.env
```

## Verifying it works

The next weekly generation reports the new counter:

```
ingestProductionCreativeAssetsToDb -> { inserted, skipped, total, durableStored }
```

`durableStored` equal to the asset count means copies landed. `0` with the flag
on means uploads are failing — check the app logs for `[durable-media]`.

Then confirm an object exists for a known asset:

```bash
docker exec -i n8n-postgres psql -U aries_app -d aries_auth -t -A -c \
  "SELECT tenant_id, storage_key FROM creative_assets ORDER BY created_at DESC LIMIT 1;"
# -> object should be at creative/<tenant_id>/<basename of storage_key>
```

## What this does not fix

- **It does not recover the nine already-broken posts.** Their bytes are gone;
  there is no copy to promote. They need regenerating.
- **It does not explain what deleted the files.** Ruled out with evidence:
  aries-app (nothing in the repo unlinks under the media mount), the
  hermes-gc worker (`gc-missing-hermes-assets` orphans DB rows, it is a
  reconciler reacting to already-missing files), PR #971's deploy cleanup
  (scoped to Docker images in the target repo, never touches bind mounts),
  `systemd-tmpfiles` (`Q /home` carries no age argument so it never cleans),
  host cron, the hermes-auth-sentinel (unlinks only temp and lock files), and
  hermes's own `image_gen_provider` (unlinks only on oversize / zero-byte error
  paths). Still open.
- **Retention was a second, independent bug.** `ARIES_HERMES_GC_MAX_AGE_DAYS`
  was 7 while the queue schedules 12 days out, so an asset could be reconciled
  away five days before its post published. Raised to 30 on 2026-08-11.
