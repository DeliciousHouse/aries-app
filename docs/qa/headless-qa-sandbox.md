# Headless QA sandbox — rendered-UI verification without a human browser

Purpose: let an agent on the prod host do **rendered** verification of the live
app (screenshots, dialogs, real submissions) with a real authenticated session
— no pairing, no cookie exports, no human browser online. First used to verify
the SC-70 incident-report button end-to-end (AA-74, 2026-07-03).

## Security model

- One sandbox org (`aries-qa-sandbox`) + one QA user (`qa-bot@aries-qa.internal`).
- The QA user has **no usable password** — its hash is over random bytes
  discarded at seed time. Credentials login is impossible.
- Sessions are minted by `scripts/qa/mint-qa-session.ts`, which encodes an
  Auth.js session JWT with the app's own `NEXTAUTH_SECRET` (same
  `next-auth/jwt` `encode`, same cookie-name salt). Host access to the app's
  `.env` is the trust boundary — the same one that already protects every
  session.
- Fail-closed pinning: the mint script refuses any identity other than the QA
  email on the sandbox tenant slug (`scripts/qa/qa-session-lib.ts`
  `assertQaScoped`), TTL is clamped to 12h (default 2h), and every mint writes
  an audit line to stderr. The token goes to a 0600 file, never stdout.

## Usage (on the prod host)

```bash
# one-time (idempotent) — creates/repairs the sandbox org + user:
cd /home/node/docker-stack/aries-app && npx tsx scripts/qa/seed-qa-tenant.ts

# per QA session — mint a cookie file, import it into gstack /browse:
npx tsx scripts/qa/mint-qa-session.ts --out /tmp/qa-cookies.json --ttl-minutes 120
browse goto https://aries.sugarandleather.com   # visit site first (cookie domain check)
browse cookie-import /tmp/qa-cookies.json
browse goto https://aries.sugarandleather.com/dashboard
# → authenticated as the QA bot; a fresh sandbox tenant lands on /onboarding/start
```

Notes:
- Run the scripts from a checkout whose CWD has the prod `.env` (they use
  `dotenv/config`), or export `DB_*`, `NEXTAUTH_SECRET`, `APP_BASE_URL`
  explicitly. From outside the compose network use `DB_HOST=127.0.0.1`.
- Anything the QA bot does is tenant-isolated to `aries-qa-sandbox` (tenant id
  from the seed output). Feedback reports it files carry the
  `customer-aries-qa-sandbox` Jira label — close them with a QA-artifact
  comment when done.
- Revocation: delete the QA user row, or rotate `NEXTAUTH_SECRET` (kills all
  sessions app-wide), or just wait out the TTL.
