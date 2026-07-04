# Changelog

All notable changes to this project will be documented in this file.

## v0.1.25.0 — feat(tenant): multi-workspace phase 1 — membership-aware resolution (flag-gated, default OFF)

Phase 1 of the multi-workspace membership program
(docs/plans/2026-07-03-multi-workspace-membership.md). Forks the auth
resolution path behind `ARIES_MULTI_WORKSPACE_ENABLED` (default OFF — ships
dark; flag OFF is byte-identical to the single-pointer model, pinned by a
16-test golden suite captured against the pre-refactor code).

- Claims consolidation (eng findings 5/14, Phase-1 precondition): the
  triplicated users ⋈ organizations claims query (`findTenantClaimsByUserId`,
  `findTenantClaimsByEmail`, `loadTenantContextForUser`) now delegates to ONE
  helper — `resolveTenantClaimsRow` in `lib/auth-tenant-membership.ts` — so the
  membership join exists in exactly one place. Structural guard updated to its
  Phase-1 form.
- Flag ON resolution (Decisions 2/3, CEO hardening 4): ONE indexed query
  users ⋈ organization_memberships ⋈ organizations. The active-workspace
  pointer is honored ONLY when an ACTIVE membership backs it; the role comes
  from the MEMBERSHIP row (`users.role` becomes a legacy mirror — Risk 2
  cross-org escalation designed away); `workspace_count` rides the same
  statement via an indexed scalar subquery (no second aggregate — eng
  finding 13, `auth()` runs several times per render).
- Resolver self-heal (eng finding 1b): a pointer to an existing org with NO
  membership row inserts one `active` membership derived from pointer +
  `users.role` (valid tenant role required), `ON CONFLICT DO NOTHING` — never
  flips an `invited` row, never runs flag OFF, converges dark-period drift.
- Typed zero-membership state (Decision 7 / eng finding 9): resolves-like-NULL
  rows surface `TenantContextError('tenant_membership_missing')` → 403 with
  that reason on API routes via the existing mapping; `tenant_claims_incomplete`
  stays reserved for corrupt rows. `resolveTenantContextForSession` rethrows
  TenantContextError — stale session claims can never mask the state (the
  claims fallback remains for TRANSIENT DB errors only, both flag states).
- `ensureTenantAccessForUser` split (Decision 7): flag OFF byte-identical
  auto-provision; flag ON repoints a NULL/invalid pointer to the deterministic
  default (`last_active_at` DESC, else oldest) updating pointer + role mirror
  in one atomic statement (CEO hardening 3), and mints NOTHING at zero
  memberships — the orphan-workspace incident class dies at the source.
- jwt hydrate CLEARS stale tenant claims when membership resolution returns
  none (eng finding 8 — no ghost claims feeding the DB-outage fallback) and
  stamps `workspaceCount` from the same row; session exposes `workspaceCount`
  (`types/next-auth.d.ts` augment) so the shell can gate a switcher without an
  extra fetch.
- Zero-membership chooser (`/workspace/choose`, OUTSIDE the gated dashboard
  layout): invite-aware — pending `status='invited'` memberships render an
  "Accept invite" primary action (re-issues the caller's OWN invitation via the
  session-guarded resend path; tokens are stored hashed so the chooser cannot
  link the emailed token); an invite-less account gets "Create a workspace" +
  the waiting-for-an-invite explainer. `enforceOnboardingGate` and the
  post-login journey route the zero-membership state here (flag ON), so the
  org-minting onboarding resume page can never resurrect auto-provisioning.
  KNOWN Phase-1 limitation (pinned by test): the chooser Accept is a safe
  dead-end for a cross-org zero-membership invitee until Phase 2 re-scopes the
  resend gate to `membership.status` — it never mints a token it shouldn't.
- `users.role` lint gate (Risk 2 / eng finding 10, active Phase 1 onward):
  structural tripwire over runtime SQL touching the users table's role column;
  fails on any file outside the seeded 5-file allowlist AND when an allowlisted
  site stops matching (Phase 2/5 conversions must shrink it).
- QA sandbox (CEO hardening 10): `assertQaScoped` + `mint-qa-session.ts` resolve
  through the membership join with an EXACTLY-ONE-active-membership guard — the
  passwordless QA bot can never resolve or switch into a real tenant.
- Taste/Honcho hardening (plan verification section): synthetic performance
  contexts pass `userId:'system'` instead of tenantId-as-userId (pseudonym
  domain-separation pinned by test); system actors bypass membership checks by
  construction (Decision 10).
- Benchmark (guardrail #1, eng finding 13): flag ON vs OFF on the full
  endpoint — p50 +~1.3ms on a ~13ms authenticated endpoint, p99 within noise;
  query-level A/B (500 samples + EXPLAIN ANALYZE) confirms the single-join
  plan. No new pool fan-out (one statement replaces one statement).


## v0.1.24.0 — feat(tenant): multi-workspace phase 0.5 — absorb-orphan invite relief

Phase 0.5 of the multi-workspace membership program
(docs/plans/2026-07-03-multi-workspace-membership.md). Narrow, consent-gated
interim relief that ships UNFLAGGED (the one deliberate exception to the dark
rollout): productizes this year's manual-prod-SQL support class so an admin can
invite an email whose existing account sits in an ORPHAN workspace, instead of
the account being un-invitable (`email_taken`).

- Orphan predicate (`evaluateOrphanWorkspace`): the invitee's current workspace
  is sole-member (no other users row / membership row), never onboarded (no
  `business_profiles` row, invitee never completed onboarding), and zero
  activity (no posts / connected accounts / creative assets). One round-trip,
  no fan-out; fails CLOSED to today's `email_taken`.
- Invite path: when the other workspace is an orphan (and NOT a pending-sentinel
  account, which can't sign in), `inviteWorkspaceMember` mints an invitation for
  the existing account and the admin sees an "asked to fold their unused
  workspace in" success state. No membership in the inviting org until accept.
- Absorb-consent accept page: not-signed-in / wrong-account / consent / declined
  / workspace-in-use states; decline is a real action (expires the token);
  copy discloses that admins will see the invitee's name and email.
- `acceptAbsorbInvitation` — one transaction: lock the invitation + user rows
  `FOR UPDATE`, re-check the FULL orphan predicate INSIDE the txn (invite-time
  check is advisory; a workspace gone non-orphan terminates the token LOUDLY as
  workspace-in-use), verify a signed-in session that IS the invited account
  (user id + email; token possession alone never absorbs), repoint
  `users.organization_id` with the ADMIN-CHOSEN role (never the carried-over
  source `tenant_admin`) and NO password write, move the membership row in the
  same txn, write the `absorbed` audit event, consume every outstanding token.
  No entitlement/paywall check — absorb REPLACES a workspace, it does not add
  one (Decision 13c).
- Security fix folded in during review: the legacy public set-password accept
  route (`acceptWorkspaceInvitation`) is now pending-sentinel-only. It re-loads
  + locks the target user row inside its transaction and refuses (non-disclosing
  `invalid`, rollback) unless `password_hash` is still the `invited_pending`
  sentinel — so an absorb-type token (which points at an existing active
  account) can never be redirected to the session-less legacy route to overwrite
  that account's password. The two accept paths are mutually exclusive on the
  sentinel.
- `describeInvitationAcceptContext` resolves set_password vs absorb mode +
  disclosure context for the accept page without consuming the token; the
  validate route only ever echoes the caller's OWN session email back.
- Guard relaxation scoped to exactly the absorb read/move: the Phase-0
  no-membership-reads grep drops `workspace-invitations.ts` (now a legitimate
  membership writer); the tenant-resolution modules stay guarded.
- Adversarial + gate coverage: in-txn orphan re-check, no-password-write,
  admin-chosen-role-never-carried, consent-auth, decline-kills-the-token,
  idempotent double-accept, the cross-flow account-takeover regression (red
  pre-fix), and the inv-01b state-mutating-route auth-gate allowlist entry.
  Added to `npm run verify` (previously CI full-suite only).

## v0.1.23.0 — feat(tenant): multi-workspace phase 0 — dark membership schema, backfill, dual-writes

Phase 0 of the multi-workspace membership program
(docs/plans/2026-07-03-multi-workspace-membership.md). ADDITIVE and
zero-behavior-change: nothing reads the new tables/columns yet (structurally
tested); the membership seam ships dark so later phases can resolve
(active org, role) from a membership row instead of the single global
users.organization_id / users.role columns.

- New `organization_memberships` table (PK `(user_id, organization_id)`,
  `role` with NO default — every insert sets it explicitly, hot-path indexes
  on `user_id` and `(organization_id, status)`) + append-only
  `organization_membership_events` audit table, in init-db + migration.
- Entitlement columns (Decision 13): `users.plan` (default `'free'`) +
  `plan_granted_at` / `plan_granted_by`. Unread in Phase 0.
- Case-insensitive email uniqueness: `CREATE UNIQUE INDEX ON users
  (LOWER(email))` after a live prod dedupe audit (19 users, 0 case-variant
  duplicate groups, 0 mixed-case emails), plus normalize-on-write in the
  credentials signup action.
- Idempotent backfill (runs on every container start, `ON CONFLICT DO
  NOTHING`): one membership per user-with-org; `password_hash =
  'invited_pending'` sentinel maps to `status='invited'` so never-accepted
  invitees do not backfill as joined members; `last_active_at` /
  `accepted_at` derived from the matching invitation when present.
- Dual-writes in every legacy provisioning path (Google sign-in
  auto-provision + onboarding via the `assignUserToOrganization` chokepoint,
  credentials signup, invite `createTenantUserProfile` as `'invited'`,
  `acceptWorkspaceInvitation` flips to `'active'` inside the existing accept
  transaction) so the dark tables never drift from the pointer between
  backfill and flag-flip. QA seed/mint scripts upsert the QA bot's single
  membership and tolerate a pre-Phase-0 DB.
- Tests: mock-level dual-write coverage per path, a Phase-0 "no reads"
  structural guard, and a requires-infra live-Postgres backfill test
  (throwaway schema) with a drift guard pinning the test SQL to the shipped
  init-db source.

## v0.1.22.1 — fix(feedback): drive JIRA priority from severity (legacy feedback path)

The legacy public Feedback button's Jira sink now maps the classified severity
onto a real Jira priority (Blocker→Highest, High→High, Medium→Medium,
Low→Low) instead of letting every ticket default to Medium (AA-51 slice).
Hardened beyond the original draft: live createmeta showed AA's Task screens
carry the priority field but Bug/Story do NOT, so the sink now degrades like
the incident-report path — a create rejected over the priority field is
retried once without it and the rejection memoized, guaranteeing a screen or
scheme change can only ever cost the priority, never the ticket.

## v0.1.22.0 — feat(feedback): customer incident report button (SC-70 port, AA-51)

Port of the Sequence CRM SC-70 feedback/incident framework. Signed-in users
get an impact-first "Report an issue" dialog behind the existing floating
Feedback button (the legacy public form stays for anonymous visitors); reports
persist durably FIRST and then file a Jira **Bug** into project AA with a
server-mapped priority, sanitized labels, a contact block, and the optional
screenshot as a real Jira attachment.

- New auth-gated `POST /api/feedback/submit`: identity from the session only
  (body identity/tenant/priority fields are ignored), transactional per
  user+tenant rate limit (10/hr) + 60s duplicate window, persist-first commit
  before any Jira I/O, uniform `{submission_id, jira_ticket_key, status,
  screenshot_discarded}` 201/202 contract. A bad/oversized screenshot is
  discarded with a reason — it never sinks the report.
- New `feedback_reports` table (init-db + migration): status lifecycle
  `pending|synced|pending_retry|failed`, attempts counter, scrubbed
  `last_error`; screenshot bytes NULLed once synced.
- Jira delivery with idempotency: single create call-site behind a stored-key
  check + JQL search of the product-unique `aries-sub-<id>` label
  (search-before-create), token + basic-credential scrubbing BEFORE truncation,
  JQL label guard (`^[a-z0-9-]+$`, zero HTTP on reject), issue-key validation,
  15s timeouts. Impact→priority mapped server-side (P0 Crit Sit … P4
  Informational); AA's Bug screen has no priority field today, so a
  priority-field rejection degrades once per process and the impact always
  rides as an `impact-<pX>` label.
- New `aries-feedback-retry-worker` sidecar (compose + deploy force-recreate,
  parity green): atomic `FOR UPDATE SKIP LOCKED` claims, stale-`pending` crash
  recovery, attach-only completion, terminal `failed` exactly at max attempts.
  Default ON but inherently dormant without `JIRA_*` config — parked reports
  heal the moment config lands (dark-by-default boots clean).
- Dialog: impact question first (no default), screen capture via
  `getDisplayMedia` (file-picker fallback), 2 MB client cap from base64
  length, pinned `https://sugarandleather.atlassian.net/browse/<key>` success
  link, 429/network errors keep the dialog open with values intact,
  double-submit guarded.
- 79 new tests (invariant suite + live-Postgres `feedback_reports` store proof
  in a throwaway schema) wired into `npm run verify` and the requires-infra
  index.

## v0.1.21.1 — fix(marketing): surface a Publish button on weekly content

Weekly `weekly_social_content` jobs complete with `publishingRequested=false`
and take the publish-skip terminal path, which ingested rendered images into
`creative_assets` but never synthesized `posts`. The operator was left with
images, no captions/hashtags, and **no Publish/Approve control anywhere** (the
publish queue + review queue both read from synthesized posts) — the "generated
images but nowhere to click to publish" report. The copy was generated and
stranded in `production.primary_output.content_package`.

- New flag `ARIES_SYNTHESIZE_ON_PUBLISH_SKIP_ENABLED` (default OFF,
  `backend/marketing/synthesize-on-publish-skip-env.ts`). When ON, the
  publish-skip path also synthesizes the content_package into `approved` posts
  so the dashboard surfaces them with a manual "Publish now → Publish to
  Facebook Page" button.
- New `autoSchedule` option on `synthesizePublishPostsOnCompletion` is the
  safety contract: synthesize for REVIEW only, never auto-schedule/auto-publish,
  even with `ARIES_AUTO_APPROVE_MARKETING_PIPELINE` /
  `ARIES_AUTOSCHEDULE_ON_APPROVAL` on (both prod-on). The human still clicks.
- Onboarding variant-board jobs awaiting a pick are skipped so an unpicked
  variant never becomes a publishable post.
- When OFF (default) the publish-skip path is byte-identical to today. Regression
  test covers synthesis-on-ON (sensitive to the autoSchedule guard), variant-board
  skip, and flag-OFF no-op; wired into `npm run verify`.

## v0.1.21.0 — feat(video): choose reel audio — voiceover / music / both

Reels previously had no audio choice: a single deployment flag
(`ARIES_REEL_VOICEOVER_ENABLED`) only flipped between music-only (off) and
voiceover-over-music (on), with no per-tenant or per-job control. This adds a real
choice — **music**, **voiceover**, or **both** — surfaced as a per-tenant default in
Settings and an optional per-job override in the "Create weekly posts" form.

- `backend/marketing/reel-audio-mode.ts`: canonical `ReelAudioMode` plus two pure
  functions — `resolveReelAudioMode` (precedence: per-job override → per-tenant
  Settings default → global default `'music'`) and `resolveReelAudioComposition`
  (decides the ffmpeg audio graph; a `voiceover` choice degrades to the music bed,
  never a silent reel, when the capability is off / key absent / synthesis fails).
- `ARIES_REEL_VOICEOVER_ENABLED` is now a **capability gate** (permits voiceover),
  not a forcer; the resolved mode decides what each reel carries. Default flipped
  **ON** in `docker-compose.yml` — safe because the global default mode is `'music'`,
  so no reel's audio changes until a tenant opts in.
- Per-tenant default persisted in `business_profiles.reel_audio_mode` (init-db ALTER
  + migration), read at reel ingest via `loadTenantReelAudioModeOrNull`. Per-job
  override threads create-form select → payload → `doc.inputs.request.reelAudioMode`
  → ingest. Settings + create-form UI selectors added.
- Default mode `'music'` keeps reel output byte-identical until a tenant opts into
  voiceover. Reviewed via an adversarial multi-agent pass (1 confirmed finding fixed,
  4 refuted); 14 new tests; `npm run verify` green.

## v0.1.20.1 — fix(nav): surface the Settings page (team & member invites) in the sidebar account menu

The workspace member-invite UI shipped in v0.1.19.0 (#735) lives on `/dashboard/settings`
under the "Team / Approvals" panel, but the page was linked nowhere in the UI — the sidebar's
hand-curated `utilityItems` omitted the `settings` route and the account menu only linked
Business profile, Channel integrations, and Review queue. The page was reachable only by typing
the URL, so admins couldn't find where to add teammates.

- Adds a **"Team & settings"** link (→ `/dashboard/settings`, `Users` icon) to both the desktop
  and mobile bottom-left account menus in `components/redesign/layout/app-shell-client.tsx`,
  above "Business profile". No behavior change to any other nav entry.
- The destination page and its admin gating are unchanged; this only makes the existing
  member-management UI discoverable.

## v0.1.20.0 — feat(feedback): mirror the feedback button to JIRA instead of Google Sheets

Rewires the in-app feedback button so each submission is filed as a JIRA issue
(project AA, "Aries AI") via the direct JIRA REST API, replacing the Composio →
Google Sheet mirror. Everything now lands in JIRA for tracking. The capture path
and durable DB persistence are unchanged — only the external mirror destination
swapped, and it stays pluggable.

- **Pluggable sink dispatcher** (`lib/feedback/feedback-sink.ts::syncFeedback`):
  prefers JIRA when configured, falls back to the Google Sheet, then to
  durable-DB-only (`sheet_sync_status='skipped'`). The route calls one entry point.
- **Direct JIRA REST mirror** (`lib/feedback/jira-sink.ts`): `POST /rest/api/3/issue`
  with HTTP Basic auth (`JIRA_EMAIL:JIRA_API_TOKEN`). The token is read from config
  and never logged or placed in an error string. 10s timeout; never throws (a failed
  mirror is retryable, the durable row already saved). Project AA is team-managed
  with only Epic/Sub-task/Task, so every submission is created as the configured
  issue type (default **Task**), with category + severity carried in the summary,
  labels (`aries-feedback`, `cat-*`, `sev-*`, `env-*`, `auth-*`), and an ADF body
  (comment + metadata bullets + console-errors code block). Page URL + screenshot
  render as links.
- **Issue-key traceability:** the created key (e.g. `AA-123`) is stored on
  `feedback_submissions.jira_issue_key` and returned in the API response. Migration
  `20260626000000_feedback_jira_issue_key.sql` + `init-db.js` (ALTER … ADD COLUMN
  IF NOT EXISTS so existing DBs pick it up — the inline CREATE-IF-NOT-EXISTS no-op
  trap).
- **Config** (`resolveFeedbackConfig`): `JIRA_BASE_URL`, `JIRA_EMAIL`,
  `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY`, `JIRA_FEEDBACK_ISSUE_TYPE` (default Task).
  The mirror activates only when all four required vars are set; never invents a
  project/token. Wired into the `aries-app` service env block + `.env.example`
  (token is host-`.env`-only, never committed).
- Verified live end-to-end against the real AA project (issue created + deleted);
  18 new unit tests for the JIRA sink (labels, ADF validity / no empty text nodes,
  summary bounds, auth header never leaks the token, dispatcher precedence, config
  gating). `npm run verify` green.

## v0.1.19.0 — feat(workspace): email-invite workspace membership + member management UI

Lets a tenant admin add teammates to the workspace so multiple people can view and
change the posting schedule. The `users` ↔ `organizations` schema already supported
many users per workspace and the admin-only member CRUD already existed
(`/api/tenant/profiles`); the gaps were a way to invite from the dashboard and a
login path for an invited person. This closes both with a standard email-invite flow.

- **Invite + member management UI** (`frontend/aries-v1/settings-screen.tsx`, Settings →
  Team / Approvals): an admin-only "Invite teammate" form (email + role), a per-member
  role dropdown, Resend invite, and a two-click Remove. Members show an **Active / Invited**
  status badge. Non-admins see a read-only roster. Role → schedule access: Admin and
  **Editor** (`tenant_analyst`) can change the schedule; **Viewer** is read-only. The
  invite form defaults to Editor.
- **Invitation tokens** (`backend/tenant/workspace-invitations.ts`, new
  `workspace_invitations` table): a 256-bit token is stored sha256-hashed at rest,
  single-use, 7-day expiry — modeled on `password_resets`. Issuing a new invite
  supersedes the user's prior live tokens, and accepting consumes every outstanding
  token for that user, so a stale link can never re-set a password.
- **Accept flow:** `POST /api/tenant/profiles` now creates the pending user, mints a
  token, and emails a "set your password" link (`sendWorkspaceInviteEmail`, via Resend);
  `POST /api/tenant/profiles/[userId]/resend-invite` re-issues it. The invitee lands on
  `/invite/accept?token=…`, sets a password (`POST /api/auth/invite/accept`), and signs
  in. `GET /api/auth/invite/validate` backs the page without consuming the token. Both
  public routes are token-authenticated and collapse all token-state failures to one
  message (no enumeration); the accept route is allowlisted in the route auth-gate
  invariant alongside the other pre-session auth routes.
- **Tenant isolation:** invite/resend/remove/role-change are `tenant_admin`-gated and
  route through the existing tenant-scoped helpers; a cross-org email is refused
  (`email_taken`) and an already-active member is refused (`already_member`).
- **Email config:** invites use the same `RESEND_API_KEY` + verified `EMAIL_FROM` domain
  as password reset. Unset → the invitation + token are still created but no mail is sent
  (logged at ERROR in prod), so configure Resend before relying on this in production.
- Migration `migrations/20260625000000_workspace_invitations.sql` (+ `scripts/init-db.js`,
  applied on container start). New unit tests cover the token lifecycle: create / accept /
  expire / reuse / cross-tenant / supersession. `npm run verify` + `validate:social-content`
  green; no `aries-hermes-protocol` change.

## v0.1.18.0 — feat(marketing): image-edit (image-to-image) API for creatives, flag-gated

Adds an Aries-owned image-edit path so an operator can change an existing creative
with a natural-language instruction instead of regenerating from scratch. Behind
`ARIES_IMAGE_EDIT_ENABLED` (default OFF): the route 404s and the review drawer's
"Edit this image" section is hidden, byte-identical to the route not existing.

- **New route:** `POST /api/social-content/jobs/[jobId]/creatives/[creativeId]/edit`.
  An edit instruction is routed to Hermes as a new `aries_run` reusing the regenerate
  submission path (per-stage profile pipeline scoped by `regenerate_creative`), but
  carrying an `edit_instruction` plus the source image's Hermes-cache basename so the
  content-generator profile calls `image_generate` on that existing image (its
  image-to-image edit endpoint) instead of generating fresh. An explicit "IMAGE EDIT
  EXECUTION CONTRACT" in the submission prompt pins the agent to the edit tool.
- **Source resolution:** `editCreativeAsImageEdit` resolves the basename from
  `creative_assets.storage_key` for `runtime_asset` rows only (tenant- and job-scoped
  SQL, path-traversal + bad-tenant guards); `ingested_asset` rows resolve to null and
  Hermes falls back to locating the source via `source_run_id` + `source_creative_id`.
  Resolution is fail-open (any DB/parse error → null → still submits, with a warn log).
- **Injection-safe:** every operator-controlled value embedded in the prompt contract
  (`source_creative_id`, `source_run_id`, `edit_instruction`) is JSON-encoded; an
  explicit body `source_run_id` is validated against the job's own stage run ids.
- **Protocol:** additive optional `regenerate_creative.edit_instruction` +
  `source_image_basename` (`PROTOCOL_VERSION` 1.1.1 → 1.2.0; older consumers strip the
  fields and degrade to a plain regenerate). No Hermes-repo change.
- The edited image lands as a NEW `creative_assets` row (original preserved), exactly
  like regenerate. Tenant-isolated, flag-gated taste signal on edit.
- Wired into the `aries-app` `environment:` block in `docker-compose.yml`. Process-wide;
  default OFF. **Screenshot-verify a freshly edited + published post on a live tenant
  before flipping the flag** — the open question is whether the content-generator
  reliably honors the edit contract; if it ever ignores the source it degrades to a
  regenerate.

## v0.1.17.0 — feat(feedback): infer severity (drop the dropdown) + wire Composio env into the container

Follow-ups to the feedback button (v0.1.16.0):

- **Severity is now inferred, not asked.** The Severity dropdown is removed from
  the form — users found it confusing. The server classifies severity (Low/Medium/
  High/Blocker) from the comment + category via a short, bounded Hermes call
  (`lib/feedback/severity-classifier.ts`), with a deterministic category/keyword
  heuristic fallback when Hermes is disabled, slow, or errors. It never blocks long
  or fails a submission. Rate-limiting runs BEFORE the LLM call so spam can't
  trigger classification runs. Knobs: `FEEDBACK_SEVERITY_LLM_ENABLED` (default on
  when Hermes is configured), `FEEDBACK_SEVERITY_TIMEOUT_MS` (default 6000),
  `HERMES_SEVERITY_SESSION_KEY`.
- **docker-compose env passthrough.** The app container gets env only via explicit
  `${VAR}` interpolation (no `env_file`), so the feedback Composio/Sheet vars now
  appear in the app service `environment:` block — without this the deployed
  container never saw them even when set in the host `.env`. `FEEDBACK_ENABLED`
  defaults to `true` in compose (an empty value would otherwise read as falsey and
  hide the button); `resolveFeedbackConfig` also treats an empty string as unset.

## v0.1.16.0 — feat(feedback): in-app feedback button on every page

A persistent floating feedback button on every page (including the login/auth
screens) lets any user — authenticated or not — file a comment with category and
severity and an optional screenshot. Each submission is captured durably and
mirrored as one row into a centralized Google Sheet via Composio, so issues are
tracked in one place with the context needed to triage them. Built because users
reported login/post-creation problems with no structured way to report them
(Aries Dev Meeting, 2026-06-19).

- **Floating widget** mounted once in the root layout, so it appears on every
  route and works for unauthenticated users (tenant recorded as `unauthenticated`).
  Accessible modal: focus trap + restore, Escape, reduced-motion, scrollable on
  short viewports; comment (required) + category + severity + optional screenshot.
- **Silent context capture**: tenant id (or `unauthenticated`), page URL (secrets
  redacted), auth state, browser/UA, viewport, recent console errors (secrets
  redacted), screenshot, timestamp, environment, and a unique submission id.
- **Durable-first delivery** (`POST /api/feedback`, public): persists to the new
  `feedback_submissions` table first, then mirrors to Google Sheets via the
  existing Composio seam (`GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND`). Idempotent
  by submission id; a failed mirror is surfaced as retryable and never drops input.
- **Resilient + safe**: per-origin rate limit (fails closed), request-size guard,
  identity columns written once (no cross-origin tamper), unguessable screenshot
  token. The Sheet mirror is gated behind `COMPOSIO_ENABLED` + the feedback vars;
  with them unset, submissions still persist with `sheet_sync_status='skipped'`.
- **Setup**: `npm run setup:feedback-sheet` connects a Google account to Composio
  and provisions the destination sheet + header, printing the env block.

## v0.1.15.27 — feat(slack): outbound approval notifications (Phase 4 PR2, default OFF)

Slack Phase 4 PR2: the marketing pipeline now posts a "needs approval" message to a
Slack channel when a job pauses at a gate that a human must act on, so operators stop
polling the dashboard for what's waiting on them. Builds on PR1's inbound webhook
plumbing; the inbound approve-from-Slack flow stays deferred to a later PR.

- **New outbound surface** behind `ARIES_SLACK_NOTIFICATIONS_ENABLED` (default OFF). When on,
  a Block Kit message with a "Review in Aries" deep link (`/social-content/review?jobId=…`)
  is posted at the single `requires_approval` checkpoint in
  `backend/marketing/hermes-callbacks.ts`. The destination channel resolves **per tenant**
  (tenant-scoped Slack OAuth connection + stored channel config); `SLACK_BOT_TOKEN` (needs
  `chat:write`) + `SLACK_SINGLE_TENANT_CHANNEL` is the explicit single-tenant opt-in
  fallback — there is no shared global channel across tenants (the earlier
  `SLACK_NOTIFY_CHANNEL` global path was removed before merge and is never read).
- **Fires only for a real human gate** — after `maybeAutoApproveMarketingCheckpoint` has its
  turn (gate: stage status `awaiting_approval`), and suppressed for a variant-board job
  awaiting its pick. Auto-approved gates are never announced.
- **Best-effort + non-fatal**: the client never throws and the call is fire-and-forget, so a
  Slack outage can't break callback idempotency. The untrusted Hermes prompt is escaped for
  Slack mrkdwn and length-capped.
- **Deduped on delivery** via the `slack_notifications` table keyed on the stable
  `approval:<jobId>:<stage>` (NOT the per-delivery approval id), recorded only after a
  successful post so a failed/crashed send is retried by the reconciler instead of dropped.
- When OFF (default), the callback path is byte-identical to today: no DB write, no Slack call.
- Tests: 16 covering the message builder (escaping/truncation), the client (success/HTTP
  error/`ok:false`/timeout), and the dispatcher (flag/channel/dedup/post-failure).

## v0.1.15.26 — fix(ci): deploy now rolls ALL worker sidecars onto the new image

Closes the deploy gap behind the 2026-06-09 incident where
`aries-insights-sync-worker` silently ran a 6-day-stale image: the Deploy
workflow force-recreated only 4 of the 6 docker-compose services, so the two
omitted workers kept running the previous image across every deploy (their
`restart: unless-stopped` containers are never re-pulled). The manual fix from
that incident would have regressed on the very next deploy.

### Fixed
- **Deploy recreates every sidecar** — `.github/workflows/deploy.yml` now
  force-recreates `aries-insights-sync-worker` and
  `aries-honcho-performance-worker` after the app health check, with the same
  pinned `ARIES_APP_IMAGE="${TARGET_IMAGE}"` + non-fatal pattern as the other
  three workers.

### Added
- **Post-deploy worker verification** — after the recreate sequence, the deploy
  iterates `docker compose config --services` (so the list can never drift from
  docker-compose.yml) and checks each sidecar has a running container on the
  target image ID. Mismatches stay non-fatal (workers are best-effort relative
  to the app) but are now loud: GitHub `::warning::` annotations + step-summary
  lines instead of a single unread stderr echo. A swallowed
  `stop → rm → create` failure previously could leave a worker stale or absent
  with a green deploy.
- **Compose/deploy parity guard** — new test in
  `tests/deploy-manifest-parity.test.ts` asserting every docker-compose.yml
  service has an uncommented, image-pinned force-recreate line in deploy.yml
  (and no recreate line targets a removed/renamed service), so the next new
  worker can't be forgotten. Hardened against false-passes: commented-out
  lines, `echo`-quoted command text, missing image pin, comment dividers and
  trailing comments in compose, and dotted service names are all covered;
  verified against the pre-fix workflow (fails naming both missing workers).
  Runs in `npm run verify` too, since the agent-automerge deploy path gates on
  verify alone.
## v0.1.15.25 — fix(insights): sweep sync runs stranded in 'running' by worker restarts

### Fixed
- **Sync-run history can no longer show a sync as running forever.** The
  dispatcher opens every `insights_sync_runs` row as `status='running'` and
  only flips it to ok/failed at the end of a long multi-fetch sequence, while
  the worker's shutdown ends the pool without awaiting an in-flight tick — so
  a SIGTERM mid-tick (docker compose stop → 10s grace → SIGKILL) stranded the
  row in `'running'` permanently; no reaper covers this table, and deploys
  that force-recreate the sidecars would have made it routine. The worker now
  sweeps stranded rows at the top of every tick (the first tick fires at
  startup): rows stuck in `'running'` past a grace window are closed out as
  `status='failed'` with `error_message='aborted by worker restart'`. Sweep
  failures are isolated — they log `insights_sync_sweep_failed` and never
  cost tenants their sync window.
- **A sync swept mid-flight that then completes ends clean.** The
  dispatcher's terminal ok UPDATE now clears `error_message`, so a swept-then-
  completed run can't end as `status='ok'` still carrying the abort message
  (review finding; would have corrupted any future sync-health view).

### Added
- `ARIES_INSIGHTS_SWEEP_GRACE_MINUTES` (default 60) — the grace window before
  a `'running'` row counts as stranded; widen it before shipping any sync path
  that can legitimately run long (e.g. a backfill). Fail-safe parsing; wired
  through docker-compose and `.env.example`.
- Partial index `idx_insights_sync_runs_running_started` (init-db +
  `migrations/20260610000000`) so the half-hourly sweep never seq-scans the
  append-only audit table; near-empty since `'running'` rows are transient.
- Tests on three layers: in-memory contract tests
  (`tests/insights-sync-worker-stranded-runs.test.ts`, in `npm run verify`)
  covering the SQL shape, sweep-before-fan-out ordering, failure isolation,
  guard release, and the NDJSON log-event contract; a live-schema
  requires-infra test (`tests/insights-sync-runs-sweep.requires-infra.test.ts`,
  rolled back) proving the predicate flips only stale `'running'` rows and the
  terminal-ok override wins; and the sweep SQL validated against the prod
  schema in a rolled-back transaction before shipping.

### Changed
- Sweep logic lives in `backend/insights/sync/sweep-stranded-runs.ts` per the
  repo's worker/backend split (the worker script stays loop + config +
  logging); the grace window is a query parameter, not an embedded literal.
## v0.1.15.24 — fix(db): DB_POOL_MAX is honored as written everywhere — 2026-06-10

### Fixed
- **`DB_POOL_MAX` now means what it says, on every process.** Two gaps made the
  connection-budget math unreadable from `docker-compose.yml`: (1) the shared
  pool's parser clamped every explicit value to a floor of 5, so the
  insights-sync sidecar's configured `3` silently ran a pool of 5; and (2) the
  other four sidecar workers hardcoded `max: 3` and ignored the env var
  entirely. All five sidecar pools now parse `DB_POOL_MAX` through one shared
  helper (`lib/db-pool-config.ts`) with a worker default of 3, and explicit
  values are honored from 1 up to the 200 cap.
- **Malformed pool sizes can no longer under-provision production.** The parser
  is now strict-integer: values like `1e2` (previously parsed as `1` — a
  one-connection web pool) or `3garbage` fall back to the caller's default with
  a loud warning instead of being silently truncated (cross-model adversarial
  finding, Claude + Codex).

### Changed
- Connection-budget docs (`DOCKER.md`, `CLAUDE.md` guardrail #1) now state the
  full per-container math, including the Hermes reconciler child's pinned pool
  of 5 (`scripts/start-runtime.mjs`) and the honcho worker's potential second
  (shared) pool, and warn against tiny `DB_POOL_MAX` values on the web app.

### Added
- Bounds tests for `parsePoolMax` (floor/cap/strict-parse/fallback) and a new
  `tests/worker-pool-config.test.ts` asserting every sidecar worker's pool
  honors `DB_POOL_MAX` and defaults to 3.

## v0.1.15.23 — fix(insights): un-wedge the insights-sync worker after a failed tick

(v0.1.15.21 and v0.1.15.22 are claimed by in-flight PRs #579 and #580.)

### Fixed
- **Insights syncing recovers on its own after a startup race.** The
  `aries-insights-sync-worker` sidecar set its overlap guard (`ticking = true`)
  before an unprotected `await pool.connect()`. If the first tick fired while
  Postgres was still starting (`ECONNREFUSED`), the error escaped to a log-only
  `.catch`, the guard was never reset, and every subsequent tick for the life of
  the container logged `insights_sync_skip: previous_tick_still_running` —
  analytics silently stopped syncing (prod was wedged this way from
  2026-06-09T20:14Z). The tick body now runs in `try/catch/finally` (the same
  shape the other sidecar workers use), so any tick failure logs
  `insights_sync_fatal` and releases the guard for the next interval.
- **One bad tenant no longer starves the rest.** A tenant whose sync throws
  (its own DB connect, the account-list query, an adapter bug) is logged as
  `insights_sync_tenant_failed` and skipped; the remaining tenants still sync
  in the same tick instead of waiting 30 minutes.
- **Worker error logs now carry stack traces** instead of `String(err)`
  one-liners.

### Added
- Regression tests (`tests/insights-sync-worker-tick-reset.test.ts`) covering
  guard release on connect failure, query failure, and per-tenant sync failure,
  plus the legitimate-overlap skip. Oracle-checked: the suite fails against the
  pre-fix code. Registered in `npm run verify` so the canonical pre-push gate
  exercises it.

### Changed
- `insights-sync-worker.ts` is now importable without auto-starting (direct-run
  guard, matching the sibling workers), with the pool and per-tenant sync
  injectable for tests. Log event names and payloads are unchanged, except
  `insights_sync_done` gains a `tenantsFailed` count.

Deploy note: until PR #580 (deploy recreates all sidecars) lands, the
`aries-insights-sync-worker` container must be force-recreated manually once
after this deploy to pick up the fix.

## v0.1.15.20 — feat(marketing): brand taste-learning loop (tenant-scoped, default OFF)

PR2 of the brand-learning track (PR1 was the logo composite, v0.1.15.19). A
taste-learning loop for the **userless weekly run**: operator edits in the
review tray (approve / reject / regenerate / delete) teach a **tenant-scoped**
taste profile on the brand's visual-style lens, which is then folded back into
the next weekly production brief. Behind **two independent default-OFF flags**,
so the shipped default is byte-identical to today.

- **Tenant-scoped taste store** (`backend/marketing/taste-profile-store.ts`) —
  a new `applyTenantTasteSignal` / `getTasteForTenant` / `loadTasteForBriefByTenant`
  path keyed on the `user_id IS NULL` row (the tenant aggregate the weekly run
  biases against, no cross-user merge). The existing onboarding per-user
  `applyTasteSignal` is left byte-identical.
- **Schema migration** (`migrations/20260609000000_marketing_taste_tenant_scoped.sql`
  + mirrored idempotent ALTERs in `scripts/init-db.js`) — drops the
  `(tenant_id,user_id)` PK and re-establishes uniqueness with **two indexes**:
  `(tenant_id,user_id)` keeps onboarding's `ON CONFLICT` working, and the partial
  `(tenant_id) WHERE user_id IS NULL` is the inference target for the weekly
  upsert. Also stamps a generation-time `style_dimension`/`style_value` lens on
  synthesized `posts`. Additive + idempotent; proven against real Postgres 16.
- **Brief read path** (`ARIES_TASTE_BRIEF_INJECTION_ENABLED`, default OFF) — the
  decayed tenant taste is preloaded in the Hermes port and merged into the
  production brand block (style, voice, must-avoid, audience). Append-only +
  no-op on empty, so a null/empty projection or flag-OFF leaves the prompt
  byte-identical (golden-tested).
- **Edit producers** (`ARIES_POST_EDIT_TASTE_LEARNING_ENABLED`, default OFF) —
  review-decision, regenerate, and delete hooks write a tenant taste signal on
  the visual-style lens. Every producer is flag-gated, best-effort, and
  never throws, so a taste-write failure can never break the operator action.
- **Review-driven hardening** — the per-creative review-decision call site's
  double-count guard (creative items WITH an `assetId` teach taste; publish-
  preview launch-gate items, which also carry `reviewType: 'creative'` but no
  `assetId`, are skipped) is extracted into a pure, unit-tested
  `creativeReviewTasteOutcome` helper so that author-flagged correctness branch
  has explicit coverage.

Ships fully dormant; flip the flags only after the schema migration is applied
and a freshly generated weekly brief is screenshot-verified on a live tenant.

## v0.1.15.19 — fix(insights): backfill insights_comments.is_replied so Sections 7/1/3/5 don't 500

PR #561 added the `is_replied` column **inline inside** `CREATE TABLE IF NOT
EXISTS insights_comments`. But that table predates #561 on every existing
database, so `CREATE TABLE IF NOT EXISTS` is a no-op there and the column never
landed — confirmed absent from the live prod DB. Four insights builders read
`c.is_replied` (conversations Sec 7, narrative Sec 1, attention Sec 3, trends
Sec 5) and would throw `column "is_replied" does not exist` (HTTP 500) the moment
any tenant has comment rows. It stayed silent only because `insights_comments` is
empty in prod today.

- **Idempotent `ALTER TABLE` in `scripts/init-db.js`** — added
  `ALTER TABLE insights_comments ADD COLUMN IF NOT EXISTS is_replied BOOLEAN NOT
  NULL DEFAULT false` next to the `content_type`/`aries_post_id` ALTERs that *did*
  land, so existing tables backfill on container start (an inline
  CREATE-TABLE-IF-NOT-EXISTS column alone cannot widen an existing table). The
  inline declaration is kept too, so fresh installs and existing DBs converge.
- **Migration record** — `migrations/20260609000000_insights_comments_is_replied.sql`.
- **Applied to the live prod DB** on 2026-06-09 (additive, idempotent, instant on
  the empty table); the previously-failing conversations meta query now runs.

## v0.1.15.18 — feat(marketing): draft-expiry sweep for stranded pre-publish posts (default OFF)

A standing sweep that expires STRANDED pre-publish posts so the
unscheduled-approved backlog stops growing without bound once the weekly trigger
fans out across tenants (the "36 stranded approved IG posts" symptom). It is the
DB-row complement of the stale-run reaper, which reaps stranded job docs on disk.
Flag-gated and **default OFF** — ships dormant.

- **New worker `aries-draft-expiry-sweep-worker`** (gated by
  `ARIES_DRAFT_EXPIRY_ENABLED`, default OFF). Every tick it expires posts that
  never reached the publish queue (no `scheduled_posts` row), never went live
  (`published_at IS NULL`), never reached Meta (`platform_post_id IS NULL`), are
  in a `draft`/`in_review`/`approved` `published_status`, and are older than the
  age window (`ARIES_DRAFT_EXPIRY_AGE_DAYS`, default 14 days) — by setting
  `published_status='expired'`. This removes them from the operator's
  approval/backlog trays **without publishing stale content**. Idempotent,
  batched, and read-only in dry-run (`ARIES_DRAFT_EXPIRY_DRY_RUN=1`) so an
  operator can observe one cycle before committing.
- **Keys on the canonical `published_status`, not the legacy `status` mirror**
  (which defaults to `'draft'` on Meta-native-scheduled posts), and guards on
  `platform_post_id IS NULL`, so a post that is scheduled or live on Meta is
  never expired.
- Adds the `'expired'` value to the `posts` `published_status`/`status` CHECK
  constraints, an `expired_at` audit column, and a partial index for the sweep's
  candidate scan (applied on container start via `init-db.js` + a `migrations/`
  record).
- Sidecar is force-recreated each deploy (idles cleanly when the flag is off).

## v0.1.15.17 — fix(ops): weekly-trigger worker idles when disabled + deploy recreates it

Two rollout-readiness fixes for the weekly-trigger worker shipped in v0.1.15.16
(both were dormant, so no prior prod impact):

- **Idle instead of exit when disabled.** `aries-weekly-trigger-worker` ran as a
  `restart: unless-stopped` compose service but called `process.exit(0)` when
  `ARIES_WEEKLY_TRIGGER_ENABLED` was off — which makes Docker restart-loop the
  container. It now idles (stays cleanly "up", does no work, still responds to
  `docker stop`) when the flag is off, and only runs the tick loop when enabled.
  A one-shot invocation (`ARIES_WEEKLY_TRIGGER_RUN_ONCE=1`) still exits cleanly
  rather than hanging.
- **Deploy recreates the worker.** `deploy.yml` force-recreated only `aries-app`
  and `aries-scheduled-posts-worker`, so the new worker never picked up fresh
  images (it imports backend code and must stay in lockstep with the app). The
  deploy now also recreates `aries-weekly-trigger-worker` (non-fatal, same as the
  other sidecar); safe whether or not the flag is set, since it idles when off.

## v0.1.15.16 — feat(marketing): weekly social-content automation (human-in-the-loop, both platforms)

Generate weekly content on a cadence, have a human review and approve it, and have
it auto-post to both Instagram and Facebook — without the unsafe
`ARIES_AUTO_APPROVE_MARKETING_PIPELINE` flag (which bypasses human review entirely).
Two pieces, both flag-gated and **default OFF**, plus a reaper fix that makes
human-in-the-loop viable.

**Piece A — auto-schedule on approval** (`ARIES_AUTOSCHEDULE_ON_APPROVAL`, default
OFF). Previously a job's approved posts only auto-scheduled when the no-review
autonomous flag was on; with approval-gating on (the safe prod setting) approved
posts stranded (36 stranded IG posts observed on tenant 15). Now, once a **human**
approves the publish gate, the week's posts auto-schedule across both platforms. The
hook is one guard at the single completion convergence point
(`synthesizePublishPostsOnCompletion`), so it is correct for human-approve,
auto-approve, multi-stage, and reconciler-delivered completions, fires once per
terminal callback, and is idempotent on re-delivery (`upsertScheduledPost ON
CONFLICT(post_id)`).

**Piece B — weekly trigger worker** (`ARIES_WEEKLY_TRIGGER_ENABLED`, default OFF). A
new single-replica docker-compose service (`aries-weekly-trigger-worker`) starts a
`weekly_social_content` job for each opted-in tenant on its configured day/hour/
timezone. Dedup is an atomic conditional-claim `UPDATE` on the new
`marketing_schedule` table — safe across concurrent ticks and multiple containers.
Timezone math is DST-aware (clamps the cadence slot to never resolve into the
future during the fall-back ambiguous hour, which would otherwise re-fire every
tick). A failed submit is loud and reverts the claim so the week is retried, not
lost; a server-side idempotency guard collapses a re-fire after a lost HTTP response
onto the existing job instead of duplicating it. Viability gates skip (with a
surfaced reason, not a silent drop) when the tenant has no connected Meta account,
a stale/unenriched brand kit, or an incomplete profile. Job start is delegated to a
new internal route (`/api/internal/marketing/weekly-trigger`, `INTERNAL_API_SECRET`
auth). Cadence is managed with a validated CLI
(`scripts/marketing/upsert-marketing-schedule.ts`) that preserves omitted fields on a
partial edit instead of resetting a customer's whole cadence — no raw SQL required.

**Reaper companion** (`ARIES_REAPER_AWAITING_APPROVAL_THRESHOLD_MS`, default 7d). The
stale-run reaper was reaping jobs that were correctly *waiting for a human* at the
5-minute strategy threshold, which broke the approval flow. Jobs paused at an
approval gate now get a long (7-day) window before being reaped, with a loud log;
they are still reaped eventually so a genuinely wedged gate is caught. An explicit
force-reap override (CLI `--threshold-ms` or the `STALE_RUN_REAPER_THRESHOLD_MS` env
var) still wins.

The publish back-half (`scheduled-posts-worker` → `/scheduled-dispatch`) is unchanged
and already publishes to both platforms; this change fills the queue safely and
triggers the weekly job. The new table ships in `scripts/init-db.js` (applied on
container start) plus `migrations/` for record. All four pieces were adversarially
reviewed (multi-agent) before merge; the review's four confirmed findings
(seed-CLI partial-edit clobber, DST future-slot duplicate trigger, env-override
force-reap gap, lost-response duplicate job) are fixed and covered by tests.

## v0.1.15.14 — fix(publishing): job-scope the creative_asset_ids ordinal match so Instagram posts the right single image

Follow-up to v0.1.15.13. With `served_asset_ref` fixed, posts could resolve media
again — but `resolveMediaUrls` (`scheduled-dispatch/route.ts`) matched
`creative_asset_ids` ordinals (`img_1`, `img_2`, ...) against `creative_assets`
**without scoping to the post's job**. Because `synthesize-publish-posts.ts` writes
the ordinal form by default and every job reuses `img_1`/`img_2`/..., an ordinal-form
post matched the same-ordinal asset of *every* job for the tenant. `resolveMediaUrls`
returned several cross-campaign images and Instagram published a wrong multi-image
**carousel** (`createInstagramContainer` treats >1 url as a carousel). Measured on the
prod DB: tenant-15 posts resolved 4-5 mixed-campaign images each instead of 1.

Fix: scope the ordinal branch to `ca.source_job_id = p.job_id`. The uuid branch
(`ca.id`) stays unscoped since uuids are globally unique. Each ordinal-form post now
resolves to exactly its own job's single image (verified on the prod DB: 7 tenant-15
posts went from 4-5 images each to exactly 1). Added a cross-job collision regression
test to `scheduled-dispatch-media-resolution.test.ts`.

## v0.1.15.13 — fix(marketing): served_asset_ref left NULL by data-modifying CTE broke all Instagram publishing

Instagram published nothing since May 22. Root cause: PR #517 (commit 6786955)
rewrote the `creative_assets` ingest INSERT as a data-modifying CTE —
`WITH ins AS (INSERT ... RETURNING id) UPDATE creative_assets SET
served_asset_ref=... FROM ins WHERE id=ins.id`. Postgres evaluates the outer
UPDATE against a snapshot taken BEFORE the CTE's INSERT, so it matches 0 rows and
`served_asset_ref` stays NULL (verified on the prod DB: `UPDATE 0`). With a NULL
ref, `resolveMediaUrls` returns `[]` and Instagram — which hard-requires a public
image URL — fails every publish with the terminal `instagram_media_required`.
Facebook masked it by publishing text-only, so only Instagram went dark.

The same broken CTE existed in the operator-upload path (`upload-replace.ts`).
`story-composer.ts` already documented this exact Postgres-snapshot bug and the
fix; this applies it to both sibling sites: a single self-referential
`INSERT ... SELECT g.id, ..., '/api/internal/hermes/media/' || g.id::text
FROM (SELECT gen_random_uuid() AS id) g` that builds the ref atomically from the
row's own id. ON CONFLICT idempotency and the partial-unique-index semantics are
preserved. Added a `served_asset_ref` non-NULL assertion to the live-DB ingest
test — the prior test ran the real INSERT but never checked the ref, which is how
the regression slipped CI. Validated end-to-end against real Postgres.

## v0.1.15.12 — fix: Composio factory static import (require() broke every Composio request in prod)

Hotfix. With Composio enabled in prod, every Composio API call 500'd with
`TypeError: ...createComposioAccountProvider is not a function` — so `/connections`
showed "Unexpected end of JSON input" and Connect/list/capabilities all failed.
Cause: `provider-factory.ts` loaded the adapter via `require('../composio')`, and
under Turbopack's production build that require returned a module object WITHOUT
the named exports. Fixed by statically `import`ing the create* factories. Safe:
the heavy `@composio/core` SDK is still loaded lazily (`await import`) inside the
gateway; providers are still only constructed when selected. Caught only by a real
`next build` + live request (typecheck + unit tests passed), so verified by build +
post-deploy live check.

## v0.1.15.11 — Composio connect: auto-provision a managed auth config (no dashboard setup)

Removes the manual "create an auth config + paste the ac_ id" step. When no
`COMPOSIO_<PLATFORM>_AUTH_CONFIG_ID` / `COMPOSIO_DEFAULT_AUTH_CONFIG_ID` is set,
`createConnectLink` now calls the gateway's `findOrCreateManagedAuthConfig(toolkit)`
— it lists existing Composio-managed auth configs for the toolkit
(`authConfigs.list({ toolkit, isComposioManaged: true })`) and reuses one, else
creates a managed config (`authConfigs.create(TOOLKIT, { type: 'use_composio_managed_auth' })`)
and returns its `ac_...`. So connecting works with just `COMPOSIO_API_KEY` +
`COMPOSIO_ENABLED=true`. An explicit env auth-config id still takes precedence
(needed for Meta Ads / custom auth). Validated against the real SDK types; 40
tests pass. Still default OFF.

## v0.1.15.10 — Make the dark-background brief instruction a hard constraint (the agent was overriding the soft version)

Follow-up to v0.1.15.5/6/7. With the brief correctly emitting a dark theme line,
a live render still came out on a **light/white background**: the Hermes
content-generator agent ignored the soft advisory ("Render on a dark
background…") and wrote `visual_prompt`s like "bright minimal SaaS studio… soft
white background" (confirmed via the actual `content_package[].visual_prompt`).

Root cause confirmed by isolation: (a) the image model **can** render dark — a
one-shot forceful prompt produced a correct `#050505` + purple image; (b) there
is **no** hardcoded bright/clean prior in the content-generator's SOUL.md/config
— the white background is just the LLM's default SaaS aesthetic. So a strong,
explicit constraint in the brief is enough to steer it.

### Changed
- For dark brands, the brief now carries a **hard constraint** instead of an
  advisory: the image MUST have a dark/near-black background, the `visual_prompt`
  it writes MUST describe that background and MUST NOT contain
  "bright"/"white"/"light"/"soft white"/"studio", plus a `NON-NEGOTIABLE: this
  brand is DARK …` line + a dark-specific `visual_prompt` schema hint
  (`backend/social-content/workflow-request.ts`). Light/unknown brands unchanged.

### Notes
- Brand-fidelity counterpart to the resolved image-gen outage, which turned out
  to be **stale content-generator gateway state** (fixed by a gateway restart),
  not an OpenAI policy change — renders work again on the same model/token.

## v0.1.15.9 — Composio analytics: real per-platform mappers for all platforms (foundation)

Makes the Composio AnalyticsProvider actually return data instead of a generic
stub. Adds `analytics-mappers.ts` with verified-against-live-schema (2026-06-03)
per-platform request builders + response parsers:
- Facebook (`FACEBOOK_GET_POST_INSIGHTS` / `FACEBOOK_GET_PAGE_INSIGHTS`),
  Instagram (`INSTAGRAM_GET_IG_MEDIA_INSIGHTS` / `INSTAGRAM_GET_USER_INSIGHTS`),
  YouTube (`YOUTUBE_GET_VIDEO_DETAILS_BATCH` / `YOUTUBE_GET_CHANNEL_STATISTICS`),
  LinkedIn (`LINKEDIN_GET_SHARE_STATS`), TikTok (`TIKTOK_GET_USER_STATS`),
  Meta Ads (`METAADS_GET_INSIGHTS`, toolkit `metaads`).
- Each builds the tool's REAL args (IG `ig_media_id`+`metric[]`, FB `page_id`,
  YouTube `id[]`, LinkedIn org URN, Meta Ads `object_id`+`level`) and parses its
  REAL response (Graph `data[].values[].value`, YouTube `items[].statistics`,
  LinkedIn `elements[].totalShareStatistics`, Meta Ads rows with roas/costPerResult).
- Verified slugs are defaults, so analytics works once connected — no per-op slug
  config needed (env still overrides). Platforms/ops with no tool (Reddit, per-post
  TikTok) report `unavailable`, never fabricated. Fixed meta_ads toolkit slug
  (`metaads`). Capability preflight now reflects mapper availability.
- Replaces the generic `metrics-normalizer` (deleted). 40 Composio tests pass.

Rendering these metrics in the dashboard goes through the existing insights module
via a Composio `InsightsAdapter` — planned in
`docs/plans/2026-06-03-composio-analytics-render.md`, landed + live-verified once an
account is connected. Still default OFF.

## v0.1.15.8 — Composio: use connectedAccounts.link() (the retired initiate() 400s on managed OAuth)

Fixes the Composio connect path before it ships live. `@composio/core@0.10.0`'s
`connectedAccounts.initiate()` is retired — it returns 400 for Composio-managed
OAuth as of 2026-05-08 — so the connection-link gateway swaps to the modern
`connectedAccounts.link(userId, authConfigId, { callbackUrl })`, which has the
same `{ id, redirectUrl }` shape and works for managed + custom auth configs.
Type-validated against the real SDK (tsc 0 errors); 27 Composio tests pass.
Still default OFF. (To enable, the prod `.env` still needs an auth-config id
`ac_...`, not the project id — see docs/integrations/composio.md.)

## v0.1.15.7 — Carry brand background/mode through the brand-kit copy layer (so the brief actually emits the dark instruction)

Follow-up to v0.1.15.5/6. Live verification showed the persisted kit was correct
(`background:#050505, mode:dark`, purple palette) but the production image brief
**still omitted the "Brand theme: DARK" line** — only the palette + logo lines
came through. Root cause: `marketingBrandKitReferenceFromTenantBrandKit`
(`backend/marketing/runtime-state.ts`) field-copies `colors` and was never
updated for the new `background`/`mode` fields, so `doc.brand_kit` — the object
the brief reads — lost the theme signal. `backend/tenant/business-profile.ts`
had the same field-by-field omission.

### Fixed
- `marketingBrandKitReferenceFromTenantBrandKit` and the business-profile
  brand-kit reconstruction now copy `colors.background` + `colors.mode`.
- **Live-verified on tenant 15:** the brief built from the real kit now emits
  `Brand theme: DARK. Render on a dark background (#050505) …`, the purple
  palette, and the `Brand logo: …aries-logo.webp` line.

### Tests
- `tests/marketing-brand-kit-reference.test.ts` asserts `background`/`mode`
  survive the reference copy.
- `tests/marketing/workflow-request-brand-theme.test.ts` gains an end-to-end case
  exercising the real `kit → reference → brief` path (verified failing without
  the copy-layer fix).

## v0.1.15.6 — Brand-color extraction: resolve the Tailwind v4 theme tokens (the real aries.sugarandleather.com shape)

Follow-up to v0.1.15.5. Live verification on the real `aries.sugarandleather.com`
showed v0.1.15.5 still mis-detected the brand as **light/#ffffff** because of two
gaps the synthetic tests didn't cover:

1. The page background is `bg-background` → the CSS token `--color-background`
   (`#050505`, dark) defined in an **external** stylesheet (already fetched into
   `cssBlocks`). v0.1.15.5 only looked for shadcn's `--background`, not Tailwind
   v4's `--color-background`.
2. The visible UI is full of translucent `bg-white/5` / `bg-white/10` **glass
   overlays** on the dark theme. The "count bg-* utilities" heuristic matched
   those opacity variants (43× `bg-white`) and out-voted the 6× plain `bg-black`,
   reporting a white brand. Plain `bg-white` actually appears once.

### Fixed
- `detectThemeBackground` now resolves, most-authoritative first: the
  `--color-background`/`--background` CSS token → a literal bg-* utility on
  `<html>`/`<body>`/the `min-h-screen` page wrapper → the most common **plain**
  bg-* utility (opacity variants like `bg-white/5` excluded via `(?![\w/])`) →
  inline `<body>` background → `body{}` rule → `theme-color`.
- Palette extraction now also reads Tailwind v4's `--color-primary` /
  `--color-secondary` / `--color-accent` (precise names — not the bundled default
  palette like `--color-red-500`), so the real brand colors come through.
- **Live-verified on `aries.sugarandleather.com`:** extraction now yields
  `background:#050505, mode:dark, palette:[#7c3aed,#a855f7,#c084fc]` (the real
  dark + purple brand) and the aries logo — was `primary:#ffffff`.

### Tests
- `tests/marketing/brand-kit-dark-theme.test.ts` gains a real-world case: external
  `--color-background:#050505` + a `bg-background` wrapper + `bg-white/N` glass
  overlays → dark/#050505 with the purple palette (verified failing on v0.1.15.5).

## v0.1.15.5 — Brand-color extraction: detect dark/light theme + carry the real logo into the image brief

Fixes marketing images rendering on a white background with invented logos for
dark-themed brands. `aries.sugarandleather.com` is a `bg-black` Tailwind site,
but brand-color extraction only read inline colors, CSS `--brand/--primary`
vars, and the `theme-color` meta — none of which the site sets — so it returned
`primary:#ffffff` and the production image brief told Hermes `Brand palette:
#ffffff`, yielding light images. The brief also never referenced the brand logo
(captured in `logo_urls` but never fed to image generation), so Hermes invented
its own marks. Found via live end-to-end verification on tenant 15.

### Added
- `colors.background` + `colors.mode` (`'light' | 'dark' | null`) on the brand
  kit. `detectThemeBackground` (`backend/marketing/brand-kit.ts`) recovers the
  page background from, in order: a `bg-*` Tailwind utility on `<body>`/`<html>`,
  the dominant dark/light `bg-*` utility across the markup, an inline `<body>`
  background, a `body{}`/`:root{--background}` CSS rule, then the `theme-color`
  meta — and classifies dark vs light by relative luminance. Optional/absent on
  kits extracted before this shipped (re-extracted automatically on the next
  weekly run via `ensureFreshBrandKitForWeeklyRun`).

### Changed
- The production image brief (`backend/social-content/workflow-request.ts`) now
  emits an explicit theme instruction — `Brand theme: DARK. Render on a dark
  background (#000000) — do NOT use a white or light background` for dark brands
  (light analog for light brands) — and a `Brand logo: <url> — use the actual
  brand logo … do NOT invent, redraw, or substitute a different logo` line.
  `brand-kit-payload.ts` threads `background`/`mode` through the Hermes payload.
- Pixel-perfect logo rendering remains a Hermes-side follow-up: faithfully
  reproducing the mark needs gpt-image to receive the logo as a reference image
  (separate repo); Aries now supplies the URL + the do-not-invent instruction.

### Tests
- `tests/marketing/brand-kit-dark-theme.test.ts` — extraction classifies a
  `bg-black` site as dark/#000000, a `bg-white` site as light/#ffffff, and reads
  `theme-color` as a fallback (verified failing without the fix).
- `tests/marketing/workflow-request-brand-theme.test.ts` — the dark brief forbids
  white backgrounds and references the real logo; light/legacy kits don't get a
  dark instruction.

## v0.1.15.4 — Ingest production creative_assets on the publish-skip completion path

Fixes "No launch items" after a successful render. When the production stage
returns an `approve_publish` checkpoint and publishing is not required, the
marketing callback takes the publish-skip path: it marks the job completed and
previously returned WITHOUT ingesting production creative_assets (that ingestion
only ran in the separate `completed` branch). So the rendered image landed on
disk but never in the `creative_assets` table, and the dashboard showed "No
launch items" despite a real render. Found via live end-to-end verification of
the v0.1.15.1 Hermes reconciler.

### Fixed
- Call `ingestProductionCreativeAssetsOnCompletion` on the publish-skip
  completion path too, so generated images are ingested into `creative_assets`
  and appear in the dashboard. Regression test
  (`tests/marketing/publish-skip-creative-ingest.test.ts`) drives the exact path
  and asserts the `creative_assets` INSERT (verified failing without the fix).

## v0.1.15.3 — Composio: ship the @composio/core SDK so the integration is runtime-ready (still default OFF)

Makes the Composio integration (v0.1.14.0) actually runnable in prod by adding
the real SDK to the image and validating the adapter against it. **Still ships
default OFF** — `COMPOSIO_ENABLED=false`, `PUBLISH_PROVIDER=direct_meta`; no
behavior change. Turning it on is a host `.env` edit (`COMPOSIO_API_KEY` +
an auth-config id + `COMPOSIO_ENABLED=true`), see `docs/integrations/composio.md`.

- Added `@composio/core@^0.10.0` as a prod dependency (installed into the runner
  via `npm ci --omit=dev`; resolved by the gateway's lazy `import()` at runtime).
- Removed the hand-written `composio-sdk.d.ts` type shim and compiled the adapter
  against the **real** SDK types (`tsc` 0 errors). Fixed the one real-API
  mismatch: `connectedAccounts.list` no longer passes a plainly-typed `statuses`.
- Aligned `mapComposioStatus` with the real status enum
  (`INITIALIZING|INITIATED|ACTIVE|FAILED|EXPIRED|REVOKED`).
- Verified `next build` bundles the SDK cleanly (all 5 Composio routes + the
  `/connections` page compile); 67 provider/publisher/analytics/store tests pass.

## v0.1.15.2 — Ship the reconciler's package source to the runtime image

Hotfix for v0.1.15.1. The Hermes reconciler worker (`tsx`-spawned, not bundled
by Next.js) resolves `@aries/hermes-protocol` from source at runtime via the
tsconfig path `packages/aries-hermes-protocol/src`, but the Docker runner stage
did not copy `packages/` — so the worker crash-looped on
`Cannot find module '@aries/hermes-protocol'` and the crash-loop guard correctly
stopped respawning it. The rest of the app was unaffected (the web build bundles
the package into `.next`).

### Fixed
- Copy `packages/` into the runner image so `tsx` workers can resolve
  `@aries/hermes-protocol` (and any future workspace package) at runtime. The
  reconciler now starts and ingests completed Hermes runs as intended.

## v0.1.15.1 — Durable Hermes run reconciler (fixes stalled marketing pipeline)

Restores marketing content generation in production. Hermes `/v1/runs` is a
polled API that never calls back, so Aries drove runs to completion with an
in-process "poll-bridge" spawned by the submitting request — which did not
survive the Next.js production request lifecycle, so completed runs were never
ingested and every marketing job was eventually failed by the stale-run reaper
(no marketing job had completed since 2026-05-27).

### Added
- A durable Hermes run reconciler (`ARIES_RECONCILER_ENABLED`, default ON): a
  standing worker spawned by the runtime alongside the web cluster (the
  stale-run reaper's model). Every 60s it re-discovers in-flight marketing runs
  and ingests any Hermes has finished, through the same idempotent callback path
  the bridge used — but as a standing process, so it survives the request churn
  that orphaned the bridge. Tunables: `ARIES_RECONCILER_INTERVAL_MS`,
  `ARIES_RECONCILER_MAX_RECORD_AGE_MS`, `ARIES_RECONCILER_MIN_AGE_MS`,
  `ARIES_RECONCILER_TICK_TIMEOUT_MS`, `HERMES_RECONCILER_POLL_TIMEOUT_MS`.

### Fixed
- Marketing jobs (weekly content and the onboarding variant board) no longer
  stall and get reaped when Hermes finishes a run — completed creative is
  ingested within about a minute.
- Execution-run records now record which Hermes gateway they were submitted to,
  so reconciliation always polls the correct per-profile gateway.
- A terminal execution run can no longer be overwritten to failed by a late
  poll (completion-vs-reconciler race).

## v0.1.15.0 — First-post onboarding variant board → Aries + Honcho taste profile

Ships the flag-gated (`ARIES_ONBOARDING_VARIANT_BOARD_ENABLED`, default OFF)
first-post onboarding variant board specced in v0.1.14.2's plan. When ON, a new
user's first post is generated as 3 competing full-post variants (Aries fans out
3 single-post `weekly_social_content` jobs — no Hermes contract change), shown on
an in-app comparison board where the user rates each (1-5 stars), regenerates /
"more like this" / freeform-edits, and picks one. The pick anchors the remaining
6 week-1 posts (Phase B, generated *after* the pick) and writes taste to BOTH a
new `marketing_taste_profile` table (read-time bias, 5%/week decay) and Honcho
(`variant_taste_signal`).

- **Phase 1 (data + flag):** `marketing_taste_profile` / `marketing_taste_signal`
  tables + store (Laplace confidence, read-time decay), Honcho
  `recordOnboardingVariantTasteSignalEvent`, `loadTasteForBrief`,
  `isOnboardingVariantBoardEnabled()`.
- **Phase 2 (fan-out):** `startFirstPostVariantBatch`, `creative_assets`
  `variant_batch_id` / `variant_index` grouping (doc-driven, not callback), a
  read-time board with timeout auto-pick, and a guard so variant jobs do NOT
  auto-publish until the pick.
- **Phase 3 (UI):** `frontend/aries-v1/variant-board.tsx` (accessible stars,
  regenerate/edit, pick), `GET`/`POST /api/onboarding/variants/[batchId]`,
  onboarding resume branch (idempotent fan-out, no double-run on revisit).
- **Phase 4:** dual taste write (DB + Honcho) on pick + ratings + edits, Phase-B
  anchored generation of posts #2-7, atomic pick claim.

Flag default OFF ⇒ onboarding byte-identical to today. Migrations
`20260602000000_marketing_taste_profile.sql` and
`20260602010000_creative_assets_variant_columns.sql` are additive
(`IF NOT EXISTS`); apply to existing DBs before flipping the flag. `init-db.js`
carries the same DDL for fresh DBs.

## v0.1.14.2 — Plan: first-post onboarding variant board → Aries + Honcho taste profile

Adds the plan doc `docs/plans/2026-06-02-onboarding-variant-board.md` (planning
only — no runtime code changes). It specs a flag-gated
(`ARIES_ONBOARDING_VARIANT_BOARD_ENABLED`, default OFF) gstack-style comparison
board for a new user's first post: 3 full-post variants (Aries fans out 3 Hermes
runs — no Hermes contract change), with pick + 1-5 star rating +
regenerate/more-like-this/freeform edit. The chosen variant anchors the remaining
6 week-1 posts (Phase B, generated *after* the pick) and writes taste to BOTH a
new Aries `marketing_taste_profile` table and Honcho (via the existing
`recordCreativeVoicePreferenceEvent` path). 4 phases, grounded in the current
onboarding/Hermes/Honcho code with file:line references. Docs-only; flag OFF = no
behavior change. Active goal saved for a fresh implementation session.

## v0.1.14.1 — Turn on weekly image stories + fix the surface-drop that mis-published them to the feed

Flips the weekly social-content `story_count` default from 0 (OFF) to 1 (ON) so
every weekly run now ships one image story alongside the feed posts. Aries
synthesizes the story from the run's Hermes creative, composes it into a 9:16
canvas with the post headline + brand CTA baked in (`story-composer.ts`), and
publishes it LIVE through the scheduled-dispatch path (Meta cannot natively
schedule stories). Levers: `SOCIAL_CONTENT_DEFAULT_SCOPE.story_count` and
`DEFAULT_SOCIAL_CONTENT_COUNTS.storyCount` (both 0 → 1), plus the new-job UI
default (`new-job.tsx`, 0 → 1) so operator-created jobs request stories too.

**Surface-drop bug fixed (the reason flipping the flag alone would have
mis-published).** `autoScheduleApprovedPostsForJob` derived each scheduled row's
surface from the strategist `weekly_schedule` by ordinal — which never emits a
`story` placement — and never read the post's own `surface='story'` column. So an
auto-promoted story collapsed onto its feed sibling's slot and the composed 9:16
image published to the **feed**, not as a story. The row builder is now extracted
as `buildAutoScheduleRows` and takes surface/media_type from the post's own
authoritative columns (the schedule supplies only the recommended day). The manual
schedule route (`schedule/route.ts`) had the same defect — it now reads
`posts.surface`/`media_type` and passes them to `upsertScheduledPost` instead of
defaulting to feed. New regression tests in `marketing-auto-schedule.test.ts`
cover the surface-preservation contract (previously untested).

Proven live before shipping: an image story posted to both IG (Graph-confirmed
`media_product_type=STORY`) and FB (`/photo_stories`, status published) on the
@sugarandleatherai account via the deployed dispatch path. `npm run verify` green;
629 marketing/scheduling/meta/social-content tests pass.

## v0.1.14.0 — Composio integration: optional, flag-gated account/publish/analytics layer (default OFF)

Adds Composio as an **optional, isolated** provider layer for end-user social/ad
account connection, publishing, and analytics — without touching the existing
direct Meta path. Ships **default OFF**: with `COMPOSIO_ENABLED=false` (the
default) and `PUBLISH_PROVIDER=direct_meta` / `ANALYTICS_PROVIDER=direct_meta`,
no Composio code loads and behavior is identical to before. `npm run verify` +
`test:concurrent` green; existing `meta-publishing` / `publish-dispatch-approval`
tests pass unchanged.

**Aries-owned abstractions first** (`backend/integrations/providers/`):
`AccountConnectionProvider`, `PublisherProvider`, `AnalyticsProvider`,
`CapabilityProvider`, normalized result/metric types, and a `provider-factory`
that turns flags into providers. `COMPOSIO_ENABLED` is a hard master switch —
when off, the factory always returns the direct Meta provider regardless of the
selectors. `auto` mode tries Composio first and falls back to direct Meta for
Facebook/Instagram.

**Composio adapter** (`backend/integrations/composio/`) behind those interfaces,
using the verified `@composio/core` SDK surface (`connectedAccounts.initiate/
list/get/delete`, `tools.execute`), loaded lazily so the package is only required
when enabled. **`DirectMetaProvider`** (`backend/integrations/direct/`) wraps the
existing `publishToMetaGraph` with identical behavior — `meta-publishing.ts` is
untouched.

**Safety invariants enforced + tested (24 new tests):** ads/campaigns always
created PAUSED/draft; organic posts support dry-run preview and refuse a live
post without an explicit approval; analytics normalize with missing metrics as
`null` (never fabricated); connections persist Composio connected-account IDs,
never raw OAuth tokens (the new `connected_accounts` table has no token column).

**Surface:** connection endpoints under `/api/integrations/composio/*` (isolated
+ removable), a nontechnical `/connections` UI, the `connected_accounts` table
(init-db + dated migration), env plumbing in `docker-compose.yml` with OFF
defaults, and `docs/integrations/composio.md`. Also reconciles a pre-existing
`package.json` version drift (was `0.1.13.1`).

## v0.1.13.26 — public-readiness roadmap kickoff: plans + requires-infra test split

Kickoff for Brendan's 15-area public-readiness roadmap. Docs + test-only — **zero
`backend/` or `app/` runtime edits**.

**Plans (docs/plans/2026-06-01-*).** A 38-agent reconcile→plan→review→audit workflow
mapped all 15 roadmap areas to shipped / plan-exists / needs-plan and wrote a grounded,
adversarially-reviewed implementation plan for every gap (completeness audit: 0 uncovered).
`2026-06-01-public-readiness-reconciliation.md` is the index + dependency-ordered execution
plan. Already-shipped work is cited, not re-planned: #519 (Meta failure taxonomy + reconnect
signal + creative_asset_ids backfill) and #520 (video/Reel/Story publish surfaces, flag-gated).

**Requires-infra test split (roadmap area 1a — `2026-06-01-test-suite-split-finish.md`).**
Closes the residual correctness/clarity debt inside the now-green `full-suite` gate so it is
green for the right reason, and makes the requires-infra vs self-contained split explicit:
- Tenant-scoped 3 flat hydration fixtures in `frontend-api-layer.test.ts` so they exercise the
  production tenant-scoped artifact read (`jobs-status.ts:387`) instead of a dead flat path;
  the source-fingerprint leak-prevention test is preserved.
- Documented the oauth `status` (Postgres) vs `connection_status` (in-memory) two-store split
  (a recon false-positive, not drift) + added a positive DB-path assertion. No column change.
- Added an ECONNREFUSED⇒fallback counter-branch so the network-vs-auth boundary
  (28P01⇒503, ECONNREFUSED⇒201 fallback-create) is two named tests.
- Shared `tests/helpers/requires-infra.ts` (`requireDbEnvOrSkip`, superset DB_* keys, canonical
  skip string) adopted by all 7 live-DB files; `tests/REQUIRES_INFRA.md` index;
  `scripts/list-requires-infra.mjs` + `npm run test:requires-infra-report` (314 self-contained /
  7 requires-infra) + flag-gated `npm run test:requires-infra`.
- New default-OFF flag `ARIES_TEST_REQUIRES_INFRA_ENABLED` (test-harness only; documented in
  `CLAUDE.md` + `.env.example`, deliberately not in `docker-compose.yml`).

Verified: typecheck clean; full CI-exact suite 2154 pass / 0 fail / 9 requires-infra skip.

**Operational (run separately, approved by Brendan):** the prod `creative_asset_ids` backfill
(`2026-06-01-publish-reliability-backfill-verify.md`, roadmap 1c) was run via
`scripts/backfill-creative-asset-ids.mjs` — dry-run → review → `--write` → idempotency re-check.
**2 legacy single-asset rows populated**, 0 ambiguous, 60 genuinely-empty rows left on fallback;
re-run reports populated 0 (idempotent). Those posts now resolve their own image per-post.

## v0.1.13.25 — perf(social-content): write-time dashboard-row denormalization with a freshness guard

The QA-audit P1 fix for the slow list endpoints. `/api/social-content/posts`
(`listSocialContentJobsForTenant` + `listDeletedSocialContentJobsForTenant`) and
`/api/marketing/posts` (`getWorkflowAwareDashboardContentForTenant`) full-hydrated
EVERY job (`loadStagePayloadBundle` ~10 file reads + review builds + `getMarketingJobStatus`)
just to render summary cards — ~9-10s warm. Now the whole `view.dashboard` row is
denormalized to `dashboard_list_projection` on the workspace record at every write
site (via `recomputeAndPersistPendingApprovalCount`, which denorms BOTH the
pending-approval count and the row off one `(status, view)` build) and read O(1):
two file reads per job, skipping the heavy build. `referenceDate` is pinned to
`created_at` so the snapshot is a pure function of state (byte-identical to a rebuild;
the detail view's derived calendar now also anchors to creation week).

Hardened against the staleness/crash classes a 4-skeptic adversarial review found:
- **Freshness guard.** The projection carries `sourceUpdatedAt` (= `runtimeDoc.updated_at`
  at build). The fast path serves it only when that matches the live `updated_at`,
  else it rebuilds + self-heals. This auto-invalidates the projection for EVERY
  runtime-doc writer (the stale-run reaper, orchestrator transitions) without wiring
  each — the writer bumps `updated_at`, the guard notices. Previously the self-heal
  only fired when the projection was absent, so a reaped/transitioned job served a
  stale `running` card forever.
- **DB-only writers recompute.** `posts.published_status` (manual IG/FB publish,
  scheduled-dispatch) and `creative_assets` (upload-replace) don't touch the runtime
  doc, so they call `recomputeAndPersistPendingApprovalCount` themselves.
- **Crash guards.** `new Date(runtimeDoc.created_at)` is now `Number.isFinite(Date.parse(...))`-
  guarded — a malformed `created_at` no longer throws `RangeError` and 500s the whole
  tenant list. The malformed-projection load guard validates the dashboard arrays +
  `statuses.countsByStatus` (a partial `dashboard:{}` would crash `mergeDashboardContent`).
  The on-read count recompute is wrapped so one bad job degrades to count 0 instead
  of 500-ing the list.

New oracle tests: byte-identical persisted-row vs fresh-rebuild, stale-projection
self-heal, and malformed-`created_at` no-throw. Full suite green (2153/2153).

## v0.1.13.24 — fix(a11y): unique per-view <title> for the campaign workspace (WCAG 2.4.2)

The stage routes `/dashboard/{brand-review,creative-review,strategy-review,publish-status}`
client-redirect to `/dashboard/social-content/<id>?view=…` when a campaign exists,
so all four collapsed to the workspace's static `"Campaign — Aries AI"` title.
Replaced the static export with `generateMetadata` keyed by the `view` param →
"Brand Review / Creative Review / Strategy Review / Publish Status / Campaign — Aries AI".
The h1 was already per-view; this makes the document `<title>` unique too.

## v0.1.13.23 — fix(a11y): EmptyStatePanel h3 → h2 (heading-order on /review + empty states)

The shared `EmptyStatePanel` rendered its title as `<h3>`. With the per-route
sr-only `<h1>` from v0.1.13.19, an empty screen (e.g. `/review` with an empty
queue) went `h1 → h3`, skipping a level (axe heading-order, moderate). Bumped to
`<h2>` — valid after the page h1 and after any section h2, so no screen skips.
Caught by the final live 27-route re-scan.

## v0.1.13.22 — fix(a11y): raise `text-primary` foreground to `text-violet-300` (WCAG 1.4.3 follow-up)

The v0.1.13.19 contrast pass fixed low-opacity white text but left `text-primary`
(`#7c3aed` / violet-600) used as a FOREGROUND color. On the dark theme that is
only 2.89:1 — it fails 4.5:1 for normal text. The live re-scan caught 77 such
failures on `/dashboard/posts` alone (the "Open asset preview" links), plus the
eyebrow labels on terms / privacy / sitemap / hackathon / onboarding / new-job.

### Fixed
- Site-wide codemod: `text-primary` (foreground) → `text-violet-300` (~7.5:1 on
  the dark theme), 69 sites across 29 files. Covers links, eyebrow labels, badges,
  and accent icons. `bg-primary` / `border-primary` / gradient `*-primary` are
  unchanged, so buttons keep the brand violet (white-on-violet already passes).
  `text-primary/NN` opacities were already handled in v0.1.13.19/.21.
  admin + creative-memory (light-surface, out of audit scope) excluded.

## v0.1.13.21 — fix(a11y+media): flatten calendar tray interactivity + GC/guard evicted Hermes media

QA-audit fixes #4 (nested-interactive) and #3 (broken images).

### Fixed
- **Calendar nested-interactive (WCAG 4.1.2).** The unscheduled-post tray rendered
  each item as a dnd-kit draggable `<div role="button" tabindex="0">` that WRAPPED
  its "Schedule" `<button>` — a focusable control inside a focusable control (axe:
  "Element has focusable descendants", 59 nodes on this tenant's backlog). The
  Schedule button is now a SIBLING of the draggable card, which also lets us drop
  the pointer/key `stopPropagation` hacks that kept a button click from starting a
  drag. Drag-to-schedule and click-to-schedule both still work.
- **Broken creative tiles + orphaned media rows (P2).**
  - `queryProductionCreativeAssets` now filters `orphaned_at IS NULL`, so a
    superseded/evicted creative is no longer surfaced (its dead
    `/api/internal/hermes/media/<id>` URL is no longer emitted).
  - New `scripts/gc-missing-hermes-assets.ts` (dry-run by default) marks
    `runtime_asset` rows whose file has evicted from `HERMES_IMAGE_CACHE_MOUNT`
    as `orphaned_at`, after a 7-day grace; `gc-orphan-uploads.ts` then reclaims
    them. Strictly never touches `ingested_asset` (composed stories / uploads).
  - The calendar tray `<img>` hides itself on error instead of showing a broken
    tile (the MediaPreview surfaces already fall back to "Preview archived").

### Notes
- Older runtime-artifact thumbnails whose Hermes cache files evicted still issue a
  `/api/internal/hermes/media` request that 404s before the MediaPreview fallback
  renders; those are not creative_assets rows (GC dry-run found 0 orphaned rows),
  so eliminating the request itself would need a dashboard-content-pipeline
  file-existence pass or a media-route placeholder — tracked as follow-up.

## v0.1.13.20 — perf(marketing): O(jobs-with-pending) review queue + concurrent dashboard hydration + list-fetch timeout

QA-audit P1: dashboard list pages rendered a blank skeleton for 8-16s and could
hang on "Loading…". Root cause was per-job full hydration
(`buildSocialContentWorkspaceView` → `loadStagePayloadBundle`). This is the
safe, high-leverage slice (no risky write-time row denormalization of the core
orchestrator; that remains a scoped follow-up for `/api/social-content/posts`).

### Changed
- **`/api/marketing/reviews` is now O(jobs-with-pending), not O(all-jobs).**
  `listMarketingReviewQueueForTenant` reads the persisted, oracle-verified
  `pending_approval_count` (PR #521) and skips the expensive
  getMarketingJobStatus + buildSocialContentWorkspaceView hydration for any job
  whose count is 0. Legacy records (count undefined) fall through to a full
  build and self-heal the scalar. Live: ~16.5s → sub-second for a mostly-settled
  tenant. New oracle test proves the skip path equals a full rebuild.
- **`/api/marketing/posts` hydrates jobs concurrently.**
  `getWorkflowAwareDashboardContentForTenant` replaced its serial per-job loop
  with bounded `processConcurrent(_, 4)` (≤20% of DB_POOL_MAX, mirrors
  `listSocialContentJobsForTenant`; guardrail #1). Dedup stays in jobId order so
  selection is byte-identical. Live: ~13s → ~4s.
- `buildReviewItemsForJob` accepts a pre-loaded `runtimeDoc` to avoid a
  redundant disk read on the review-queue path.

### Added
- **List-fetch timeout + retry (no more infinite spinner).** `requestJson`
  accepts `timeoutMs`; the three dashboard list GETs (`/api/social-content/posts`,
  `/api/marketing/reviews`, `/api/marketing/posts`) abort after 30s and throw a
  retryable `request_timeout` error. The social-content, review-queue, posts, and
  results screens now render a "Try again" button on error instead of leaving a
  stuck skeleton.

## v0.1.13.19 — fix(a11y): WCAG color-contrast + per-route titles/h1 + heading-order

Remediation from the 2026-05-31 QA + WCAG accessibility audit of
aries.sugarandleather.com. Presentational only — no behavior change.

### Fixed
- **Color contrast (WCAG 1.4.3).** Raised failing low-opacity white text (every
  `text-white/NN` below 50% → `/70`), `text-zinc-500/600` → `text-zinc-400`, and
  `text-primary/80` → `text-violet-300` (calendar "Schedule" buttons + the docs
  badge), so secondary text clears 4.5:1 against the dark theme. Placeholder
  opacities and decorative SVG fills are intentionally left unchanged.
- **Page titles + single h1 (WCAG 2.4.2 / 1.3.1 / 2.4.6).** Every `/dashboard/*`
  and `/review` route now exports a unique, descriptive `<title>` and exposes
  exactly one `<h1>`: the app shell renders a visually-hidden `<h1>` from the
  route config, and the four presenter-level visible `<h1>`s (Calendar, Settings,
  Results, Social Content) plus the New-Social-Content screen heading were demoted
  to `<h2>` to keep one h1 per page.
- **Heading order (WCAG 1.3.1).** Footer column headings `h4` → `h2` and the home
  marketing calendar sidebar labels `h4` → `h3`, so public pages no longer skip a
  heading level.

## v0.1.13.18 — fix(social-content): make composed story images actually publish (serving + persistence)

Two bugs in v0.1.13.17 (#525) meant a composed story would silently never reach
Meta with words/CTA. Both caught by a live publish, which failed with
`Only photo or video can be accepted as media type`.

### Fixed
- **Public media proxy now serves `ingested_asset` bytes.**
  `/api/public/media/[token]/[basename]` resolved bytes ONLY from the Hermes
  mount, so a composed story image (an `ingested_asset` under
  `DATA_ROOT/ingested-assets`) 404'd when Meta fetched the signed URL → publish
  rejected. The proxy now falls back to
  `DATA_ROOT/ingested-assets/<tenant>/<sha[:2]>/<basename>`, scoped to the token's
  `tenantId` (a tenant can only fetch their own ingested bytes). This also
  unblocks publishing **operator-uploaded** creatives, which shared the gap.
- **Composed-asset persistence no longer leaves `served_asset_ref` NULL.**
  The insert used a data-modifying CTE (`INSERT … ; UPDATE … WHERE id = ins.id`)
  to backfill `served_asset_ref` with the new row's id — but PostgreSQL evaluates
  the UPDATE against a snapshot that excludes the CTE's just-inserted row, so it
  matched 0 rows and the ref stayed NULL (the composer then returned no id and
  fell back to the bare creative). Replaced with a single self-referential
  INSERT that generates the uuid in a subselect feeding both `id` and
  `served_asset_ref`. Verified on the prod DB.

### Added
- `tests/public-media-ingested.test.ts`: the proxy serves ingested bytes from
  DATA_ROOT, still serves mount bytes, 404s on miss, and is tenant-scoped.

## v0.1.13.17 — feat(social-content): compose story images with headline + aries.sugarandleather.com CTA

### Added
- **Server-side story image composition** (`backend/marketing/story-composer.ts`).
  Meta IG/FB story publishing renders ONLY the image — captions are ignored and
  link/text stickers are unsupported via the Graph API — so a raw feed creative
  posted as a story shows up wordless with no call-to-action. The composer builds
  a 1080×1920 (9:16) story: darkened/blurred full-bleed background, the creative
  contained up top, a bottom scrim, the post's **hook as a bold headline** (wrapped,
  length-adaptive), and a brand-color **CTA pill carrying the site host**
  (`aries.sugarandleather.com`, derived from `APP_BASE_URL`, never the bare
  leather-goods host; CTA font auto-sizes so the URL never clips).
  - Composed image is persisted like an operator upload — written under
    `DATA_ROOT/ingested-assets` as a `creative_assets` row
    (`source_type='runtime_artifact'`, `storage_kind='ingested_asset'`,
    `aspect_ratio='9:16'`) served by the id route, so the existing dispatch
    signing path makes it fetchable by Meta. No new serving route.
  - `composeStoryAssetForBaseCreative` resolves base bytes (runtime_asset from the
    Hermes mount, ingested_asset from DATA_ROOT), composes, persists, and returns
    the composed asset id — returning `null` on any failure so a publish never
    blocks (falls back to the raw creative).
- **Wired into story synthesis** (`synthesize-publish-posts.ts`,
  `hermes-callbacks.ts`): a promoted `surface='story'` post is now backed by the
  COMPOSED asset (composed once per post, reused across platforms), using the
  post's hook as the headline. Falls back to the raw creative if no composer is
  wired (unit tests) or composition fails.

### Notes
- Fixes the wordless / no-CTA stories from v0.1.13.16's bare-creative path.
- Uses DejaVu Sans (present in the runtime container's fontconfig set) for SVG
  text via sharp.

## v0.1.13.16 — feat(social-content): automate image stories — story_count request + auto-promote to live IG/FB

### Added
- **`story_count` weekly-request axis (gated OFF, default 0).** The weekly
  social-content request now carries `scope.story_count` (camelCase `storyCount`,
  legacy alias `storiesCount`) end-to-end: `SOCIAL_CONTENT_DEFAULT_SCOPE`
  (`backend/social-content/defaults.ts`), `WeeklySocialContentPayload` +
  `DEFAULT_SOCIAL_CONTENT_COUNTS` (`types.ts`), normalization (`payload.ts`),
  the Hermes request builder (`workflow-request.ts`), the job-scope reader
  (`jobs-status.ts`), the new-job form handler + an "Image stories" input in
  `frontend/social-content/new-job.tsx`. Default `0` keeps the Hermes payload
  byte-for-byte equivalent to the pre-stories behavior.
- **Aries-side image-story auto-promotion** (`synthesize-publish-posts.ts`).
  When a weekly run requested `story_count > 0`, Aries promotes the first N
  `content_package` entries into ADDITIONAL `surface='story'` image posts that
  reuse the run's Hermes-generated creatives. This closes the automation loop
  without any Hermes-prompt change: the upstream strategist/publish stages do
  not emit `placement:'story'` today, so without this an operator's requested
  stories would never materialise. Story posts publish **live** through the
  existing scheduled-dispatch path (Meta rejects scheduled stories; the dispatch
  route never forwards `scheduledFor`). Idempotent + non-colliding: the per-row
  key carries the surface as its 4th segment (`…:story` vs `…:feed`), so a
  replayed callback hits `ON CONFLICT DO NOTHING`.

### Notes
- Default `story_count=0` ⇒ both additions are inert; feed-only behavior is
  unchanged (verified by the weekly-payload byte-shape test and a new
  `story_count default 0` synthesis test).
- The Aries publish path for image stories (FB `/photo_stories`, IG `STORIES`
  container) shipped in #520 and is verified live on IG + FB. To turn stories on,
  set the "Image stories" count > 0 when creating a weekly job.

## v0.1.13.7 — perf(social-content): collapse redundant per-job runtime-doc reads on the list path

### Performance
- **Campaign-list / results hot path** (`GET /api/social-content/posts` →
  `listSocialContentJobsForTenant` / `listDeletedSocialContentJobsForTenant`)
  now reads each job's runtime doc from disk **once** instead of three times.
  v0.1.13.6 removed the double *hydration* (the 2× full workspace-view builds),
  but each surviving build still reloaded the doc on its own: `getMarketingJobStatus`
  loaded it (`buildMarketingJobStatus`), the list loaded it again explicitly, and
  `buildSocialContentWorkspaceView` loaded it a third time. The list now loads the
  doc once in phase 1 and threads it through both via a new optional `runtimeDoc`
  parameter on `getMarketingJobStatus` and `buildSocialContentWorkspaceView`.
  - **Correctness:** byte-identical output. `loadSocialContentJobRuntime` returns a
    fresh object per call and the status/view builders treat the doc as read-only,
    so threading one shared doc is equivalent to reloading it. The full view is still
    built (dashboard + workflowState + creativeReview), so every `RuntimePostListItem`
    card field and the `pendingApprovals` count are unchanged. Guarded by
    `tests/runtime-views-list-projection.test.ts::assertViewEquivalence`
    (threaded-doc view/status deep-equal the reload-doc view/status), now wired into
    `npm run verify`.
  - `undefined` (param omitted) loads the doc as before; `null` (caller proved the
    doc is missing) hits the same not-found sentinel — so all existing single-arg
    callers are unaffected.
  - No new fan-out: the bounded `processConcurrent(…, 4)` is preserved
    (CLAUDE.md operational guardrail #1); per-slot work is reduced, not parallelism
    widened. Response shape unchanged.
  - `backend/marketing/{runtime-views,workspace-views,jobs-status}.ts`
  - **Investigated and rejected (not byte-identical):** a true lightweight list
    projection (skip the workspace-view build) is infeasible — `view.workflowState`
    and every gated dashboard count are joint outputs of the heavy build, which also
    gates `pendingApprovals`. Dropping the DB production creative-asset merge on the
    list path was also rejected: those rows are inserted `status:'approved'` but
    `mergeReviewState` overrides that with the persisted review decision, so skipping
    the merge would **undercount** `pendingApprovals` for any job with a rejected
    Hermes-generated creative asset. Both findings recorded so they aren't re-attempted.

## v0.1.13.6 — perf(social-content): lightweight list projection to cut per-job hydration

### Performance
- **Campaign-list / results hot path** (`GET /api/social-content/posts` →
  `listSocialContentJobsForTenant` / `listDeletedSocialContentJobsForTenant`)
  no longer hydrates every job twice. The per-card `pendingApprovals` count was
  derived via `buildReviewItemsForJob`, which re-loaded the runtime doc and
  rebuilt the full `getMarketingJobStatus` + `buildSocialContentWorkspaceView`
  for every job — a second full hydration on top of the one phase 1 already did
  (the documented double-load that emitted ~2x `[marketing-hydration] { event:
  'workspace-view' }` log lines per job per list load). Phase 1 now captures the
  `(runtimeDoc, status, view)` context once and phase 2 reuses it via the new
  internal `buildReviewItemsFromContext`.
  - **Before (per job):** ~4 runtime-doc loads + 2 full `getMarketingJobStatus`
    builds + 2 full `buildSocialContentWorkspaceView` hydrations (each:
    stage-payload bundle ~10 file reads, brand/strategy/creative review builds,
    ~3-4 DB queries).
  - **After (per job):** 1 runtime-doc load (phase 1) + 1 `getMarketingJobStatus`
    + 1 `buildSocialContentWorkspaceView`. Roughly halves runtime-doc loads,
    status builds, workspace-view hydrations, file reads, and DB queries on the
    list path. For tenant-15-scale (~22 jobs) this removes ~22 redundant full
    hydrations per screen load.
  - **Correctness:** `buildReviewItemsFromContext` runs the identical
    review-item logic on the identical freshly-built `(runtimeDoc, status, view)`
    inputs, so `pendingApprovals` and every `RuntimePostListItem` card field stay
    byte-identical — no staleness tradeoff (the fresh view is reused, not a
    persisted snapshot). Guarded by a new golden test
    (`tests/runtime-views-list-projection.test.ts`) asserting the list count
    equals the re-hydrating `buildReviewItemsForJob` path.
  - No new fan-out: the existing bounded `processConcurrent(…, 4)` is preserved
    (CLAUDE.md operational guardrail #1); per-slot work is reduced, not
    parallelism widened. Pool budget unchanged
    (`ARIES_WEB_CONCURRENCY=2 * DB_POOL_MAX=20`).
  - Response shape unchanged: `{ posts, hasMore, deletedPosts,
    currentBrandKitExtractedAt }`.
  — `backend/marketing/runtime-views.ts`

## v0.1.13.5 — fix(dashboard): non-blocking shell on list/results + deletedPosts wire-key fix

### Fixed
- **List and results screens now render the page shell immediately** instead of
  blocking the entire view behind a full-screen skeleton while the posts fetch
  hydrates. `/api/social-content/posts` must load full workspace-view state for
  every job (~22 jobs in prod) which takes 10-40s under normal load. Previously
  `post-list.tsx` and `results-screen.tsx` returned `<LoadingStateGrid />` as
  the only content during that window, leaving the page visually dead.
  Now the `ShellPanel` header (title, eyebrow, and the "New social content"
  action button on the list screen) renders immediately; the loading skeleton
  appears only in the content area below it so the page looks alive and
  navigable while data arrives.
  Note: the underlying ~10-40s backend latency on `/api/social-content/posts`
  is a per-job workspace-view hydration cost tracked as a Phase 2 follow-up
  (bounded-parallel fan-out / read-model cache). This change is Phase 1 UX
  relief only — no backend changes.
  — `frontend/aries-v1/post-list.tsx`, `frontend/aries-v1/results-screen.tsx`
- **`deletedPosts` wire-key mismatch:** `/api/social-content/posts` was
  returning the JSON key `deletedCampaigns` (leftover from the v0.1.13.0 cut 2a
  campaign→social-content rename) while `SocialContentListResponse` and
  `post-list.tsx` expected `deletedPosts`. The Recycle Bin section on
  `/dashboard/social-content` always appeared empty because
  `campaigns.data?.deletedPosts` was always `undefined` at runtime.
  — `app/api/social-content/posts/route.ts`

### Changed (no-op cleanup)
- `hooks/use-runtime-social-content.ts`: extract `baseUrl` / `autoLoad` as
  primitive variables at the top of `useRuntimePosts` so all hook dep arrays
  reference stable scalars rather than the transient inline-object reference
  callers pass. Harmless correctness improvement; does not change runtime fetch
  behaviour.

## v0.1.13.4 — fix(dashboard): repair broken orbit-metric coupling + scrub aries-v1 view-model copy (cut 5)

Cut 4 missed the `frontend/aries-v1/view-models/` layer, which produces user-visible dashboard/list/results copy. While scrubbing it, found and fixed a live coupling bug.

### Fixed
- **Dashboard-home orbit metric stuck at "0":** `dashboard-home.ts` emits the hero metric as `label: 'Social content jobs'` (renamed in an earlier cut), but `dashboard-home-presenter.tsx` still looked it up via `metricByLabel('Campaigns')` — a producer/consumer string mismatch that made the lookup return `undefined`, so the orbit surface rendered a hard-coded "Campaigns" label permanently showing "0" regardless of real job count. Lookup now matches the producer (`'Social content jobs'`) and the surface label reads "Social content". (Same string-literal-coupling class as the v0.1.11.x union-widening bugs.)

### Changed
- `frontend/aries-v1/view-models/post-list.ts`: hero eyebrow/title/description + metric labels/details — "Campaigns" → "Social content", "campaign" → "post".
- `frontend/aries-v1/view-models/results.ts`: hero title/description, metric labels/details, and the "All campaigns" filter — "campaign" → "post".
- `frontend/aries-v1/view-models/settings.ts`: profile-readiness detail copy — "future campaigns" → "future social content".
- `frontend/aries-v1/view-models/calendar.ts`: stale doc comment updated to match the already-renamed "Social content status at a glance" strip heading.

### Deliberately left unchanged
- Local code identifiers in the view-models (`campaigns` array param, `(campaign) =>` map vars, `campaign.stageLabel` accesses) — not user-visible; renaming is out of scope and risk for this cut.

## v0.1.13.3 — refactor(social-content): scrub campaign→social content in agent skill prose + user-facing copy (cut 4)

Finish the campaign→social-content terminology rename. Cut 2a renamed files and wire keys; cut 4 renames the remaining agent-facing skill prose and user-visible UI copy.

### Changed
- `skills/head-of-marketing/SKILL.md`: renamed "campaign planning" → "social content planning", `{brand}-campaign-proposal.*` → `{brand}-social-content-plan.*`, "Campaign Proposal" → "Social Content Plan" throughout.
- `skills/social-content-planner/SKILL.md`: output filenames `{brand}-campaign-proposal.*` → `{brand}-social-content-plan.*`; `# {Brand} Meta Ads Campaign Proposal` heading → `# {Brand} Meta Ads Social Content Plan`.
- `skills/creative-director/SKILL.md`: "campaign assets/proposal/strategy" → "social content assets/plan" in prose; output directory `{brand}-campaign/` → `{brand}-social-content/`.
- `skills/scriptwriter/SKILL.md`: output path `{project}-campaign/` → `{project}-social-content/`; overview heading "Campaign Scripts" → "Social Content Scripts".
- `CLAUDE.md`: "campaign strategy from research" → "social content strategy from research" (pipeline stage description).
- Frontend UI copy: all visible "Campaign"/"campaign" text renamed to "Social content"/"Post" as context fits, in: `post-list.tsx`, `presenters/post-list-presenter.tsx`, `components.tsx`, `presenters/results-presenter.tsx`, `app-shell/posts-console.tsx`, `presenters/calendar-presenter.tsx`, `results-screen.tsx`, `business-profile-screen.tsx`, `post-workspace.tsx`, `latest-post-view.tsx`, `presenters/dashboard-home-presenter.tsx`, `landing-page.tsx`, `review-queue.tsx`, `review-item.tsx`, `marketing/new-job.tsx`, `marketing/job-status.tsx`, `marketing/job-approve.tsx`, `auth/auth-visuals.tsx`, `app-shell/routes.ts`, `post-workspace-state.ts`, `hooks/useCalendarScheduling.ts`, `app/dashboard/social-content/new/page.tsx`, `app/admin/marketing/jobs/[jobId]/debug/debug-panel-client.tsx`.
- Test assertion in `route-metadata-and-docs-anchors.regression-015.test.ts` updated to match new page title.

### Deliberately left unchanged (paid-ads platform terms)
- `skills/meta-ads-publisher/SKILL.md` — Create Campaign / Campaign ID are Meta Marketing API object terms; renaming would corrupt API calls.
- `skills/ads-analyst/SKILL.md` — paid-ads analysis terminology.
- `skills/performance-marketer/SKILL.md` — paid-ads performance terms.
- Code identifiers, wire keys (`one_off_campaign`, `campaignEndDate`, `oneOff.campaignEndDate`), DB columns, and 308-redirect route IDs left untouched per spec.

## v0.1.13.2 — chore(refactor): Cut 3 janitorial — 308 redirects, dead env scrub, sprint complete

Final cleanup pass for the v0.1.13.x PRD-alignment refactor sprint. Sprint is now complete.

### Changed
- URL alias redirects (`/api/marketing/campaigns`, `/campaigns`, `/campaigns/[postId]`) upgraded from 307 (temporary) to 308 (permanent), matching the correct HTTP semantic for permanent URL aliases.
- Host-side artifact output directory moved from `lobster/output` → `hermes/output` on the production VM (stale files from 2026-05-23, no active writes). `.env` updated: `ARIES_HOST_ARTIFACT_OUTPUT_DIR` points at new location; dead vars `ARIES_LOBSTER_HOST_OUTPUT_DIR`, `OPENCLAW_LOCAL_LOBSTER_CWD`, `OPENCLAW_LOBSTER_CWD`, `LOBSTER_VIDEO_RENDER_ENABLED`, `OPENCLAW_GATEWAY_LOBSTER_CWD`, and OpenClaw gateway credentials removed.

### Notes
- `ARIES_MEMORY_LABEL_REDACTION_V2` was already defaulted to `1` (ON) in docker-compose.yml since PR #439 (v0.1.8.4). No change needed.
- Phase 2 DB migration (`UPDATE marketing_jobs SET job_type = 'one_off_post' WHERE job_type = 'one_off_campaign'`) deferred — `marketing_jobs` table does not carry `job_type` as a DB column; `job_type` lives in JSON runtime documents. No migration required.

## v0.1.13.1 — refactor(social-content): migrate internal wire keys with read-both/write-new compat

Renames Aries-internal wire keys from "campaign" to "social content / post" terminology. All renames use a **read-both/write-new** pattern so in-flight jobs persisted with old field/step names are not orphaned at deploy time.

### Changed
- Step name `campaign_planner` → `social_content_planner` in `artifact-collector.ts`. Readers attempt both step names and both file-system paths; writers emit only the new name. In-flight runs without a `social_content_planner.json` will fall back to `campaign_planner.json` transparently.
- Payload field `campaign_planner_path` → `social_content_planner_path` in `artifact-collector.ts` outputs. Writers emit both the new key and a legacy alias; all readers (`workspace-views.ts`, `asset-library.ts`) prefer the new key and fall back to the old one.
- `job_type` enum literal `'one_off_campaign'` → `'one_off_post'` (phase 1 of 2): `MarketingJobType` union, `StartSocialContentJobRequest`, `StartSocialContentJobResponse`, and `SocialContentJobRuntimeDocument.job_type` now include both literals. New jobs write `'one_off_post'`; all comparisons accept both. Existing DB rows with `job_type = 'one_off_campaign'` continue to work.

### Follow-up (separate PR)
- Phase 2 DB migration: `UPDATE marketing_jobs SET job_type = 'one_off_post' WHERE job_type = 'one_off_campaign'`. Drop `'one_off_campaign'` from the union after confirming no in-flight rows carry the old value.

### Wire-byte verification (pre-deploy check)
- On-disk job files: `mkt_fa9f7000` (live tenant-15 one-off job) has `job_type: "one_off_campaign"` — handled by read-both compat.
- Step payload cache dirs (`/data/lobster-stage2-cache/`) are empty — no `campaign_planner.json` files exist on disk for any tenant; only the step-facts path is exercised, not the file-system fallback.

## v0.1.13.0 — refactor(social-content): rename campaign → social content / post across Aries codebase

Aligns the entire Aries TypeScript codebase with the PRD terminology: the weekly recurring multi-post job is now "social content job" and each item in it is a "post". The old "campaign" term is preserved only where it refers to the broader multi-week marketing strategy concept, DB column names (`campaign_id`, `campaign_name`), or Hermes wire literals.

### Changed
- `MarketingDashboardCampaign` → `MarketingDashboardSocialContentJob` (job-level summary type)
- `MarketingDashboardCampaignContent` → `MarketingDashboardSocialContentJobContent`
- `MarketingDashboardContent.campaigns[]` → `.socialContentJobs[]`
- `AppRouteId 'campaigns'` → `'socialContent'`; sidebar nav title updated
- `listMarketingCampaignsForTenant` → `listSocialContentJobsForTenant`; deleted variant similarly renamed
- `handleGetMarketingCampaigns` → `handleGetSocialContentPosts` (route handler)
- Frontend files: `campaign-list`, `campaign-workspace`, `campaign-workspace-state`, `latest-campaign-view`, `campaign-list-presenter`, `campaign-list` view-model → `post-*` equivalents
- `hooks/use-runtime-campaigns.ts` → `use-runtime-social-content.ts`; `frontend/marketing/brand-campaign.tsx` → `brand-social-content.tsx`
- API route `app/api/marketing/campaigns/` → `app/api/social-content/posts/` (308 redirect at old path)
- Route param `[campaignId]` → `[postId]` in `app/dashboard/social-content/` and `app/campaigns/`
- 9 test files with "campaign" in filename renamed to "post"
- User-facing copy: "Campaign not found" → "Social content not found"; "Back to campaigns" → "Back to social content"

## v0.1.12.15 — feat(marketing): DELETE schedule + DELETE post (cascade) endpoints, Calendar Cancel button

First-class cancel/unschedule UX so operators can stop a scheduled post from publishing without dropping to SQL.

- `DELETE /api/social-content/jobs/[jobId]/posts/[postId]/schedule` cancels a pending scheduled post. Tenant + role + publish-approval gated. Returns 409 with `dispatch_in_flight` if the worker has already claimed the row; returns 200 + `{jobId, postId, deletedAt}` on success.
- `DELETE /api/social-content/jobs/[jobId]/posts/[postId]` cascades: removes the `scheduled_posts` row first (if present), then the `posts` row, in a single operation. Same auth and in-flight guard. Idempotent: already-gone post returns 404 rather than 500.
- Calendar UI gains a per-card Cancel button on posts with `dispatch_status === 'pending'`. Disabled (with tooltip) when `in_flight`. Hidden on `dispatched`/`failed`. Optimistically closes the detail panel and refetches on success.
- 6 new tests in `tests/social-content-cancel-schedule.test.ts`; added to `scripts/verify-regression-suite.mjs`.

## v0.1.12.14 — fix(marketing): read publish-stage schedule[]/platforms[] (Hermes wire shape) in autoSchedulePosts

v0.1.12.13's auto-scheduler wrote ZERO `scheduled_posts` rows on live campaign `mkt_ad75ad56` despite all 14 posts being approved. Root cause: two field-name mismatches between the code and the actual Hermes wire payload. Hermes emits `primary_output.schedule[]` (not `weekly_schedule[]`) and `entry.platforms[]` flat strings (not `entry.platform_targets[].platform` objects). `readWeeklySchedule` returned an empty array every time, logging `autoSchedulePosts skipped — no weekly_schedule`. Fix: prefer `schedule` key, fall back to `weekly_schedule`; prefer `platforms` flat strings, fall back to `platform_targets` objects. Four new tests in `marketing-auto-schedule.test.ts` pin both shapes.

## v0.1.12.13 — feat(marketing): auto-schedule approved posts in autonomous mode with per-brand + per-platform + per-timezone timing

A fresh one-off campaign on aries.sugarandleather.com after v0.1.12.12 completed all four pipeline stages cleanly (research → strategy → production → publish, 14 min 30 s total, 7 posts × 2 platforms = 14 approved post rows). But `scheduled_at` was NULL on every post and `scheduled_posts` had zero rows: scheduling was by-design manual via drag-to-Calendar, even though every other approval gate self-fires in autonomous mode (`ARIES_AUTO_APPROVE_MARKETING_PIPELINE=1`). The pipeline stopped one click short of the goal.

This release closes the gap with a real, marketing-backed, per-brand + per-platform + per-timezone auto-scheduler that fires on publish-stage completion only when autonomous mode is enabled.

**Per-brand timing.** Hermes's strategist agent already emits `weekly_schedule[].recommended_day` per post, derived from the brand voice + target audience analysis it runs upstream. The scheduler uses that day verbatim instead of overwriting the strategist's editorial intent with generic noise. This is the only brand-aware signal the pipeline produces today; trusting it preserves whatever audience-segment reasoning Hermes did.

**Per-platform timing.** Within the recommended day, the scheduler picks an hour-of-day from `PLATFORM_POSTING_DEFAULTS`: Instagram 11:00, Facebook 13:00+5min stagger (effective 13:05). Both values are tenant-local. The defaults are aggregated from the most-cited public 2024-25 social posting research (Sprout Social annual report, Later's "best time to post" study, Hootsuite Q4 2024 benchmarks) — single-hour peaks of median engagement across tracked B2C verticals. The 5-minute Facebook offset is deliberate: it keeps a single brief targeting both platforms from landing at a duplicate minute, which Meta's spam heuristics flag as burst posting.

**Per-timezone correctness.** Every wall-clock value flows through `wallTimeToUtc` (DST-safe, IANA-zone aware) anchored to the tenant's business timezone from `business_profile.timezone`. Tenants without a configured timezone fall back to `DEFAULT_TENANT_TIMEZONE` ('America/New_York'). The test suite pins this: a Monday 11:00 Instagram post in `Asia/Tokyo` lands at 02:00 UTC, not the 15:00 UTC you'd get in America/New_York DST.

**Campaign window enforcement.** Derived timestamps are clamped inside `[max(now, campaign_start), campaign_end]`. Posts whose recommended day already passed in the current week fall forward to the next occurrence inside the window. Posts whose recommended day never falls inside a very short window (e.g. a 2-day Monday-Tuesday campaign that wanted Sunday) fall back to the first available day rather than being silently dropped. A closed-or-empty window returns every row as skipped with a typed reason.

**New backend.** `backend/marketing/auto-schedule.ts` exports:
- `PLATFORM_POSTING_DEFAULTS` — the citation block above lives here so future override layers stay one read away from the rationale.
- `computeAutoScheduleSlots(input)` — pure function with no DB, no clock, no env reads. Deterministic given inputs.
- `autoSchedulePosts(input)` — wraps the pure function with `upsertScheduledPost` writes. Per-row upsert failures are collected and returned; one post failing must not block siblings from being scheduled.

**Wiring.** `synthesizePublishPostsOnCompletion` in `backend/marketing/hermes-callbacks.ts` now calls `autoScheduleApprovedPostsForJob` after synthesis succeeds, behind `isAutoApproveMarketingPipelineEnabled()`. Reads `weekly_schedule[]` for the strategist's per-post `recommended_day`, joins against the synthesized post rows by ordinal, resolves tenant timezone via `getBusinessProfile`, and bulk-upserts. The whole step is wrapped in a try/catch — a schedule failure must never roll back synthesis. One audit log line records `{scheduled, skipped, errors}` for dispatcher correlation.

**Tests.** 16 new tests in `tests/marketing-auto-schedule.test.ts` pin the platform defaults, the per-platform staggering (2h gap minimum for same-day IG+FB), the per-day routing (different recommended_days land on different calendar dates), the past-day fall-forward, the missing-day fallback, the per-timezone correctness (Tokyo vs New York), the campaign-window clamping (no past timestamps, no over-end timestamps, no schedules on a closed window), unsupported-platform skipping with typed reasons, and the DB writer's per-row error isolation. Added to `scripts/verify-regression-suite.mjs` so CI exercises them on every PR.

**Scope guard.** Gated behind the autonomous flag so human-approval tenants keep the legacy "approve, then place on Calendar" flow. The synthesized posts in human-approval tenants still get `status='approved'`, just without `scheduled_at` — operator still drags them to the Calendar manually.

**Out of scope (this PR).** Per-tenant override of platform windows (would be a `posting_strategy` field on `business_profile`; defaults are the v1 floor). Reschedule on brief edit / regenerate. Performance-data-driven re-ranking (no historical engagement signal exists yet on this deployment).

## v0.1.12.12 — fix(ops): bump HERMES_RUN_TIMEOUT_MS 600s → 1200s to match real production-stage cost

`/api/marketing/jobs/<id>/retry-research` succeeded in v0.1.12.11 on `mkt_3e04f5d1` and the pipeline progressed: research finished in ~2 min, strategy in ~1 min, and production submitted to the Hermes content-generator (port 8655). Then **Aries timed out at exactly 600s and recorded `hermes_gateway_timeout`** — but checking the Hermes gateway directly proved this was a false alarm. The completed run `run_2d0516acfd10425fb5a64f489aef71d3` was sitting in Hermes at `status=completed` with all 7 content posts, all 7 generated image files (cached on disk at `~/.hermes/profiles/aries-content-generator/cache/images/openai_codex_gpt-image-2-low_20260527_19*.png`), and a pending `approve_publish` checkpoint pointing at Aries marketing approval id `mkta_2257fdb2-4c08-4e5f-8c7b-1bfa0446252a` (the `mkta_*` prefix is the Aries approval_id format from `backend/marketing/approval-store.ts`, separate from the Hermes provider `resume_token` that gets carried alongside it). The end-to-end production duration was **10 min 39 s**. Aries fired the timeout 38 seconds before Hermes returned.

**Fix.** `HERMES_RUN_TIMEOUT_MS` in `docker-compose.yml` raised from 600_000 ms to 1_200_000 ms (20 min). One line, env-override-friendly. Real one-off campaigns with 7 image renders now have plenty of headroom. The previous 600s budget was tuned to research/strategy (3-8 min observed) and never accounted for production's variable image-generation cost.

**Documented in-place.** The compose comment now records the observed split (`research ~2 min / strategy ~1 min / production 10 min 39 s on mkt_3e04f5d1`) so the next operator who hits a slow tenant has the actual numbers to calibrate against. The 120_000 code default in `backend/marketing/ports/hermes.ts` stays as the synthetic-test fallback — production deployments always override via compose.

**No code changes.** This is a pure ops fix; no app code or tests changed. The existing per-stage retry UX from v0.1.12.11 still applies if production fails for real — the user clicks Retry research → research re-runs → strategy/production re-submit with the new generous timeout. Production-stage retry button is queued as a follow-up if the failure mode repeats.

## v0.1.12.11 — feat(marketing): add Retry-research button for failed campaigns

A failed-state campaign with `current_stage === 'research'` previously gave the operator no recovery affordance — only "Edit brief" was available, forcing the user to abandon the campaign and create a new one from scratch. Hit firsthand on `mkt_3e04f5d1-*` during slice-A QA: Hermes research died with `'NoneType' object is not iterable` and the workspace UI had nothing to click.

**New backend.** `resetStageForRetry(doc, stage)` in `backend/marketing/runtime-state.ts` clears a failed stage record (status → `not_started`, errors → `[]`, run_id/summary/outputs/artifacts wiped) and resets the top-level error pointers (`doc.last_error` only if it referenced this stage; sibling-stage errors stay). The doc returns to `state='queued' status='pending'` so `isPipelineActive()` flips back true. Per the resumability rule, sibling completed stages keep all their artifacts — only the failed stage is reset. Returns `false` (no-op) if the stage isn't actually failed, so callers can surface a 409 instead of silently re-running an in-progress or completed stage.

**New orchestrator entry point.** `retryFailedResearchStage(jobId)` in `backend/marketing/orchestrator.ts` is the public retry API. Loads the doc, validates `state === 'failed' && current_stage === 'research'`, calls `resetStageForRetry`, persists, and re-enters `runResearchStage`. Returns a typed `RetryResearchStageResult` discriminated union (`{ok: true, status: 'submitted'}` or `{ok: false, reason: 'not_found' | 'not_failed' | 'wrong_stage' | 'execution_failed', message}`) so the HTTP handler maps directly to status codes.

**New route.** `POST /api/marketing/jobs/[jobId]/retry-research` enforces the same per-tenant + per-role permission rule as delete/restore (tenant_admin or the original creator). 404 on missing OR cross-tenant (no existence leak), 403 on insufficient role, 409 on wrong-state, 502 on orchestrator submission failure, 200 with `{jobId, retryStatus: 'submitted'}` on success. Invalidates the cached job-status response so the next dashboard fetch sees fresh state.

**New UI.** `RuntimeStatusSurface` in `frontend/aries-v1/campaign-workspace.tsx` conditionally renders a "Recovery → Retry the research stage" `ShellPanel` when `marketing_job_state === 'failed' && marketing_stage === 'research'`. POSTs to the new route, shows an inline error block on failure, hard-reloads the page on success so the next render reflects the resubmitted state.

**Tests.** 9 new tests in `tests/marketing-job-retry-research.test.ts`:
- `resetStageForRetry` happy path (status reset, errors cleared, history entry recorded)
- `resetStageForRetry` returns false for non-failed stages (no-op)
- `resetStageForRetry` preserves sibling-stage completed artifacts (resumability rule)
- Handler returns 404 on missing job
- Handler returns 404 (not 403) on cross-tenant — existence leak guard
- Handler returns 403 for non-admin, non-creator
- Handler returns 409 with `marketing_job_retry_not_failed` reason when state isn't failed
- Handler returns 409 with `marketing_job_retry_wrong_stage` reason when failure was on a non-research stage
- Permission helper unit test for the full matrix (admin / creator / non-creator / cross-tenant / legacy null-creator)

`npm run typecheck` clean, `npm run verify` 38 tests pass.

## v0.1.12.10 — fix(ui): plug 3 missing enum cases and 2 raw-status display gaps

Five Aries-side polish bugs found by three parallel Explore subagents auditing Posts/Calendar, Results/Campaigns, and Settings/Brand Kit while a slice-A QA campaign was in flight. All five are the same bug class fixed across v0.1.12.3-9: widening-union grep-inequality and state-derived copy that lowercased itself via `.replace('_', ' ')`. Each fix has regression tests pinning the enum-to-label mapping so the next status value to land in the union doesn't silently render as "Accepted" or "Sent" or render with `width: undefined%`.

**Fix 1 — Calendar event chip handles every dispatch status, not just three.** `frontend/aries-v1/presenters/calendar-presenter.tsx:832-838` had a 3-arm ternary that fell through to the literal `'Sch'` for any value other than `dispatched`/`failed`/`in_flight`. `'pending'` and `'skipped'` from the scheduled-posts worker silently inherited the neutral fallback. New centralized `formatDispatchStatusChip()` in `frontend/aries-v1/labels.ts` handles every known value explicitly and guarantees the default branch never returns the success label `'Sent'` by accident — pinned by a test that asserts unknown statuses don't get the success copy.

**Fix 2 — Calendar event modal stops lowercasing status copy.** `calendar-presenter.tsx:394` rendered Dispatch status via `dispatchStatus.replace('_', ' ')` which produced "in flight" instead of "In flight" and "pending" instead of "Pending". Routed through `formatDispatchStatusLabel()` with title-case mapping per known value + a title-casing fallback for unknowns.

**Fix 3 — Calendar campaign status chip stops lowercasing.** `calendar-presenter.tsx:344` rendered `campaign.status.replace('_', ' ')` which produced "published to meta (paused)" instead of "Published to Meta (Paused)" and "ready to publish" instead of "Ready to publish". Now uses `formatCampaignStatusLabel()` which delegates to the same StatusChip casing used elsewhere in the dashboard.

**Fix 4 — Integration card maps every connection state explicitly during OAuth.** `frontend/settings/platform-card.tsx:65-71` had a 4-arm ternary on `connection_state` that fell through to `'accepted'` (an info-blue "Accepted" badge) for both `'not_connected'` AND `'connection_pending'`. The latter is the in-flight OAuth handshake — the user saw a misleading "Accepted" badge while the OAuth callback was still in progress. New `connectionStateBadgeStatus()` helper with an exhaustive switch over `IntegrationConnectionState` + an `assertNever` default branch so TypeScript fails the build if a new value lands in the type without a case. `connection_pending` now renders as `'in_progress'` (info-blue "In progress"), `'not_connected'` renders as neutral `'unknown'`.

**Fix 5 — Campaign list stage-progress bar never renders `width: undefined%`.** `frontend/aries-v1/presenters/campaign-list-presenter.tsx:302-317` had a switch over `AriesCampaignStatus` covering 6 of 7 enum values — `'rejected'` had no case and there was no default branch, so `stageProgress()` returned `undefined` and rendered as literal `width: undefined%` in the CSS. Added `case 'rejected': return 0` (terminal failure, not "almost done") and `default: return 0` so future widenings stay valid.

**New module.** `frontend/aries-v1/labels.ts` is the single source of truth for runtime-status-to-label mappings. Future enum values land here first and every screen stays in sync without inventing its own `.replace('_', ' ')` fallback.

**Tests.** 13 new tests in `tests/aries-v1-labels.test.ts` pin every known enum-to-label mapping, prove the fallback never returns the success label for unknown values, prove `stageProgress` returns 0 (not undefined) for rejected + unknown values, and walk the full `integration_connection_state_values` enum proving every value maps to a real badge. `npm run typecheck` and `npm run verify` (38 tests, 0 failures) both green.

## v0.1.12.9 — fix(ux): drop semantic mismap for Strategy Review summary; "Published and paused" replaces "No preview or destination yet" for paused ads

Two happy-path UX issues found by a parallel-agent audit of the Strategy/Creative review flows and the Posts page.

**Fix 1 — Strategy Review summary no longer falls back to `objective`.** `buildStrategyReview` in `backend/marketing/workspace-views.ts` previously fell back to `reviewPacket?.objective` when `campaignPlan?.core_message` was missing. That's a semantic mismap: an objective ("drive 50 demo bookings this month") is not a summary ("we own the calm weekly social content lane"). On a campaign where core_message is blank but objective exists, the Strategy Review header would display the objective text where reviewers expect the core positioning. Removed the `objective` fallback so the generic "Review the campaign proposal before creative production is treated as approved." default fires instead.

**Fix 2 — Paused-ad posts read accurately.** `frontend/aries-v1/posts-screen.tsx` rendered a pause icon for `published_to_meta_paused` posts but the adjacent text still said "No preview or destination yet" — confusing because paused ads HAVE been published, they just aren't actively running. Now reads "Published and paused" with the pause icon; non-paused no-preview cases keep the original wording.

## v0.1.12.8 — fix(workspace): Launch Status surfaces upstream failure instead of "preparation is still running"

Live audit on the Launch Status tab of a failed campaign found it titled "Launch preparation is still running" with the description "Launch review and publishing happen in the final stage." — both contradicted the red "pipeline reported a failure or blocked state" banner directly above. The fallthrough branch in `derivePublishSurfaceState` (frontend/aries-v1/campaign-workspace-state.ts) was unconditional regardless of upstream failures.

**Fix.** New branch in `derivePublishSurfaceState`: when any `stageCard.status === 'failed'`, return `Launch halted by <stage> failure` with the failed stage's summary (already status-aware after v0.1.12.3) as the description. The original "still running" copy remains as the fallthrough for non-failed runs that genuinely are preparing.

**Tests.** Two new cases in `tests/campaign-workspace-state.test.ts`: (1) production-failed stage card surfaces "halted ... failure" title with failure detail in description; (2) all-non-failed (in_progress) stages still get the original "still running" copy. The narrow check ensures the new branch can't false-positive on healthy preparing campaigns.

## v0.1.12.7 — fix(review-queue): failed jobs no longer appear under "Strategy review ready" / "Brand review ready"

Live audit on the `/review` page found the review queue listing campaigns that had FAILED the strategy stage under the headers "Strategy review ready" / "Brand review ready". Clicking through showed an approval form with no actual approvable content (`Channel plan: Incomplete: generated artifacts do not yet contain this section.`) — the pipeline never produced anything to approve because the stage failed before generating output. Reviewers got an empty review screen they couldn't action.

**Fix.** `buildReviewItemsForJob` in `backend/marketing/runtime-views.ts` now returns an empty array early when the underlying runtime doc has `state === 'failed'` OR `status === 'failed'`. Failed campaigns remain visible through the campaigns list and their workspace surface (where v0.1.12.3 surfaces the actual failure reason). The review queue only shows items where there's content to approve.

**Tests.** New `tests/marketing/review-queue-skips-failed-jobs.test.ts` — 3 cases pin (1) state=failed jobs are filtered, (2) status=failed (even without state=failed) is also filtered, (3) healthy non-failed jobs pass through without the filter excluding them. Wired into verify suite.

## v0.1.12.6 — fix(ui): "Preview archived" replaces "Preview unavailable" for failed image previews

Live audit found 20+ campaign cards on the dashboard rendering the alarming "PREVIEW UNAVAILABLE" placeholder. Investigation showed they were all older campaigns whose image creatives 404 on `/api/internal/hermes/media/<basename>` — the Hermes cache aged out, OR the basename is no longer in the tenant's runtime docs (the route returns 404 in both cases by design, to avoid leaking existence — see `app/api/internal/hermes/media/[...path]/route.ts` line 119). Either way, the asset is gone for good; calling that "unavailable" reads like a bug.

**Fix.** `frontend/components/media-preview.tsx` and `frontend/components/video-preview.tsx` now render "Preview archived" with an Archive icon when `failed` is true on a real `src`. The "Preview pending" copy for missing `src` and the "Open asset preview" copy for non-image content types are unchanged.

The rendered failure UI is otherwise identical (same layout, same muted styling), so this is purely a copy + icon change. No backend change. No tests had been asserting on the old phrase.

## v0.1.12.5 — perf(dashboard): same bounded-parallel fix for the Recycle Bin (deleted campaigns list)

v0.1.12.4 sped up the live campaigns list and the review queue but missed `listDeletedMarketingCampaignsForTenant`, which is called in parallel with `listMarketingCampaignsForTenant` by `GET /api/marketing/campaigns`. Live benchmark after v0.1.12.4 shipped showed `/api/marketing/campaigns` still spending 29.6s — that was the Recycle Bin loader, still serial over the 17 soft-deleted jobs on this tenant. Applied the exact two-phase fan-out pattern from v0.1.12.4 here too. Concurrency=4, same DB-pool reasoning. No new helper added — just reuses `processConcurrent`.

## v0.1.12.4 — perf(dashboard): bounded-parallel fan-out cuts /api/marketing/reviews from 24-36s to single-digit seconds

Live audit found `/api/marketing/reviews` and `/api/marketing/campaigns` taking 24-36 seconds in production, hanging the campaigns dashboard on "Loading…". Root cause: both endpoints iterated the tenant's job list (30+ jobs for active tenants once history is included) with serial `await` loops, each iteration doing `loadMarketingJobRuntime` + `getMarketingJobStatus` + `buildCampaignWorkspaceView` + `buildReviewItemsForJob` — total wall-clock = sum of every per-job cost.

**Fix.** New `lib/process-concurrent.ts` exports `processConcurrent(items, fn, concurrency)` — an order-preserving bounded-parallel map. Two hot paths in `backend/marketing/runtime-views.ts` now use it with `concurrency=4`:
1. `listMarketingReviewQueueForTenant` (powers `/api/marketing/reviews`, the dashboard's primary load).
2. `listMarketingCampaignsForTenant` (powers `/api/marketing/campaigns`, the recycle-bin/list view).

Concurrency was deliberately chosen against `DB_POOL_MAX=20` (docker-compose default) and `ARIES_WEB_CONCURRENCY=2` worker count. With 4 in-flight per request × 2 workers = 8 connections peak per container, well under the pool ceiling. This satisfies CLAUDE.md guardrail #1 (don't blindly Promise.all DB chains).

**Order preservation.** `processConcurrent` returns results in input-order so the dedup `Set` and the final `sort()` in `listMarketingCampaignsForTenant` behave identically to the serial version. A wall-clock 6×50ms benchmark in the helper test confirms results in <200ms (vs. ~300ms serial).

**Tests.** New `tests/process-concurrent.test.ts` — 9 cases pinning: input-order preservation, empty input, concurrency=1 = serial, concurrency cap is respected, wall-clock speedup vs serial, error rejection after in-flight settles, concurrency > items length clamps safely, invalid concurrency (0, negative) clamps to 1, index argument matches position. Wired into the verify regression suite.

**Out of scope.** Deeper optimization (caching `loadMarketingJobRuntime` within a single request, SQL-level filtering of obviously-no-pending-review jobs, dedup-then-fetch ordering) is left for a future pass — bounded parallelism is the lowest-risk win and should bring response times into single-digit seconds without restructuring the per-job code path.

## v0.1.12.3 — fix(workspace): stage-card summaries respect actual status (no more "Production assets are ready" on a failed run)

Live UI audit after the v0.1.12.2 deploy found a contradictory Runtime Status card on the failed campaign mkt_2088bccf: the stage label correctly said `Production failed` (red), but the description directly below said `Production assets are ready.` The same pattern was latent on every stage — fallback summaries were hardcoded happy-path strings, used regardless of the actual stage status, so any failed or in-progress stage that lacked a runtime-provided summary would silently claim it had completed.

**Root cause.** `buildStageCards` in `backend/marketing/jobs-status.ts` did `stageRecord.summary?.summary || 'Production assets are ready.'` (and three peers for research/strategy/publish). When `stageRecord.summary` was null (the common case for stages that never wrote a summary), the fallback was always the success copy. The QA report from v0.1.12.2 had already flagged this as a deferred cosmetic — promoted to a real fix here because it is the single most visible "doesn't look professional" item on the dashboard once a Hermes run fails.

**Fix — `defaultStageSummary(stage, status, errors)` helper.** Exported state-aware fallback that picks copy based on the normalized status:
- `failed`: surfaces the last error message verbatim (`Production failed: Hermes gateway timeout after 600000ms.`) when present, otherwise generic `<Stage> failed. Review the runtime status and try again.` Blank-message errors fall through to the generic copy so we never render `failed:   `.
- `running` / `in_progress`: `<Stage> is running.` (no more "is ready" while still working).
- `pending` / `queued` / `ready` / empty: stage-specific "has not started yet" copy. (Note: `ready` on the publish stage means "waiting for production to finish", not "publish completed" — the helper treats it as pending.)
- `completed`: original happy-path strings preserved bit-for-bit.
- Status comparison is case-insensitive (`FAILED`, `Failed`, `failed` all behave identically).

All four `buildStageCards` cases now thread through this helper. The `firstBrandAnalysisGate` strategy override and `buildProductionContractHighlightFallback` highlight pathway are untouched.

**Tests.** New `tests/marketing/stage-summary-state-aware.test.ts` — 15 cases pinning the exact regression: `production + failed` never contains "are ready" and always contains "failed"; the last error message reaches the rendered summary verbatim; happy-path strings remain bit-for-bit identical for `completed` status so the deploy is invisible to healthy campaigns; running, in_progress, pending, empty-status, and blank-error-message cases all return appropriate non-contradictory copy; status comparison is case-insensitive. Wired into the verify regression suite.

**Out of scope.** The dashboard's `/api/marketing/reviews` endpoint takes 24-36 seconds to respond in production (separate perf bug surfaced during the same audit); the older campaigns showing "Preview unavailable" for image creatives (Hermes media mount path mismatch); the underlying `hermes_gateway_timeout` on the production stage that made the bad copy visible in the first place. All tracked as separate initiatives.

## v0.1.12.2 — fix(marketing): Strategy Review channel plan renders per-platform instructions

Surgical follow-up to v0.1.12.1. Live slice-A QA on `aries.sugarandleather.com` (mkt_32acd5cc-*) found the Strategy Review's Channel plan section still rendering `"Incomplete: generated artifacts do not yet contain this section"` even though `strategy.primary_output.channel_adaptation` was fully populated with real per-platform guidance for instagram and facebook. The other v0.1.12.1 wins (positioning, 7 proposed posts with hook+body+CTA+format+platforms, creative direction) rendered correctly — this was the single rendering gap that slipped through.

**Root cause.** `primaryOutputToCampaignPlanner` (added in v0.1.12.1) produces `channel_plans` entries with shape `{platform, instructions}` — derived from `Object.entries(channel_adaptation)`. `strategyChannelBlock` in `backend/marketing/workspace-views.ts` only inspected the legacy field set (`goal`, `message`, `creative_bias`, `cta`). With none of those fields present on the adapter's output, every block produced an empty string; `.filter(Boolean)` then dropped all entries; the resulting empty `channelPlans` array fell through to `ARTIFACT_INCOMPLETE_TEXT`. The v0.1.12.1 tests asserted the adapter's output shape but never fed it through the renderer, so the bug shipped silently.

**Fix.** When the legacy field set yields no detail blocks, fall back to rendering `channel.instructions` verbatim. Same honesty-over-mismapping pattern as the D2 decision from the v0.1.12.1 eng review (don't map `creative_direction` onto `objective`).

**Tests.** `strategyChannelBlock` is now exported and pinned by four new tests in `tests/marketing/workspace-views-primary-output.test.ts`: platform+instructions input renders a non-empty block with the channel name uppercased; an end-to-end run through the adapter against the real `marketing-runtime-primary-output.json` fixture produces non-empty blocks for every channel (the exact regression that mkt_32acd5cc surfaced); legacy `goal`/`message`/`cta` shape still renders unchanged; empty input still returns empty string. The end-to-end test specifically would have caught this in v0.1.12.1.

**Out of scope.** The same QA run hit a separate `hermes_gateway_timeout` (run did not reach terminal status within 600000ms) on the production stage, which prevented publish from running and made slice C dormancy + creative-review hook surfacing untestable. That's a Hermes-side content-generator profile issue, tracked separately. Stale "Production assets are ready." copy displayed alongside a failed production status was also flagged — separate cosmetic follow-up.

## v0.1.12.1 — fix(marketing): surface real strategy content after Hermes 3-profile decomposition

Operators were running clean end-to-end campaigns and getting the wrong picture: Strategy Review showed the "Strategy review will open here" placeholder even after the strategy stage completed, every Creative Review card said `Ad hook: Unavailable: not present in generated artifacts`, and the publish auto-approve guardrail (slice C, shipped in PR #474) never fired because it was looking for fields Hermes does not emit. The pipeline was actually generating high-quality content the whole time — positioning, channel adaptation, 7 fully-spec'd posts with hooks, body, CTA, and visual prompts — but Aries was reading the wrong fields.

**Root cause.** Hermes recently decomposed from one monolithic agent into 3 specialized profiles (research / strategist / content-generator). The new profiles write all stage output into `stages.<stage>.primary_output` (flat keys like `positioning`, `channel_adaptation`, `content_package[]`, `preflight_check{...}`). Aries' workspace-views, asset-library, publish-review, and slice C guardrail all still read `stages.<stage>.outputs.*` filesystem-path keys (`campaign_planner_path`, `strategy_review_path`, etc.). With those paths empty, every reader fell through to a placeholder.

**Fix — primary_output reader alignment, 4 sites unified through one helper.** New `resolveStageOutput(doc, stageName)` in `backend/marketing/runtime-state.ts` returns `outputs.*` if non-empty, else `primary_output`, else null. Strict precedence keeps any legacy pre-decomposition runtime doc working unchanged. The 4 holdout readers now go through this helper:

1. `backend/marketing/workspace-views.ts` `loadStagePayloadBundle` — new `primaryOutputToCampaignPlanner` and `primaryOutputToProductionPreview` adapters synthesize the legacy `{campaign_plan:{...}}` / `{review_packet:{...}}` / `{production_handoff:{production_brief:{...}}}` shape that `buildStrategyReview` consumes. `creative_direction` is NOT mapped onto `campaign_plan.objective` (semantically wrong); `campaign_plan.objective` stays empty under the new schema and a new "Creative direction" section renders the styling guidance honestly.
2. `backend/marketing/workspace-views.ts` `buildStrategyReview` — two new `MarketingReviewSection` entries: "Proposed posts" (renders each `content_package[]` entry with hook + body + CTA + format/platforms) and "Creative direction" (renders the verbatim styling guidance). Operators now see the actual 7 posts the campaign plan produced.
3. `backend/marketing/asset-library.ts` — `Ad hook: Unavailable` fix. Hook lookup falls back to `production.primary_output.content_package[].hook`, then `strategy.primary_output.content_package[].hook`, matched by `post_number` then array index. Real hook text now reaches Creative Review cards.
4. `backend/marketing/publish-review.ts` — production_review_path lookup uses `resolveStageOutput` so the publish-review surface no longer goes dark under the new schema.

**Slice C re-aim.** `findPublishAutoApproveRefusalSignal` in `backend/marketing/hermes-callbacks.ts` previously refused only on `preflight_check.status === 'failed'` and `publish_ready === false`. Real Hermes payloads have no `preflight_check.status` field (only domain booleans like `all_posts_have_assets`, `all_assets_completed`, `all_posts_have_platforms`, `all_posts_have_cta`, `all_posts_have_hashtags`, `approval_safe_language`, `human_review_positioning_preserved`) and `publish_ready: null`. The refusal logic now triggers when any of those 7 booleans is `false`, when `publishing_status` is set and is neither `completed` nor `in_progress`, or when `published_review_status === 'rejected'`. The legacy `publish_ready === false` and `preflight_check.status === 'failed'` checks remain in place so any pre-decomposition payload still refuses. Each refusal logs a precise reason naming which check failed.

**Tests — fixture-pinned regression suite.** `tests/fixtures/marketing-runtime-primary-output.json` is a real runtime doc from a clean end-to-end run on `aries.sugarandleather.com` (mkt_b83fc598). Four new test files exercise 19 paths plus 4 IRON-RULE regressions: `tests/marketing/resolve-stage-output.test.ts` (outputs-wins precedence, primary_output fallback, both-empty → null), `tests/marketing/workspace-views-primary-output.test.ts` (fixture-driven strategy review renders positioning + channels + proposed posts + creative direction, objective stays empty, legacy `outputs.review` payload still works), `tests/marketing/asset-library-primary-output.test.ts` (real hooks appear, production→strategy fallback order), and 17 new slice C tests in `tests/marketing/callback-auto-approve.test.ts` (one per failing preflight boolean, publishing_status mismatches, published_review_status rejected, legacy `publish_ready=false` still refuses, and the healthy mkt_b83fc598 fixture does NOT refuse).

**What this changes for operators.** Brendan creates a campaign on `aries.sugarandleather.com`. Strategy Review tab now renders the real positioning statement, the per-platform channel adaptation, the 7 proposed posts with hooks + body + CTA, and the creative-direction guidance — not "Strategy review will open here". Creative Review cards now carry real hook text. The publish auto-approve guardrail now actually fires when Hermes flags a preflight check, matching the original PR #474 intent. No changes required on the Hermes side.

## v0.1.12.0 — feat(ui): tenant-local timezone for every operator-visible timestamp

Operators were seeing raw UTC ISO strings (e.g. `2026-06-11T03:59:59.000Z`) throughout the dashboard — campaign windows, audit trails, post queues, decision history, and review items all displayed UTC with no indication of the local business time. This shipped a two-piece fix.

**Piece 1: tenant timezone in the next-auth session claim.** The jwt callback in `auth.ts` now calls `loadTenantTimezoneOrFallback(tenantId)` (already in `backend/tenant/business-profile.ts`) after resolving tenant claims and writes the result to `token.timezone`. The session callback projects it to `session.user.timezone`. The `types/next-auth.d.ts` augmentation was extended to cover both `Session.user` and `JWT`. A new `hooks/use-tenant-timezone.ts` wraps the session context read and falls back to `DEFAULT_TENANT_TIMEZONE` when the session is absent (first load, unauthenticated paths, test stubs without a SessionProvider).

**Piece 2: 8 raw-UTC display sites replaced.** Every operator-visible timestamp now calls `formatInTenantZone(value, tz)` + `tenantZoneAbbreviation(value, tz)` from `lib/format-timestamp.ts` (already in the codebase from v0.1.11.x). Files touched: `frontend/marketing/job-status.tsx` (audit trail), `frontend/app-shell/posts-console.tsx` (post queue), `frontend/aries-v1/review-item.tsx` (last decision + decision history), `frontend/aries-v1/campaign-workspace.tsx` (`formatDecisionTimestamp` + audit trail + status history), `frontend/app-shell/dashboard-console.tsx` (campaign window), `frontend/app-shell/calendar-console.tsx` (window label).

**Admin debug panel (special case).** The `/admin/marketing/jobs/[id]/debug` panel already showed UTC correctly for debugging. A `formatTenantTime()` helper was added alongside the existing `formatUtcTime()`; every timestamp in the panel now renders BOTH side-by-side (`2026-06-15 03:59:59 UTC / Jun 14, 8:59 PM PDT`). The `localTimeTooltip()` that previously used browser-tz `toLocaleString()` was replaced with the tenant-tz version.

**Calendar screen consolidation.** `frontend/aries-v1/calendar-screen.tsx` previously derived timezone from `useBusinessProfile({ autoLoad: true })`, adding a redundant API call just for the tz field. Migrated to `useTenantTimezone()` so there is one source of truth.

**Operational note — session claim refresh.** When a tenant changes their configured timezone in business profile settings, existing operator sessions will not see the new zone until they log out and back in. This is inherent to the next-auth JWT claim model: the claim is written once at login and not re-read per request. A logout/login cycle is the documented way to pick up claim changes.

**Tests:** `tests/session-timezone-claim.test.ts` (5 assertions — jwt callback writes token.timezone, session callback projects it, type augmentation covers both interfaces, hook reads from session context with fallback). `tests/ui-timestamps-use-tenant-zone.test.ts` (14 assertions — each of the 8 display files imports `formatInTenantZone`, none use bare `new Date(...).toLocaleString()`, admin panel has both formatters). `tests/admin-debug-panel-timezone-format.test.ts` (5 unit tests — `formatTenantTime` and `formatUtcTime` produce expected strings for `America/Los_Angeles` and `Asia/Tokyo` against a known UTC instant, null-safety).

`npm run verify` 38/38, 24 new tests pass, typecheck clean.

## v0.1.11.5 — fix(marketing): dashboard aggregate views show one_off campaigns

Live QA against v0.1.11.3 + v0.1.11.4 surfaced that `/dashboard/social-content`, `/dashboard/posts`, `/dashboard/results`, and `/dashboard/publish-status` all stuck on `Loading…` once any one_off campaign existed for the tenant. Same FP class as v0.1.11.1: widening the `MarketingJobType` union missed two runtime inequality checks against the string literal `'weekly_social_content'`. TypeScript can't catch them because comparing a literal in an inequality is type-safe regardless of union width.

**Fix 1: `backend/social-content/dashboard-projection.ts:1019`.** The gate
```ts
if (requestedJobTypeFromDoc(runtimeDoc) !== 'weekly_social_content') return dashboard;
```
early-returned the dashboard untouched for one_off campaigns — no posts, no assets, no enrichment. Aggregate routes then waited on a Promise.all chain that produced empty data the client could not render past a spinner. Widened to:
```ts
const reqJobType = requestedJobTypeFromDoc(runtimeDoc);
if (reqJobType !== 'weekly_social_content' && reqJobType !== 'one_off_campaign') return dashboard;
```

**Fix 2: `backend/marketing/runtime-views.ts:1093`.** `isWeeklySocialContent = requestedJobType === 'weekly_social_content'` flipped to false for one_off, which made `isLaunchReviewCheckpoint = workflowStepId === 'approve_stage_4' && !isWeeklySocialContent` true — routing one_off approvals to a launch-review surface that the social-content pipeline doesn't render. Widened the discriminator to include one_off so the approval surface uses the same firstCheckpoint sections weekly does.

**Tests:** `tests/dashboard-projection-one-off-gate.test.ts` (3 assertions). Source-level checks that both gates include the one_off literal, plus a defensive `doesNotMatch` for the single-literal `!== 'weekly_social_content'` shape so a future revert is loud.

**Operational learning, reiterated:** every string-literal union widening needs a site-wide grep for `=== '<oldvalue>'` and `!== '<oldvalue>'`. This is the third PR in the v0.1.11.x series that fixed this exact FP class (v0.1.11.1 fixed startMarketingJob, v0.1.11.2 fixed the campaign-window override, this fixes dashboard-projection + runtime-views). The grep should be a checklist item on every type-union widening from now on.

`npm run verify` 38/38, 3 new tests pass, typecheck clean.

## v0.1.11.4 — fix(marketing): one_off campaigns actually publish (publishingRequested=true)

**Bug (P0):** Live QA (job `mkt_8d89b7a4`, tenant 15) showed a fully-completed one_off_campaign pipeline where the publish stage finished with `"Publish skipped: publishing not requested."` and zero `scheduled_posts` rows were written. The feature was decorative — nothing published.

**Root cause (`backend/marketing/orchestrator.ts:1635-1637`):**
`startMarketingJob` called `ensureSocialContentRuntimeState(doc)` with no `input` argument for both `weekly_social_content` and `one_off_campaign` jobs. `ensureSocialContentRuntimeState` fell through to `requestedPublishFlag(doc)`, which looks for explicit publish-intent keys (`publishRequested`, `livePublishRequested`, `livePublishPlatforms`, etc.) in `doc.inputs.request`. One-off campaign payloads never set any of those keys, so `publishingRequested` defaulted to `false`. In `hermes-callbacks.ts`, `!isSocialContentPublishApprovalRequired(doc)` evaluated to `true` and the publish stage was skipped entirely.

**Fix:** Pass `publishingRequested: true` when `jobType === 'one_off_campaign'`. One-off campaigns have no preview-then-approve cycle — they are always meant to publish. Weekly campaigns continue to derive the flag from `requestedPublishFlag(doc)` (unchanged).

**Regression tests added:**
- `tests/start-marketing-job-entry-guard.test.ts`: source-level assertion that the `ensureSocialContentRuntimeState` call passes `publishingRequested=true` when `jobType === 'one_off_campaign'`.
- `tests/one-off-campaign-orchestrator.test.ts`: two unit tests — one asserting `publishingRequested=true` for a one_off doc with no publish keys, and one asserting weekly behaviour (with and without `livePublishPlatforms`) is unaffected.

**Post-deploy verification:** submit a fresh one_off_campaign via the dashboard; after all four stages complete, `SELECT * FROM scheduled_posts WHERE ...` should have rows, and the publish stage note should NOT be "Publish skipped: publishing not requested."

## v0.1.11.3 — feat(marketing): replace native date inputs with month/day dropdowns + auto year

Two pain points with the v0.1.11.2 native `<input type="date">` fields:

1. **Chrome automation input corruption.** Browser automation agents (pair-agent at read+write scope, no JS exec) fill date inputs via simulated keypresses. Chrome reads chars per MM/DD/YYYY segment — "2026-06-14" becomes "0004-02-06". The React-native-setter workaround requires JS exec, which those agents don't have.

2. **Year navigation overhead.** One-off campaigns overwhelmingly happen within the current year. Native date pickers force operators through year selection on every use.

**Solution: `MonthDayPicker` component** (`frontend/marketing/month-day-picker.tsx`). Two `<select>` dropdowns (Month, Day) that browser automation can interact with reliably via click + select. Hidden year state defaults to `currentYear`. A third Year dropdown appears **only when today is within 30 days of Dec 31** (so a December operator can schedule a January campaign), offering `[currentYear, currentYear+1]`.

Day options recompute on month/year change; if the selected day exceeds the new month's max (e.g. day=31 then switch to April), the day clears and `onChange` emits `''`. `onChange` emits `''` until both month and day are set, then emits `YYYY-MM-DD` with zero-padded fields.

Server-side year-range and past-date validation from v0.1.11.2 is preserved unchanged — the component prevents bad-year input by construction but the server remains the source of truth.

12 new tests in `tests/month-day-picker.test.ts` cover: emit contract, leap-year day count, day clamping on month change, year-selector visibility (hidden June, visible Dec), year default, value prop parsing, and zero-padding.

## v0.1.11.2 — fix(marketing): one-off dashboard window + date input hardening

Live QA against v0.1.11.1 caught two further bugs in the one_off_campaign flow. Both are display/validation bugs; no schema changes or pipeline changes are required.

**Bug 1 (P1, dashboard).** A successfully-created one_off campaign rendered a 7-day weekly window on the dashboard (today + 6 days) instead of the operator's chosen `campaignEndDate`. Root cause: `backend/marketing/jobs-status.ts:1543` computed `isWeeklySocialContent` via a local `requestedJobTypeFromDoc` that is hardcoded to always return `'weekly_social_content'`. This hardcode is intentional for pipeline routing — one_off campaigns ride the weekly Hermes pipeline by design premise P3 — but the same flag was also gating the display-only weekly calendar snapshot. `buildWeeklyCalendarSnapshot` always ran, always produced a `campaignWindow` of `{ start: today, end: today+6d }`, and the `weeklySnapshot?.campaignWindow ?? ...` fallback always picked that value before `buildCampaignWindow` (which correctly reads `oneOff.campaignEndDate` for one_off docs) could supply the authoritative date.

Fix (Option B — smallest blast radius): added `&& runtimeDoc.job_type !== 'one_off_campaign'` to the `isWeeklySocialContent` guard at line 1543. The hardcoded `requestedJobTypeFromDoc` is left untouched; all Hermes pipeline routing remains unaffected. One_off docs now fall through to `buildCampaignWindow` which surfaces `{ start: milestoneDate|null, end: campaignEndDate }` as designed in v0.1.11.0.

**Bug 2 (P1, date inputs).** Browser-automation-driven input corruption during QA produced `"0004-02-06"` in the campaign end date field. The existing YYYY-MM-DD regex `/^\d{4}-\d{2}-\d{2}$/` matched year 0004, so the server accepted and converted the garbled value. Three layers of hardening added:

1. **Server-side year-range guard** (`app/api/marketing/jobs/handler.ts:validateAndConvertOneOffBrief`): rejects any date whose year is outside `[currentYear - 1, currentYear + 10]`. Error message: "Date must be a current or near-future year (between YYYY and YYYY)." Applied to both `campaignEndDate` and `milestoneDate`.

2. **Server-side past-date guard** (same function): rejects `campaignEndDate` that is already in the past relative to now in the tenant timezone. Today is fine; yesterday is not. Error message: "Campaign end date must be in the future."

3. **Client-side UX** (`frontend/marketing/new-job.tsx`): both `<input type="date">` elements get `min={todayStr}` and `max={today+5years}` so the native picker greys out obviously invalid dates. Additionally, if the year in the typed value is outside `[currentYear, currentYear+5]` the submit handler sets an inline client-side field error and blocks the POST without a round-trip.

**Tests added.**

- `tests/one-off-campaign-dashboard-window.test.ts` (5 tests): pins that `isWeeklySnapshotPathForTests` returns `false` for one_off docs (and `true` for weekly), that `buildOneOffCampaignWindowForTests` returns the authoritative `campaignEndDate` unchanged, and that `buildSocialContentDashboardProjection` returns the dashboard object untouched for one_off docs (early-exit guard).
- `tests/one-off-campaign-form-validation.test.ts` (+5 tests, 14 total): past date rejected, ancient year (0004) rejected with "current or near-future year" message, far-future year (current+15) rejected, within-range future date accepted, ancient year on `milestoneDate` rejected.

Year bounds in tests are computed from `new Date().getFullYear()` so they don't go stale.

`npm run verify` 38/38, 10 new tests pass (5 Bug 1 + 5 Bug 2), typecheck clean, banned-patterns clean.

## v0.1.11.1 — fix(marketing): startMarketingJob entry guard accepts one_off_campaign; client-side form errors render inline

Live QA against v0.1.11.0 (and v0.1.10.0 before it) caught two production bugs that the prior coverage missed.

**Bug 1 (P0, production-blocking).** `backend/marketing/orchestrator.ts:1597` hardcoded `input.jobType !== 'weekly_social_content'` as the runtime guard and threw `unsupported_job_type:<value>` for every other value. The v0.1.10.0 type union widening (and v0.1.11.0 rename to `one_off_campaign`) updated TypeScript signatures but missed this runtime inequality check. TypeScript was happy because a literal compared in an inequality is type-safe regardless of union width; the runtime silently rejected every one-off submission. End-to-end result: the form rendered the validation surface correctly, the server accepted the early job-type guard at the handler, but the orchestrator entry rejected the call before any job ID was created. No campaigns, no scheduled posts, no Hermes research stage — the feature was a dead end in prod.

Fix: widen the guard to accept both `'weekly_social_content'` and `'one_off_campaign'`, enumerated explicitly so a future widening must reach this site.

**Bug 2 (P0, same code path).** `backend/marketing/orchestrator.ts:1628` set up the `social_content_runtime` block only when `input.jobType === 'weekly_social_content'`. One-off campaigns ride the same Hermes pipeline per design premise P3, so downstream code reads `social_content_runtime` and crashes when it's absent. Widened to also run for `one_off_campaign`.

**Bug 3 (P1, UX).** `frontend/marketing/new-job.tsx` client-side validation called `setErrorText('<single message>'); return;` for the first missing field and short-circuited before the POST. The form's existing inline 422 error renderers (server-side) never fired because the round trip never happened. Operators submitting an empty one-off form saw a single top-level alert instead of inline red errors under each missing field. Fixed by aggregating client-side errors into a new `clientFieldErrors` state keyed by the same `oneOff.<field>` shape the server returns from 422, and merging client + server errors via a `oneOffFieldError(key)` helper at every inline-error JSX site.

**Coverage gap addressed.** The orchestrator unit tests in v0.1.10.0 and v0.1.11.0 called `buildEventBriefForArgs` / `buildOneOffBriefForArgs` directly and asserted return shape — they never exercised the `startMarketingJob` entry. The plan-eng-review coverage diagram flagged `[→E2E]` paths as user-flow tests, and we treated them as optional. They were not. Adds `tests/start-marketing-job-entry-guard.test.ts` (3 source-level assertions): the accept-list enumerates both supported job types, the runtime-state-setup conditional covers both job types, and no residual `'event_campaign'` literal remains. Cheap, durable, would have caught both P0 bugs.

Operational learning logged: widening a string-literal type union requires grepping for every inequality check (`!== 'oldvalue'`) and every equality check against literal values, because TypeScript will not error on them.

`npm run verify` 38/38, 3 new tests pass, typecheck clean.

## v0.1.11.0 — feat(marketing): generalize one-off campaigns beyond hackathon-shaped fields

v0.1.10.0 shipped `event_campaign` with five required fields baked in for the hackathon forcing example (`eventName`, `eventDate`, `registrationDeadline`, `campaignEndDate`, `cta`). This renames and reshapes the whole feature so it cleanly fits every one-off campaign shape -- flash sales, product launches, webinars, hackathons, fundraisers -- without per-type code.

**Why the old shape was wrong.** A flash sale doesn't have a "registration deadline." A product launch doesn't have an "event date" in the hackathon sense. The original fields forced operators to either fill nonsense values or stretch the meaning of the labels. The load-bearing piece (`campaignEndDate` driving the worker auto-stop) was already generic; only the operator-facing field names were hackathon-flavored.

**The new shape.** `MarketingJobType: 'weekly_social_content' | 'one_off_campaign'` (renamed from `event_campaign`). `OneOffCampaignBrief` has three required fields and two optional paired ones:

- `name` (required) -- whatever the operator calls the campaign
- `campaignEndDate` (required) -- the auto-stop date, drives the worker filter
- `cta` (required) -- where traffic goes
- `milestoneDate` + `milestoneLabel` (optional, paired) -- one additional key date with an operator-typed label that fits the campaign: "Sale ends" / "Doors open" / "Registration deadline" / "Launch day"

The label flows through to Hermes verbatim so countdown copy says what the operator means, not what a hackathon would mean. Hermes payload key renamed: `event_brief` -> `one_off_brief` with `days_until_end` (was `days_until_deadline`). The `milestone_date` + `milestone_label` keys are present only when both are set; orphan milestone fields (one without the other) are rejected at validation time.

**Files touched.**

- `lib/api/marketing.ts` -- union rename, `EventCampaignBrief` -> `OneOffCampaignBrief`, payload field `event` -> `oneOff`. Legacy `event_campaign` literal and the old type alias are dropped (no back-compat -- see Breaking changes below).
- `backend/marketing/runtime-state.ts` -- `job_type` union update; the dead-code branch in `createMarketingJobRuntimeDocument` now correctly resolves `one_off_campaign`.
- `backend/marketing/orchestrator.ts` -- `buildEventBriefForArgs` -> `buildOneOffBriefForArgs`. Reads from `inputs.request.oneOff`. Validates the three required fields, surfaces optional milestone pair atomically (both or neither). `StartMarketingJobRequest.jobType` and `StartMarketingJobResponse.jobType` unions updated.
- `backend/marketing/jobs-status.ts` -- `buildCampaignWindow` reads `oneOff.campaignEndDate` for the dashboard "Stops publishing on" label. Optional `milestoneDate` becomes the window start when present.
- `app/api/marketing/jobs/handler.ts` -- `PublicJobType` updated, guard accepts `one_off_campaign`, `extractEventPayloadFromForm` -> `extractOneOffPayloadFromForm`, `validateAndConvertEventBrief` -> `validateAndConvertOneOffBrief`. Drops the old triple-date-ordering rule (registrationDeadline <= eventDate <= campaignEndDate); adds the new pair-or-neither + milestone-before-end rule.
- `app/api/social-content/jobs/[jobId]/posts/[postId]/schedule/route.ts` -- reads `oneOff.campaignEndDate` to populate `scheduled_posts.campaign_end_date`.
- `frontend/marketing/new-job.tsx` -- toggle copy "One-off event" -> "One-off campaign" with a help line "Sale, launch, webinar, hackathon. Auto-stops on the end date." Replaces the four hackathon date inputs with three required (campaign name / end date / CTA) plus a clearly-marked optional section ("Optional key date Aries can reference in copy. Label it however fits your campaign -- 'Sale ends', 'Doors open', 'Registration deadline', 'Launch day'.") that holds the milestone date + label fields side by side.

**Tests.** Old `event-campaign-*.test.ts` trio deleted; replaced with `one-off-campaign-orchestrator.test.ts` (8 tests), `one-off-campaign-form-validation.test.ts` (9 tests), `one-off-campaign-tz-boundary.test.ts` (6 tests). New coverage: milestone pair surfaces atomically, orphan milestone date/label rejected, milestone-after-end rejected, minimal-payload happy path (no milestone), full-payload happy path (with milestone). PT/JST boundary tests retained verbatim -- timezone behaviour didn't change.

**Breaking changes.** No back-compat for v0.1.10.x `event_campaign` runtime documents. The single QA test campaign Brendan created during PR #446 verification needs to be cancelled and re-created with the new shape; its scheduled_posts rows are still protected by the worker auto-stop (the column write happened at schedule time and the WHERE clause is timezone-agnostic). Hermes-side prompt changes are still out of scope -- the wire contract is the new shape from day one.

`npm run verify` 38/38, 23/23 new tests pass, typecheck clean.

## v0.1.10.1 — feat(hackathon): direct-URL landing page for Aries AI Hackathon registration

Adds the actual `/hackathon` landing page that the v0.1.10.0 event_campaign feature's CTAs now point to. Direct-URL-only: not linked from any nav, footer, sitemap, or homepage. Page metadata sets `robots: { index: false, follow: false, nocache: true }` so search engines won't pick it up, and `public/robots.txt` (newly created -- the repo previously had none) explicitly disallows `/hackathon` and `/api/` as defense-in-depth.

**Page (`app/hackathon/page.tsx`).** Server component using the existing `MarketingLayout` for brand consistency. Hero with event name, tagline, four fact cards (registration deadline, event window, format, who), "What you'll do" list, prize block, and the registration form. Copy lives in a single `HACKATHON` constant at the top of the file with an `EDIT ME` comment -- operator can tune dates/prize/format without touching routing or form infrastructure.

**Form (`frontend/hackathon/registration-form.tsx`).** Client component with three fields: name (required), email (required, client + server validation), motivation (optional). Loading state, inline 422 field errors mapped from the API response, top-level error alert for network/persist failures. On success, the form swaps to a "You're in" confirmation panel with the registered email surfaced and a "share this URL" prompt.

**API (`app/api/hackathon/register/route.ts`).** Public unauthenticated POST. Length-caps every string field (name 200, email 320, motivation 1000) before persistence. Stores `ip_address` (first hop from `x-forwarded-for`, length-capped) and `user_agent` for abuse triage -- never relied on for identity. Persists via `INSERT ... ON CONFLICT ((lower(email))) DO UPDATE` so a refresh-and-resubmit upserts the same record idempotently -- the share-friendly direct URL means duplicate submits are expected and should not 409.

**Schema (`scripts/init-db.js`).** New `hackathon_registrations` table with `id`, `name`, `email`, `motivation`, `ip_address`, `user_agent`, `registered_at`, `updated_at`. Unique index on `lower(email)` enforces case-insensitive de-duplication. Standalone -- no FK to `organizations` or `users` because registrants are mostly external builders without Aries accounts. `CREATE TABLE IF NOT EXISTS` + `CREATE UNIQUE INDEX IF NOT EXISTS` make the migration idempotent.

**Tests (`tests/hackathon-register.test.ts`).** 6 source-level + 1 live-DB. Source-level asserts: schema declares the table with required columns and unique lower(email) index, route validates name + email shape, route 422s on missing fields, route uses ON CONFLICT upsert, route caps field lengths, page metadata is noindexed, robots.txt disallows /hackathon. Live-DB smoke (skips without DB env) inserts a record, upserts the same email in uppercase, asserts the row id is identical and updated_at advances; runs in a rolled-back transaction so no test data persists.

To direct the v0.1.10.0 event_campaign CTA at this page, the operator types `https://aries.sugarandleather.com/hackathon` into the campaign form's CTA field -- no code change needed.

`npm run verify` 38/38, all 6 new tests pass, typecheck clean.

## v0.1.10.0 — feat(marketing): one-off event campaigns with auto-stop on a hard deadline

First-class support for time-bound campaigns alongside the existing weekly drip. Operators can now toggle the new-job form to "One-off event", enter an event name, event date, registration deadline, campaign end date, and CTA, and Aries will drive countdown framing through Hermes and **stop publishing past the campaign end date** without any human intervention. The auto-stop guarantee lives in the scheduled-posts worker's claim-time WHERE clause, not in an LLM prompt, so it holds even if Hermes ignores every other signal. Forcing example: an Aries AI hackathon with registration closing 2026-06-10 publishes a sharpening urgency arc through the deadline and goes dark at 23:59 in the tenant's local timezone.

**Schema and worker.** `scheduled_posts.campaign_end_date TIMESTAMPTZ NULL` is added via `ADD COLUMN IF NOT EXISTS` in `scripts/init-db.js`; NULL preserves legacy weekly behavior (the column is unused for the existing recurring jobs, so no backfill is needed). The worker's exported `CLAIM_ROW_SQL` and `DUE_ROWS_SQL` constants in `scripts/automations/scheduled-posts-worker.mjs` gain `AND (campaign_end_date IS NULL OR campaign_end_date >= NOW())`. In-flight rows that crossed the deadline mid-publish complete normally — once Meta has been called we can't un-call it, and the existing crash-safety pattern (pending vs in_flight) is preserved.

**Types and payload.** `lib/api/marketing.ts` widens `MarketingJobType` to `'weekly_social_content' | 'event_campaign'` and adds a nested `event?: EventCampaignBrief` to `BrandCampaignPayload` ({ eventName, eventDate, registrationDeadline, campaignEndDate, cta }). The discriminator is the presence of `payload.event` plus `doc.job_type === 'event_campaign'`. Existing `BrandCampaignPayload` fields are untouched; flat field count is unchanged.

**Orchestrator and Hermes contract.** `backend/marketing/orchestrator.ts` exports `buildEventBriefForArgs(doc)` which returns a structured Hermes payload `{ event_name, event_date, registration_deadline, campaign_end_date, cta, days_until_deadline }` when the runtime doc is an event campaign with complete fields, or `null` otherwise. `days_until_deadline` is computed against `Date.now()` at each stage invocation so the countdown stays fresh across research → strategy → production. `marketingPipelineArgs` spreads the brief into the existing args block. The pipeline-routing function `requestedJobTypeFromDoc` is deliberately untouched; event campaigns ride the weekly Hermes pipeline (premise P3 from the design doc).

**Submit-handler timezone conversion.** `app/api/marketing/jobs/handler.ts` exports `validateAndConvertEventBrief(payload, tenantId)` which converts the form's three YYYY-MM-DD calendar dates into tenant-local end-of-day UTC ISO instants via `wallTimeToUtc` from `lib/format-timestamp.ts`. Tenant timezone is read sync-and-file-only via the new `loadTenantTimezoneOrFallback` helper on `backend/tenant/business-profile.ts` (falls back to `DEFAULT_TENANT_TIMEZONE = 'America/New_York'` when unset). Ordering rules (registrationDeadline ≤ eventDate ≤ campaignEndDate) and YYYY-MM-DD shape are enforced server-side; failures return 422 with a structured `fieldErrors` object the existing `parseMarketingFieldErrors` form hook already consumes.

**Schedule-route end-date write.** `backend/social-content/scheduled-posts.ts` extends `UpsertScheduledPostInput` with `campaignEndDate?: Date | null`; the INSERT/UPDATE writes the new column and re-schedules overwrite via `EXCLUDED`. `app/api/social-content/jobs/[jobId]/posts/[postId]/schedule/route.ts` loads the parent runtime doc, extracts the converted UTC end date when `job_type === 'event_campaign'`, and passes it through. Weekly campaigns pass `null` (worker treats NULL as "no end date").

**Form UX.** `frontend/marketing/new-job.tsx` adds a radiogroup toggle between "Weekly social content" and "One-off event". Selecting event reveals five required fields (event name, event date, registration deadline, campaign end date, CTA) with `<input type="date">` pickers and inline 422 field errors. Date-ordering is enforced client-side before the round-trip; server re-validates. Weekly remains the default — existing tenants see no change.

**Dashboard surface.** `backend/marketing/jobs-status.ts` `buildCampaignWindow` now branches on `job_type === 'event_campaign'` and returns `{ start: registrationDeadline ?? eventDate, end: campaignEndDate }` from the runtime doc. The dashboard already understands `campaignWindow.end`, so the "Stops publishing on `<date>`" label renders with zero UI changes.

**Tests.** 23 new tests across 4 files: 6 orchestrator (null for weekly, null for incomplete event, structured payload on complete, days_until_deadline compute + clamp, null on malformed), 7 form validation (missing fields, null safety, date shape, ordering, NY end-of-day conversion, whitespace), 6 PT/JST timezone boundary (PT June 10 → June 11 06:59 UTC, JST → June 10 14:59 UTC, 16-hour gap, PST winter, shape rejection, NY fallback), and 4 worker regression (source-level filter assertions, column existence, planner exercise — the live-DB column check skips when DB env is absent and runs after init-db migration applies in prod). `npm run verify` 38/38, typecheck clean, banned-patterns clean.

**Out of scope (T10 follow-up).** Hermes-side strategy/production prompt updates that consume `event_brief` and produce countdown copy. Aries-side is feature-complete without them — the worker filter is the load-bearing correctness guarantee.

Design doc: `~/.gstack/projects/DeliciousHouse-aries-app/node-master-design-20260524-102604.md`. Eng review verdict: CLEARED.

## v0.1.9.0 — chore(brand): regenerate favicons from new logo + drop 3 orphan brand assets

Follow-on to v0.1.8.9 (logo swap). The favicon set still pointed at the pre-rebrand assets: `public/favicon.ico` was a 256×256 single-frame bloat (270 KB), `public/favicon.png` was the old 18 KB raster mark, and `public/favicon.svg` was a literal `<text>A</text>` placeholder on a black square — none of which represented the new brand. This commit regenerates all three from `public/aries-logo.webp` (the new 2048×2047 source) using a tiny `sharp`-backed script (the same image pipeline Next.js already uses; no new dep). The new files:

- `public/favicon.png` — single 32×32 PNG, 1 KB (down from 18 KB). Referenced from `app/layout.tsx` via `ARIES_FAVICON_PNG_PATH` for both `<link rel="icon" type="image/png">` and `apple-touch-icon`.
- `public/favicon.ico` — proper multi-frame ICO with 16×16, 32×32, and 48×48 PNG-embedded sub-frames, 3 KB (down from 270 KB; the old file was a single 256×256 frame which is wasteful for a browser-tab icon). Referenced from `app/layout.tsx` via `ARIES_FAVICON_ICO_PATH` for both the standard icon list and `shortcut`. Built by hand-writing the ICO directory (`<reserved=0><type=1><N><dir-entries…><png-payloads…>`); validated by `file public/favicon.ico` → "MS Windows icon resource - 3 icons".
- `public/favicon.svg` — SVG wrapper that embeds a base64 96×96 PNG of the new mark, 4.9 KB. Replaces the hardcoded "A" placeholder so browsers that prefer SVG favicons (Firefox, modern Chromium) get the real brand. Referenced from `components/redesign/brand/logo.tsx` as the `BrandLogoFallbackSvg` source.

Also removes three orphan brand-adjacent assets that had **zero** references in the codebase (verified by `grep -rn` across `*.tsx` / `*.ts` / `*.css` / `*.json` / `*.html` / `*.md` / `*.mjs` excluding `node_modules` and `.next/`): `public/aries.webp` (140 KB), `public/icon.webp` (50 KB), `public/cube-icon.webp` (71 KB). Total cleanup: ~534 KB shaved from every container image (favicon shrink + orphan delete).

No code change beyond the asset swap and orphan deletion. `lib/brand.ts` constants (`ARIES_LOGO_WEBP_PATH`, `ARIES_FAVICON_*_PATH`) are unchanged — they already point at the right paths. `npm run verify` 38/38, `npm run lint` pass.

## v0.1.8.9 — chore(brand): adopt new Aries logo, clean filename + drop old asset

Sowmya / Venkata shipped a new brand mark for Aries (`update-new-logo-webp` → `Update new logo to WebP`, originally landing as `public/Aries_new_logo.webp` 2048×2047 VP8X). This commit takes that change to ship-ready: renames the asset to `public/aries-logo.webp` so it matches the existing kebab-case-lowercase convention used by every other file in `public/` (the original "_new_" qualifier ages poorly once it stops being new); deletes the now-unreferenced `public/ariesai-logo.webp` (49 KB) so we aren't shipping two logos in every container image; updates the four call sites that point at the asset path — `lib/brand.ts` (`ARIES_LOGO_WEBP_PATH`, the single source of truth that `app/layout.tsx` favicon list and `components/redesign/brand/logo.tsx` both consume), two `<Image src>` in `frontend/aries-v1/onboarding-flow.tsx` (header mark + decorative hero), and one in `frontend/donor/ui.tsx` (`AriesMark`). No semantic change beyond the asset swap: every consumer renders at square dimensions (72/320/500/configurable 48) and the new mark is square, so aspect is preserved; `next/image` handles the 4× pixel-density step without any code change. Original Sowmya commit preserved as the parent commit; this is the cleanup commit on top. `npm run verify` 38/38, lint pass.

## v0.1.8.8 — fix(memory): make Honcho writes actually reach Honcho v3 (batch body shape + POST /messages/list)

v0.1.8.7 flipped Honcho Phases 1+2+3 on, but every write was silently 422-failing against the real Honcho v3 API. Two protocol bugs in `backend/memory/honcho-client.ts`:

1. **POST `/sessions/{sid}/messages` body shape.** Aries sent a flat single-object body `{ peer_id, content, metadata }`. Honcho v3 requires `MessageBatchCreate`: `{ messages: [{ peer_id, content, metadata }] }` (1–100 items). The flat body returns `422 {"detail":[{"type":"missing","loc":["body","messages"]}]}`, which `HonchoHttpTransport` wraps as `MemoryError('honcho_unavailable', …, 502)` and `recordApprovalEvent` / `recordDenialEvent` / `recordScheduleEvent` / `recordPerformanceEvent` / `recordCreativeVoicePreferenceEvent` all catch and log-but-swallow. Net effect since Phase 1 shipped: zero writes ever landed. Verified by end-to-end smoke test against the locally-running `honcho-api-1` container (`http://host.docker.internal:8000`) — strategy approval now creates the workspace, session, and message with the expected peer/content/metadata.

2. **GET `/messages` does not exist on v3.** `listApprovedMessages` was using `GET /v3/workspaces/{ws}/sessions/{sid}/messages?peer_id=...` (and `…/peers/{peer}/messages` for the no-session case). Honcho v3 only exposes `POST …/messages/list` with body `{ filters: { peer_id } }` and query `page`/`size`/`reverse`. GET returns 405 silently; reads have therefore been returning empty arrays since launch, which is why `loadResearchMemoryContext` always produced an empty memoryContext in the Hermes payload. Fixed by switching to `POST …/messages/list`. There is no peer-scoped messages list endpoint in v3 — the no-session path now warn-logs and returns `[]` rather than throwing, preserving the existing silent-empty behavior in `backend/memory/orchestrator.ts:loadResearchMemoryContext`. Proper peer-scoped reads (iterate sessions, or use `/peers/{peer}/representation`) are now a TODO; the warning makes the limitation observable.

Both fixes are pure protocol shape — no Aries-side semantics change. The four Honcho phase gates and the idempotency-keys claim flow are untouched. Tests updated: `tests/memory-honcho-client.test.ts` gains a regression test asserting the wrapped `{ messages: [...] }` body shape, the POST `/messages/list` path for session-scoped reads, and the `[]`-without-call behavior for the peer-only path. `tests/memory-write-events.test.ts` adds a `firstMessage(call)` helper and migrates the four write-shape assertions to pull from `body.messages[0]`. `tests/memory-research-callback.test.ts` updated identically for the auto-approved-finding write. `npm run verify` 38/38 + memory suites 42/42 + lint pass.

## v0.1.8.7 — feat(memory): flip Honcho Phases 1+2+3 on in production + design doc for missing /insights polling

Activates Honcho continuous-profile-writes Phases 1+2+3 simultaneously. All three phases' code was already shipped on master — Phase 1 wired at `backend/marketing/orchestrator.ts:2064` (strategy approvals + denials), Phase 2 wired at `app/api/publish/dispatch/handler.ts:74` + `app/api/social-content/jobs/[jobId]/posts/[postId]/schedule/route.ts:189` + `backend/marketing/hermes-callbacks.ts:1558,1579` (publish verification, scheduled posts, Hermes publish-callback summary), Phase 3 wired at `app/api/social-content/jobs/[jobId]/creative-voice-preference/handler.ts:8` (UI creative-voice toggle). The Postgres idempotency table `honcho_write_idempotency_keys` is in `scripts/init-db.js:521`. This commit flips four env defaults in `docker-compose.yml`: `HONCHO_ENABLED`, `HONCHO_WRITE_APPROVALS_ENABLED`, `HONCHO_WRITE_PUBLISH_ENABLED`, `HONCHO_WRITE_PREFERENCES_ENABLED` all go `false → true`. Per design, Honcho unavailability is silent degradation — if production `.env` is missing `HONCHO_BASE_URL` / `HONCHO_CONTROL_PLANE_JWT` / `HONCHO_DATA_PLANE_JWT` / `ARIES_TENANT_PSEUDONYM_SALT`, writes silently no-op (with a warn log) and the user-facing API still returns 200. Each phase has its own gate so any one can be killed without redeploy if a write surface misbehaves. Also adds `docs/plans/2026-05-24-honcho-performance-insights-integration.md` — design doc for the analytics-page workstream documenting the missing Meta `/insights` polling loop (the one Honcho phase that ISN'T shipped: there's no scheduled job that fetches actual post performance metrics 24–72h after publish). The doc gives the next developer the exact integration contract: which already-shipped functions to call, scrubbing rules, suggested worker architecture, test plan, rollback path. The integration is split so the analytics page can ship independently and the Honcho write becomes additive when ready.

## v0.1.8.6 — chore(todos): record CI infra flakes + Honcho rollout prerequisites for next session

Closes the /goal session's housekeeping. Appends three new TODOS entries: (1) the GitHub Actions auth flakes observed during the v0.1.7.4→v0.1.8.4 ship cascade (`pr-agent-autofix-automerge.yml` HTTP 401 once + CodeQL checkout terminal-prompts-disabled once — both transient, both self-resolved); (2) the Honcho `HONCHO_ENABLED` + `HONCHO_WRITE_APPROVALS_ENABLED` flip prerequisites (HONCHO_BASE_URL/JWTs/salt provisioning in prod, idempotency-keys migration check, smoke test) — Phase 1 code is already shipped on master; (3) the Phase 2 + Phase 3 branches that were "shipped on branch" but never landed. Each entry has enough context that the next session can pick up cleanly without re-discovering the surface.

## v0.1.8.4 — chore(memory): flip ARIES_MEMORY_LABEL_REDACTION_V2=1 default in docker-compose

Activates the narrow first-name-denylist heuristic in `scrubPreferenceLabelForHoncho` (`backend/memory/write-events.ts`). Replaces the legacy broad `/[A-Z][a-z]+\s+[A-Z][a-z]+/` regex that was over-scrubbing creative descriptors like "Bold Minimalist" or "Quiet Luxury" to `[redacted_name]` before they reached Honcho. Real `<FirstName> <LastName>` pairs (from a curated first-name denylist) still get scrubbed. Email redaction is unchanged in both modes. The implementation and both-mode test coverage (`tests/memory-label-redaction.test.ts`) have been in place since v0.1.6.5; this commit only flips the env default in `docker-compose.yml` so the single-tenant production container picks up the new heuristic on next deploy. Overridable per-container via the `ARIES_MEMORY_LABEL_REDACTION_V2` env var if a rollback is needed without a redeploy.

## v0.1.8.3 — chore(verify): widen verify regression suite to cover the 30-day backlog files

Closes the root cause of the 2026-04-23 P0 test backlog. `npm run verify` was narrower than the full TypeScript contract suite — failing tests in 9 files could accumulate for ~30 days without ever blocking a ship. v0.1.7.4–v0.1.7.8 + v0.1.8.0 + v0.1.8.2 all landed test-only or test-tighten fixes for files in that group. Adds a new "post-30-day-backlog contract regression tests" step to `scripts/verify-regression-suite.mjs` that runs all 9 of them in a single tsx invocation. Wall-clock impact: `verify` went from ~6s to ~51s end-to-end (still under the ~90s budget). Two files are deliberately excluded for now and still tracked in CI's full suite: `tests/frontend-api-layer.test.ts` (~70s; needs splitting) and `tests/marketing-brand-identity-parity.test.ts` (~64s; needs hot-loop investigation). Both excluded files are called out in the script's added comment block so the next person picking it up knows the scope.

## v0.1.8.2 — fix(social-content): preserve weekly post.id through projection so dashboard post→asset links match

Closes test 56 in `tests/frontend-api-layer.test.ts` (un-skipped). `parsePosts` in `backend/social-content/runtime-state.ts` was dropping `entry.id` while parsing the weekly content plan, so `WeeklyPost` reached `dashboard-projection.ts` without it. Two downstream effects: (1) `normalizedSocialPostId` fell through to the `social-post-${index + 1}` synthetic, so `socialCopyByPostId.get(...)` couldn't match the planner's `post-1`/`post-2`/... keys and finalized captions/hashtags/CTA failed to attach to the right dashboard post; (2) `createPosts` then hardcoded the same synthetic id on the projected `MarketingDashboardPost`, so `attachPostRelationsToAssets` (which keys by `post.id`) wrote synthetic ids into `dashboard.assets[].relatedPostIds`, breaking the asset→post reverse link the operator dashboard uses to render which posts a given creative belongs to. Fix: add `id: string` to `WeeklyPost`, have `parsePosts` carry `entry.id` forward, and have `createPosts` use `post.id || \`social-post-${index + 1}\`` for the dashboard post id (legacy plans that omit id still get the synthetic fallback). Repo-wide grep confirms zero consumers of the `social-post-N` shape outside the deleted test comment, so this is internal-only. Unit coverage: test 56 now passes; `npm run validate:social-content` 92/92; full `tests/frontend-api-layer.test.ts` 56/56; `npm run verify` and typecheck pass. **Visual confirmation pending in `aries.sugarandleather.com` dashboard per the user-visible-completion rule — do not merge until that lands.**

## v0.1.8.1 — fix(security): close postcss XSS Dependabot alert by overriding next's bundled copy

Closes Dependabot alert #27 (GHSA-qx2v-qp2m-jg93 / CVE-2026-41305, MEDIUM, CWE-79). v0.1.6.2's CHANGELOG claimed to resolve this by bumping the direct `postcss` dep `8.5.11→8.5.15`, but the alert stayed open because Next.js 16.2.6 ships its own bundled copy at `node_modules/next/node_modules/postcss@8.4.31`, below the 8.5.10 fix threshold. The bundled copy is the one Dependabot was flagging. Fix: add `"overrides": { "postcss": "$postcss" }` to `package.json` so npm forces every transitive postcss resolution to match the direct dep version (`^8.5.15`, already patched). After regeneration, `node_modules/next/node_modules/postcss` is gone entirely — the entire dep tree collapses to a single `postcss@8.5.15`. `npm audit` reports 0 vulnerabilities. Tailwind v4 compatibility verified by typecheck and the verify regression gate (both pass). Used `$postcss` reference syntax instead of a hard `^8.5.10` pin to avoid an `EOVERRIDE` conflict against the direct dep.

## v0.1.8.0 — fix(security): close 7 incomplete-url-substring-sanitization patterns in OAuth test mocks

Pre-empts the same CodeQL `js/incomplete-url-substring-sanitization` (HIGH) class that #432 hit at land time. A Haiku scan of the repo found 7 test files still using `url.includes('hostname.com/...')` for fetch-mock gating where a substring match would let `hostname.com.evil.com` through. While these are in test code (the mocks control their own URLs), CodeQL flags them as security alerts and they would have surfaced on every future ship that touched the same files. Fix: parse the URL once with `new URL(url)` and gate on `parsed.hostname === '<exact-host>'` before the path/query `.includes(...)` checks. Files touched: `tests/oauth-callback-runtime.test.ts` (openai, reddit ×2, tiktok, youtube ×2 — 6 patterns) and `tests/oauth-refresh-meta.test.ts` (facebook graph). Reddit token endpoint uses `www.reddit.com` per `backend/integrations/callback.ts:469`. Each affected test suite still passes (6/6 + 3/3). Production code path unchanged. The one remaining MEDIUM hit is documentation example in `skills/meta-ads-extractor/SKILL.md:61` — left for a separate docs PR.

## v0.1.7.8 — fix(tests): unstick frontend-api-layer suite and document a real social-content bug

The 17 failures in `tests/frontend-api-layer.test.ts` traced to four kinds of drift between the test fixtures and the production code: (1) the execution-port seam was renamed from a `globalThis.__ARIES_EXECUTION_TEST_INVOKER__` hook with `ARIES_EXECUTION_PROVIDER=legacy-openclaw` to `__setMarketingExecutionPortForTests` taking a `MarketingExecutionPort` interface; tests 3/5/47 still wired the old hook and got 422 instead of 202; (2) `inferMarketingStageRunId` in `backend/marketing/stage-artifact-resolution.ts` now scans `path.join(stageCacheRoot(stage), tenantId)` but fixtures for tests 11/17/19/22/25/26/31 still wrote to the old flat `ARTIFACT_STAGEn_CACHE_DIR/<runId>/`; (3) test 28's brand profile fixture lacked `website_url`, so `recordMatchesCurrentSource` rejected it; (4) tests 6/9/29 had stale copy or fixture expectations against shipped behavior. Rewrote the test mocks and fixtures to match current code — the orchestrator's `MarketingExecutionPort` mock implements `runPipeline/resumePipeline/submitNextStage/getCallbackUrl/getSessionKey/submitRawRun`, all stage artifact fixtures now write under `<tenantId>/<runId>/`, and the source-fingerprint and copy/window/voice assertions match what the code actually produces. Touched `backend/marketing/runtime-views.ts` for one cosmetic split of a `Map(...)` expression for readability — no behavior change. Test 56 (`returns finalized social copy on dashboard posts while assets stay reverse-linked via relatedPostIds`) is **skipped, not fixed**: investigation surfaced a real production bug — `parsePosts` in `backend/social-content/runtime-state.ts` strips `post.id` while parsing the weekly content plan, so `normalizedSocialPostId` can't key social copy back to its post, and `createPosts` in `backend/social-content/dashboard-projection.ts` then assigns synthetic `social-post-N` IDs which break the `relatedPostIds` reverse-link from assets to posts. Fixing that correctly requires verifying in the live dashboard (per the user-visible-completion rule for social-content) that captions/hashtags/CTA actually appear on the right posts — not just a green unit test. The test is left in place with its failing assertions intact so the bug stays visible in the suite. 55 pass / 1 skipped / 0 fail; `npm run verify` + `npm run typecheck` clean.

## v0.1.7.7 — fix(tests): port marketing brand-profile contract tests off deleted python scripts

`tests/marketing-brand-identity-parity.test.ts` (tests 1 + 2) and `tests/marketing-validated-runtime.test.ts` (test 1) called `runScript({ scriptName: 'brand-profile-db-contract', ... })`, `runScript({ scriptName: 'head-of-marketing', ... })`, and `runScript({ scriptName: 'creative-director', ... })` — all three python scripts were deleted in `637c2f0` (Lobster removal); `lobster/bin/` is empty. The subprocess invocations returned exit code 2 and the tests failed before any meaningful assertion ran. Replaced the subprocess calls with direct writes to the validated store using `tenantBrandProfilePath` and `tenantBusinessProfilePath` from `backend/marketing/validated-profile-store.ts`, producing the exact `brand-profile.json` / `business-profile.json` schema the python script formerly emitted. The downstream `loadValidatedMarketingProfileSnapshot`, `buildCampaignWorkspaceView`, and `getBusinessProfile` reads then exercise the same code paths the production pipeline runs. Honest note on coverage: the original `marketing-brand-identity-parity` tests were structurally a *parity* test — they ran the python `head-of-marketing` and `creative-director` paths and compared their output to the snapshot. Post-Lobster there is no second TS computation path to compare against (`buildMarketingBrandIdentity` has a divergent signature that doesn't reproduce snapshot construction from raw hooks), so the strategy/production payloads in the rewrite are now thin wrappers around `snapshot.brandIdentity` and that specific drift-detection function is gone. The remaining stale-needle and source-switch assertions over `workspaceView.brandReview` and `businessProfile` still meaningfully cover the read-model layer: they catch any leak of source-A data into the read models after a source-B switch, which is the behavior the security work in `637c2f0` actually hardened. 5/5 tests across both files pass; `npm run verify` and `npm run typecheck` are clean. Re-introducing an independent TS computation path for true parity testing is logged as a TODO follow-up; it requires shaping `buildMarketingBrandIdentity` to accept the same raw inputs the deleted python script consumed.

## v0.1.7.6 — fix(tests): align OAuth/integrations tests with Postgres-backed handlers

The `tests/auth/integrations-tenant-context.test.ts`, `tests/auth/oauth-connect.test.ts`, and `tests/integrations-status.test.ts` files were stuck on an older shape of the OAuth integrations layer: they seeded `oauthStore()` (the in-memory store in `backend/integrations/oauth-memory-store.ts`) and expected the handlers to read from it, but the handlers were migrated to read connection rows from Postgres via `dbGetConnection` and pending-state rows via `dbGetPendingState` in `backend/integrations/oauth-db.ts`. The memory-store seeds were ignored at runtime, so every test ran against an empty DB and saw misconfigured/disconnected states (or, in the callback flow, hit a real `pool.query` call that failed with `SCRAM-SERVER-FIRST-MESSAGE` because no DB credentials are loaded in the test runner). Rewrote the three files to mock `pool.query` (the same harness used by `tests/oauth-callback-runtime.test.ts`) and dispatch on SQL text — SELECT-by-tenant+provider, SELECT-by-id, INSERT … RETURNING, and the audit/token writes — so handler reads see synthetic rows derived from each test's fixture. Tenant and connection IDs across all fixtures were switched to numeric strings (`'1'`, `'2'`, `'101'`, `'102'`, `'123'`) because `toTenantIdInt` `parseInt`s them and throws on `NaN`. Each test file gained a `withMetaEnv` wrapper that sets `META_APP_ID`, `META_APP_SECRET`, `OAUTH_TOKEN_ENCRYPTION_KEY` (and, for the integrations-status file, `META_PAGE_ID` + `META_ACCESS_TOKEN` for the Instagram env-managed health path) so `getProviderOAuthAvailability('facebook')` returns `available: true` and the test reaches the DB layer. The Facebook OAuth callback mock chain in `oauth-connect.test.ts` test 10 was rebuilt to match the actual call sequence — short-lived `access_token?code=`, long-lived `access_token?fb_exchange_token=`, `/me/accounts`, and `/{pageId}?fields=` — and `pool.query` handles `INSERT INTO oauth_connections RETURNING` plus audit/token writes. The "integrations sync" test was also rewritten: the old `__ARIES_EXECUTION_TEST_INVOKER__` globalThis hook no longer exists in the Hermes execution adapter, so it now sets `HERMES_GATEWAY_URL` + `HERMES_API_SERVER_KEY`, mocks `globalThis.fetch` to capture the submitted Hermes prompt, and asserts the authenticated session's `tenant_id` (not the forged body) appears in the prompt's `Args (JSON)` line. 17/17 tests across the three files pass; `npm run verify` and `npm run typecheck` are clean. No production code touched.

## v0.1.7.5 — fix(tests): repair onboarding-draft-route test 3 vs ECONNREFUSED→fallback

`ab4fa6a` made `POST /api/onboarding/draft` fall back to `DATA_ROOT` when Postgres throws transient network errors (`ECONNREFUSED`, `ENOTFOUND`, etc.), so pre-auth intake survives a database outage. That regressed `tests/onboarding-draft-route.test.ts` test 3, which mocked `pool.query` to throw an `ECONNREFUSED` Error and expected 503. Two reasons the test was wrong against the new contract: (1) `withDraftEnv` deletes `DB_HOST`/`DB_USER`/`DB_PASSWORD`/`DB_NAME`, so `hasDatabaseConfig()` returns false and the route short-circuits to the filesystem fallback before `pool.query` is ever called — the mock never fires; (2) even if the mock did fire, a plain `new Error('… ECONNREFUSED …')` has no `.code` field, so `shouldUseFallbackDraftStore` wouldn't match it. Rewrote test 3 to keep DB env vars set inside `withDraftEnv`, throw a non-recoverable Postgres error (`code: '28P01'`, "password authentication failed"), and assert the route still returns a safe 503 with no leakage of the underlying error string. The test now guards what its name claims: the 503 redaction path for non-transient persistence failures. The transient-fallback path is already covered by `tests/onboarding-draft-store.test.ts`.

## v0.1.7.4 — fix(tests): resolve public-surface contract failures from /ship triage

Knocks out the P0.4 row from `TODOS.md` ("Repair public-surface contract tests for review copy and fallback responses") and retriages the rest of the 2026-04-23 `/ship` test-failure backlog with current evidence. `frontend/aries-v1/campaign-workspace.tsx:933` was rendering `<GateFallbackPanel eyebrow="Checkpoint" …>` when a review hadn't loaded — internal workflow vocabulary leaking into a client review surface. Changed to `eyebrow="Review"`, which is the domain-appropriate label and matches the language the rest of the workspace already uses. `tests/review-surfaces-public.test.ts` lost three stale `assert.match(…, /Supporting materials/)` calls; that copy was never shipped to any of the four files scanned (`review-item.tsx`, `campaign-workspace.tsx`, `job-approve.tsx`, `review-queue.tsx`) — confirmed by a repo-wide grep returning zero hits — so the assertions were asking the test to enforce text that doesn't exist. `tests/public-generated-routes.test.ts` test 4 was still expecting the old plain-text 404 contract; `app/[...publicPath]/route.ts` deliberately returns a branded HTML 404 (`NOT_FOUND_HTML`) with `text/html; charset=utf-8` and `Page not found`, so the test now asserts the shipped behavior. `TODOS.md` also gets a 2026-05-23 retriage note on the remaining P0 rows: `tests/onboarding-draft-store.test.ts`, `tests/password-reset.test.ts`, `tests/auth/auth-tenant-membership.test.ts`, `tests/oauth-callback-runtime.test.ts`, `tests/tenant/business-profile.test.ts`, and `tests/runtime-api-truth.test.ts` all now pass in isolation; `tests/marketing-competitor-canonical-flow.test.ts` and `tests/review-decision-idempotency.test.ts` were deleted with the Lobster removal in `637c2f0` and no longer apply. The remaining real work — OAuth pool-mock harness updates (3 files, shared root cause), `frontend-api-layer.test.ts` execution-port mock swap + tenant-scoped artifact paths, and the deleted `brand-profile-db-contract` python script — is now scoped concretely in `TODOS.md`. `npm run verify` and `npm run typecheck` pass.

## v0.1.7.3 — fix(deploy): recreate scheduled-posts-worker sidecar on every deploy

Plugs the gap exposed by v0.1.7.2. The deploy workflow uses `docker compose up -d --no-deps --force-recreate --pull always aries-app` so only the named service is recreated — the new `aries-scheduled-posts-worker` sidecar was never started by the v0.1.7.2 deploy and had to be bootstrapped by hand. More importantly, future image rolls would have left the worker pinned to whatever image it last booted from, silently running stale dispatch code while the web tier moved forward. After the aries-app health check passes, the deploy step now runs the same `up -d --no-deps --force-recreate --pull always` against the worker so the two services stay in image lockstep. The sidecar recreate is non-fatal: if the worker fails to come up, the app deploy is still reported healthy and a warning is surfaced, since scheduled-posts dispatch is best-effort relative to the user-facing app.

## v0.1.7.2 — feat(scheduling): run scheduled-posts-worker as an in-stack docker sidecar

Closes the scheduling hole left open by v0.1.7.1's openclaw removal. `scheduled-posts-worker.mjs` was already self-scheduling — when started without `ARIES_SCHEDULED_POSTS_RUN_ONCE` it sets a 60-second `setInterval` and drains the queue forever — but nothing was starting it once the openclaw cron disappeared, so scheduled posts had no dispatcher in production. This release adds an `aries-scheduled-posts-worker` service to `docker-compose.yml` that reuses the existing image, runs the worker as its long-lived command, depends on `aries-app` being healthy, and restarts unless stopped. Single replica avoids racing the SQL claim-lock on the same row. The sidecar's `APP_BASE_URL` and `NEXTAUTH_URL` point at the in-network `http://aries-app:3000` so the per-minute POST to `/api/internal/publishing/scheduled-dispatch` skips a public DNS + TLS round-trip; auth uses the existing `INTERNAL_API_SECRET`. CLAUDE.md is updated to reflect the new topology. On first deploy the worker will drain any rows whose `scheduled_for <= NOW()` immediately — expected behavior, but worth knowing if rows have been sitting in the queue.

## v0.1.7.1 — chore(automations): remove openclaw-era cron tooling

Removes the dead automation tooling that was registered into an external openclaw cron runtime that no longer exists. None of it could run for an OSS or self-hosted deployment: the cron installer shelled out to the `openclaw` CLI, and several jobs read board state from hardcoded `~/.openclaw` paths. Deleted 15 `scripts/automations/` scripts plus their support library (the cron installer, manifest, daily-standup/brief, weekly-review, overnight-self-improve, rolling-system-reference, runtime-error intake, GitHub-feedback connector, ci-watcher-dispatch, private-repo-backup, staging-deploy, nightly-marketing-synthetic, verify-automations), the 13 matching openclaw-era cron skills under `skills/` including the whole `skills/operations/` directory and the openclaw cron templates, the tests covering the removed scripts, and the 10 `automation:*` npm scripts. `scheduled-posts-worker.mjs` — the worker that drains the `scheduled_posts` table and publishes due posts to Meta — is kept along with its four tests; it has no openclaw coupling and runs on any scheduler. The `bug-triage` and `feature-pipeline` skills are kept, with their references to the removed `feedback-connector`/`staging-deploy` scripts replaced by direct equivalents. `CLAUDE.md`, `docs/SYSTEM-REFERENCE.md`, `memory/README.md`, and `skills/index.json` were updated to drop references to the removed tooling, and the marketing runtime-error bridge's `validationCommand` now points at the still-valid `npm run validate:marketing-flow`. Lint, typecheck, and the `npm run verify` regression gate all pass.

## v0.1.7.0 — fix(security): close three CSO audit findings — issue-agent gating, SHA-pinned actions, SSRF-safe fetch

Resolves the three HIGH-severity findings from the 2026-05-22 CSO security audit. The `issue-agent-fix` workflow previously launched a write-capable autonomous coding agent on every newly opened public GitHub issue, embedding the untrusted issue title and body straight into the agent prompt — a prompt-injection path into a workflow with `contents`/`issues`/`pull-requests` write scope. The workflow now triggers only on a maintainer-applied `agent:fix` label (or manual dispatch), and the issue title/body are fenced with explicit untrusted-input delimiters and an instruction never to follow directives inside them. Third-party GitHub Actions in the three privileged workflows (`anthropics/claude-code-action`, `docker/login-action`, `docker/setup-buildx-action`) are pinned to full commit SHAs instead of mutable tags, so a retargeted tag or compromised action release cannot reach repository write tokens or the self-hosted runner. The URL-preview brand-kit extraction path is now SSRF-hardened: a new `lib/ssrf-safe-fetch.ts` helper resolves DNS and rejects any address in a private, loopback, link-local, CGNAT, or unique-local range (IPv4 and IPv6, including the cloud metadata IP and IPv4-mapped forms), follows redirects manually with per-hop revalidation, and is wired into every server-side fetch in `brand-kit.ts` so attacker-controlled stylesheet URLs and redirect chains can no longer probe internal infrastructure. The url-preview route also rejects IPv6 literal hosts as defense-in-depth. Twelve regression tests cover the new helper; typecheck, lint, and the `npm run verify` gate all pass.

## v0.1.6.6 — chore(deps): modernize dependencies and upgrade to React 19

Three dependency cleanups in one pass. The unused `three`, `@react-three/fiber`, and `@react-three/drei` packages — dead weight with zero imports anywhere in the app — are removed, along with `@types/three`. `lucide-react` is upgraded to v1, which dropped all brand icons; the five brand glyphs the app still used (Facebook, Instagram, LinkedIn, YouTube, Chrome) are now inline SVG components in `frontend/aries-v1/brand-icons.tsx`, drop-in compatible with the lucide icon API. React and React DOM are upgraded from 18.3 to 19, along with their type packages and `react-test-renderer`; the React 19 type changes (the removed global `JSX` namespace, stricter element `props` typing) were resolved across the affected files. Typecheck, lint, the regression suite, and a full Turbopack production build all pass.

## v0.1.6.5 — fix(security): return literal error codes from profile route handlers

Closes the last two CodeQL `js/stack-trace-exposure` alerts (#8 and #13). v0.1.6.4 cleaned the unexpected/500 path, but the domain-error 400/422 branches in `business/profile` and `tenant/profiles` still returned the caught error's `.message` to the client, which CodeQL traces back to error data. Those branches now return literal error codes (`invalid_role`, `missing_required_fields:email`, `invalid_website_url`, and similar) and imported constants instead of the raw message. The `business/profile` `errorStatus` helper is replaced with `classifyClientError`, which maps each known error to a safe code plus HTTP status in one place. Two dynamic suffixes are dropped: the bad timezone value on `invalid_timezone` errors, and the inner failure detail on `brand_kit_fetch_failed` errors — both were error-derived and not needed by the frontend.

## v0.1.6.4 — fix(security): stop leaking error detail on profile route 500s

Completes the v0.1.6.3 error-exposure work. CodeQL still flagged three profile route handlers (`business/profile`, `tenant/profiles`, `tenant/profiles/[userId]`) for `js/stack-trace-exposure`: v0.1.6.3 genericized the authentication-error paths, but the database-operation catch blocks still returned raw `error.message` to the client on unexpected failures. Those 500-path responses now return a generic "An unexpected error occurred"; known domain error codes (field validation, `tenant_not_found`, `invalid_role`, `brand_kit_*`) are still returned literally so the frontend contract is unchanged. The full error and stack trace are now logged server-side, so debuggability is preserved. Closes CodeQL alerts #8, #13, and #14.

## v0.1.6.3 — fix(security): resolve CodeQL ReDoS and error-exposure findings

Fixes the open CodeQL code-scanning security findings. The email-validation regex in the forgot-password, reset-password, and early-access routes had ambiguous quantifier overlap that allowed polynomial-time backtracking on crafted input (a denial-of-service vector); it is replaced with a non-backtracking pattern that requires a properly dotted domain. Nine API route handlers (calendar sync, integrations, publish dispatch/retry, Facebook/Instagram publish, tenant profiles, business profile) returned raw error messages to clients, leaking internal error detail; they now return generic messages. Two findings in the deleted `lobster/` Python files were already resolved by the v0.1.6.0 OpenClaw removal. The `postcss` Dependabot advisory is resolved by the batched dependency PR.

## v0.1.6.2 — chore(deps): batched dependency updates

Consolidates routine dependency updates into a single change: `three` 0.183→0.184, `motion` 12.38→12.40, `pg` 8.20→8.21, `postcss` 8.5.11→8.5.15, `tailwindcss` and `@tailwindcss/postcss` 4.2→4.3, `@types/node` 22→25, plus the `actions/checkout` (v5→v6) and `actions/setup-node` (v4→v6) GitHub Actions. Typecheck, lint, the verify suite, and a full production build all pass. Three Dependabot updates were intentionally excluded as breaking and deferred to dedicated follow-ups: `react-dom` 19 (a React 18→19 migration is its own project), `@react-three/drei` 10 (requires `@react-three/fiber` 9 and React 19), and `lucide-react` 1.x (its v1 removed the Facebook/Instagram/LinkedIn/YouTube brand icons the app imports).

## v0.1.6.1 — docs: link to the Hermes execution agent

The self-hosting documentation now links to Hermes, the execution agent that Aries hands long-running workflow execution to. The README "What's not in this repository" section, `docs/SELF_HOSTING.md` prerequisites, and `docs/ARCHITECTURE.md` all point to https://github.com/NousResearch/hermes-agent so anyone self-hosting Aries can run their own Hermes endpoint.

## v0.1.6.0 — refactor: remove legacy OpenClaw/Lobster and prepare the repo for open source

The legacy OpenClaw/Lobster execution path is fully removed and the repository is prepared for an open-source release. Hermes is now the sole execution provider — `backend/openclaw/`, the `lobster/` pipeline, the legacy provider adapters, and the `marketing-pipeline.lobster` machinery are gone, and `provider-factory.ts` resolves to Hermes unconditionally. The lobster-named artifact-cache environment variables were renamed to neutral names (`LOBSTER_STAGE*_CACHE_DIR` to `ARTIFACT_STAGE*_CACHE_DIR`, `OPENCLAW_LOBSTER_CWD` to `ARTIFACT_PIPELINE_CWD`, and similar) while keeping their default filesystem paths intact. The dead `brand_campaign` job type — which only ever ran on the Lobster engine — was removed along with its multi-stage approval test, leaving `weekly_social_content` as the sole job type. For the open-source release the repo now carries an Apache-2.0 LICENSE and NOTICE, governance and community files (SECURITY, CONTRIBUTING, CODE_OF_CONDUCT, GOVERNANCE, SUPPORT, TRADEMARKS, ACCEPTABLE_USE), `.github/` CODEOWNERS, Dependabot config, and structured issue and PR templates, six public docs under `docs/` (architecture, self-hosting, deployment, OAuth scopes, security model, commercial positioning), a README rewritten for a public audience, and package.json open-source metadata. Internal operator scaffolding (`.ralph/`, `.sisyphus/`, `qa-reports/`, `memory/`) is no longer tracked.

## v0.1.5.6 — fix(media): trust the creative_assets table for Hermes media ownership

The `/api/internal/hermes/media` route proved tenant ownership by filesystem-scanning marketing runtime documents for the image basename, recognizing only the social-content and `weekly_content_plan` document shapes. Brand-campaign jobs store generated images under `stages.production.primary_output.artifacts.creative_assets`, a shape the scan did not walk, so the route returned "Not found" for legitimately owned assets — every calendar backlog thumbnail and every creative-review image for those jobs failed to load. `tenantOwnsHermesMediaBasename` now also consults the `creative_assets` table, the authoritative record of which tenant owns which asset, so any asset row owned by the tenant resolves regardless of runtime-document shape.

## v0.1.5.5 — fix(calendar): five UX and accessibility fixes for the scheduling calendar

Live QA of the publish calendar surfaced five issues, all now fixed. Backlog posts could only be scheduled by mouse drag — the drag handles announced themselves to screen readers as keyboard-operable, but no `KeyboardSensor` was registered, so Space and Enter did nothing; the calendar now registers a keyboard drag sensor, and each backlog tile carries an explicit "Schedule" button reachable by mouse and keyboard alike. The calendar page blocked its entire render behind a slow campaigns fetch, leaving a 20-30 second blank screen; it now renders as soon as the queue data is ready, and the campaign strip shows its own loading state. The event modal gained a "Publish now" action for pending or failed posts, which queues the post for the next dispatch pass and confirms before closing. Backlog tiles now show the post's image thumbnail instead of caption text alone.

## v0.1.5.4 — fix(marketing): ingest generated images into creative_assets

Completed Hermes pipelines now ingest their generated images instead of silently dropping every one. The creative-asset ingest's `INSERT ... ON CONFLICT (tenant_id, checksum)` omitted the `WHERE checksum IS NOT NULL` predicate of the partial unique index it targets, so PostgreSQL could not infer the index and rejected every row — every completed campaign ingested zero `creative_assets`, leaving synthesized posts without media. The clause now repeats the predicate, so each image persists and posts carry their real images. Verified against the live database, not a mock.

## v0.1.5.3 — fix(marketing): completed pipelines populate the calendar + publish-items count + failure taxonomy

Three marketing fixes that, together, make a completed Hermes pipeline actually surface its work and make publish failures honest.

**Completed pipelines now create posts.** v0.1.5.1 and v0.1.5.2 added creative-asset ingestion and publish-post synthesis, but a real end-to-end campaign still produced zero posts — root-caused to two ordering/guard bugs in the publish-completion callback. The creative-asset ingestion ran before the completion writer had populated the production stage's output on the runtime document, so it read an empty stage and ingested nothing; it now runs after the stage output is written. And the post synthesizer deferred whenever the publish stage carried any `publish_package` at all — but the Hermes publish agent commonly returns a thin, plan-only `publish_package` (cadence and schedule notes, no per-post previews or media) that nothing downstream can turn into posts. The synthesizer now defers only for a `publish_package` a consumer can actually use, and synthesizes posts otherwise. A completed pipeline now ingests its creative assets and creates the posts that reach the calendar.

**The dashboard "Publish items" count reflects real posts.** The campaign dashboard's publish-items counter was driven by a runtime-document projection that did not see the `posts` table, so it read zero even when a campaign had real posts. It now counts the actual `posts` rows for the campaign — four completed campaigns that previously showed "Publish items 0" now report their true counts.

**Meta publish failures are split into two honest outcome classes.** A failed Meta publish call previously collapsed every error into one generic failure, hiding whether the post had definitely not gone out or whether its outcome was simply unknown (for example, a response lost after the post may have been created). `MetaPublishError` now carries an `outcomeUnknown` flag, set only on the final-publish missing-id codes, and the Facebook and Instagram publish handlers branch on it so an operator can tell a safe-to-retry failure from one that needs manual verification before retrying.

## v0.1.5.2 — fix(marketing): synthesize approved publish posts so completed pipelines populate the calendar

Closes the last gap in the Hermes-native marketing pipeline: a completed pipeline reported "publish complete" but produced no launch items and nothing the scheduled-posts calendar could show.

**The publish contract was never reimplemented for Hermes.** The legacy OpenClaw publish path emitted a `publish_package` that Aries' launch consumers read; the Hermes-native pipeline never emits it, and no Hermes instruction defines that schema. What Hermes *does* produce reliably is the `content_package` — per-post copy (hook, body, CTA, hashtags, platforms) carried on the production stage — and the rendered images, ingested into `creative_assets` by the v0.1.5.1 fix. Neither became a `posts` row, so a completed pipeline left the operator with an empty launch view and an empty calendar.

**Completed Hermes pipelines now synthesize calendar-ready posts.** When the publish stage completes and Hermes supplied no `publish_package`, the callback synthesizes one `posts` row per content_package entry per target platform, linking each to its rendered image via `creative_asset_ids`. The posts are created approved — consistent with this deployment's autonomous mode, which has no human approval click in the pipeline — so they immediately appear in the calendar's unscheduled backlog and are ready to schedule and publish. The schedule route also gates on an approved `publish`-stage approval record, which the autonomous run never creates, so the synthesizer writes that record too; without it a synthesized post would be rejected at scheduling time. Both halves are idempotent: a replayed callback creates no duplicate posts (via the per-post unique index) and no duplicate approval record (via a deterministic record id). The synthesizer defers entirely when a real `publish_package` is ever present, so the legacy consumer path is never double-served.

## v0.1.5.1 — fix(marketing): resolve Hermes creative_assets via the image mount

A scoped bug fix for a silent publish-output regression: a completed Hermes pipeline reported "publish complete" but the operator dashboard showed "Generated assets 0 / No launch items", and nothing reached the launch view.

**The cause was a path the container could not read.** When the production stage completes, the callback ingests each generated image into the `creative_assets` table by reading the file Hermes reports. Hermes reports that file as a path on the *Hermes host*. The three-profile Hermes routing (v0.1.3.53) moved the content generator's image output into a profile-scoped cache directory — `<hermes>/profiles/aries-content-generator/cache/images/` — that is not the directory bind-mounted into the Aries container. The container can only read the Hermes image cache through its `/hermes-media` mount, keyed by basename. So every ingest `readFile` hit a host path the container has never seen, threw `ENOENT`, was caught and counted as skipped, and the stage finished having inserted zero rows. The single asset that ever ingested did so only during a brief window when Hermes still mirrored images to the legacy cache dir.

**The fix resolves Hermes paths through the mount, and repoints the mount.** Ingestion now takes the basename of whatever path Hermes reports and resolves it against `HERMES_IMAGE_CACHE_MOUNT` — the same basename-keyed approach the `/api/internal/hermes/media` route already uses to serve those images to the browser — with path-traversal guards, so a host path is never read directly. The `docker-compose` Hermes-cache bind mount default now points at the profile cache directory the content generator actually writes to, so the images are reachable from the container. Verified against the live regressed campaign: ingestion goes from 0 of 7 images to 7 of 7. A regression test stands up a temporary mount and feeds the exact host-path shape Hermes emits; it fails without the fix and passes with it.

**This fix only takes effect after a container recreate** — the `docker-compose` mount change must reach the running container.

## v0.1.5.0 — feat(scheduling): calendar planner UI and per-post media scoping

The calendar planner, plus the change that activates v0.1.4.0's dormant per-post media resolver. v0.1.4.0 made the scheduled-posts engine sound; this release builds the operator-facing planner on top of it and closes the last wrong-media gap in the publish path.

**Operators can now see and steer the publish queue.** `/dashboard/calendar` is a week/month grid fed by the real `scheduled_posts` table — every tile is a genuine queued post with a real dispatch status, not a runtime campaign-step event. Operators drag a tile to a new day to reschedule it, and drag approved-but-unscheduled posts onto the grid from a backlog tray to schedule them for the first time; both paths go through the same publish-approval gate, so nothing reaches Meta without sign-off. The calendar shows only real queued rows, so it starts empty and fills as posts are scheduled — no invented entries. The campaign status strip stays fed by the runtime campaigns. A new read endpoint, `GET /api/social-content/scheduled-posts`, is the calendar's single tenant-scoped, date-range-filtered data path; it returns each post's real `job_id`, the per-platform dispatch detail from `scheduled_post_dispatches`, and the unscheduled-approved backlog.

**Scheduling is timezone-correct.** Each tenant has a business timezone — an explicit operator selection in business-profile settings, persisted to both the `business_profiles` table and the file-backed profile record, validated as a real IANA zone, and falling back to a fixed default when unset. The calendar grid, every timestamp label, and the schedule input all render and convert in that one zone, so a post scheduled for 11pm tenant-time lands on the correct grid cell for an operator in any browser timezone. A new `lib/format-timestamp.ts` consolidates five copy-pasted timestamp formatters into one DST-safe module: wall-clock-to-UTC conversion uses `date-fns-tz` with an explicit DST policy, and the `RescheduleDrawer` — built earlier but never mounted — is now mounted from the calendar and reads its `datetime-local` input in the tenant zone rather than the browser zone.

**Multi-image weekly jobs now publish the right image per post.** v0.1.4.0's `resolveMediaUrls` scopes scheduled-post media per post via `posts.creative_asset_ids`, but the publish stage never wrote that column — every row was `'{}'`, so the resolver silently fell back to job scope and a multi-post weekly job could still publish a wrong or mixed image. The publish stage now writes each post's own creative asset ids when it creates the `posts` row, activating the per-post resolver for real and closing the wrong-media bug.

## v0.1.4.0 — fix(scheduling): engine-soundness pass for the scheduled-posts publish queue

Thirteen fixes hardening the scheduled-posts engine so a post placed on the queue actually publishes correctly. The scheduling queue, worker, and dispatch path already existed but carried latent bugs that never fired only because the queue had no rows — this release makes the engine sound before the calendar planner UI (Phase 2) starts writing to it.

**Publishing now requires approval.** The schedule route accepted any post; it now rejects scheduling a post that has no approved publish approval, so nothing reaches Meta without sign-off.

**The worker no longer breaks against the real database.** Two schema drifts are reconciled: the worker and `meta-publishing.ts` referenced a `posts.content` column that production had renamed to `caption`, and `init-db.js` was missing `job_id` plus five other `posts` columns production already had. The worker's row-claim query also locked the nullable side of an outer join — which PostgreSQL rejects outright — now fixed to lock only the queued row.

**Scheduled posts publish the right images.** Dispatch resolved creative assets by tenant only, so a tenant with several posts in flight could publish the wrong post's images. It now resolves per post — matching the post's own asset ids, falling back to job scope when none are recorded — and filters on the storage kinds the asset table actually uses.

**Cross-posting tracks each platform independently.** A scheduled post going to both Facebook and Instagram shared a single status, so a Facebook success plus an Instagram failure could not be represented. Per-platform dispatch state now lives in a new `scheduled_post_dispatches` table, and a partially successful post is no longer reported as failed.

**A crash mid-publish no longer fakes success.** The worker previously marked a row `dispatched` before calling Meta, so a crash left a post that never went out looking sent. Rows now pass through an `in_flight` state and only reach `dispatched` after Meta confirms; a row stuck `in_flight` is reclaimable. The narrow remaining double-publish window — a crash after Meta confirms but before the database commits — is documented in the worker; Meta's publish API exposes no idempotency key to close it fully.

## v0.1.3.55 — fix(marketing): retry-safe publish claims + correct job_type label

Three small marketing fixes from the Phase B follow-up list.

**#34 — A failed Meta publish no longer permanently blocks a retry.** The Instagram and Facebook publish handlers claim a per-platform slot on the publish approval *before* calling the Meta Graph API, so two concurrent requests can't double-post. Previously that claim was never released, so any publish failure (rate limit, network error, transient Meta error) left the platform marked `consumed` forever and every retry was rejected with `publish_approval_already_consumed`. New `releaseMarketingApprovalPlatformClaim` (`backend/marketing/approval-store.ts`) rolls the claim back under the approval lock when `publishToMetaGraph` fails; a post that went live but only failed verification keeps its claim. The provider-availability and no-content checks now run before consumption so those failures never leak a claim either. A swallowed rollback lock-error is logged with the approval and platform ids so a stuck claim stays diagnosable.

**#38 — Honest coverage for the missing-approval-payload callback.** `tests/hermes-callback-route.test.ts` had a test named "rejects malformed approval payloads" that actually fed a present-but-wrong-stage approval — which the route correctly rejects as `approval_stage_mismatch` (already covered by two other tests), not `missing_approval_payload`. The test now omits the approval envelope entirely, so it genuinely exercises the `missing_approval_payload` path.

**#41 — Weekly jobs are labelled `weekly_social_content`, not `brand_campaign`.** `job_type` on the marketing runtime document was hardcoded to `brand_campaign` for every job, disagreeing with `inputs.request.jobType` (which drives the pipeline) on weekly social-content jobs. It is now derived from `payload.jobType` with the exact strict equality `requestedJobTypeFromDoc()` uses, so the label can never disagree with the pipeline driver. The type widened to `'brand_campaign' | 'weekly_social_content'`.

**Known limitation:** because the rollback re-enables retries of a non-idempotent publish, a publish call that succeeds at Meta but throws before returning (lost HTTP response, or a 200 with a malformed body) can be retried and double-post. This is the inherent trade-off of unblocking stuck retries — the prior "never roll back" behavior avoided it only by guaranteeing a stuck claim instead.

## v0.1.3.54 — fix(marketing): terminate the weekly publish stage instead of looping it

The v0.1.3.53 three-profile cutover introduced a publish-stage loop. `buildWeeklyPublishInstructions` always told Hermes to return `requires_approval`, with no terminal path — so after the resume→run conversion, every publish run re-emitted an approval request, the orchestrator re-created the checkpoint, and auto-approve looped the publish stage indefinitely. A weekly campaign would never reach `completed`.

**Fix (`backend/marketing/ports/hermes.ts`)**

New `buildWeeklyPublishFinalizeInstructions` returns a terminal `completed` envelope with no approval object. The publish-stage instruction selection now branches on the resume's `workflowStepId`: the final publish approval (`approve_stage_4_publish`) gets the terminal finalize instructions; the first publish run keeps the normal instructions that emit the in-stage approval checkpoint. The orchestrator's existing publish-completion path then closes the job once the publish run returns a non-`requires_approval` envelope.

## v0.1.3.53 — refactor(marketing): three-profile Hermes routing for the weekly social pipeline

The weekly social-content pipeline ran every stage — research, strategy, production, publish — through one monolithic Hermes agent. That single agent structurally regressed: told to generate images it dropped copywriting; the strategy stage wrote JSON instead of reasoning. This release routes each stage to a dedicated Hermes profile so each agent does one job well.

**Per-profile routing (`backend/marketing/ports/hermes.ts`)**

Each marketing stage now targets its own Hermes profile gateway:
- research → `aries-research` (web/search tools)
- strategy + publish → `aries-strategist` (pure reasoning, no tools)
- production → `aries-content-generator` (`image_gen` toolset)

The target profile is derived from the stage the orchestrator already passes, so no orchestrator change is needed. Every per-profile gateway URL/key env var falls back to `HERMES_GATEWAY_URL` / `HERMES_API_SERVER_KEY` — a deployment that has not set the per-profile vars behaves exactly as the historical single-gateway setup.

**Per-stage instruction builders**

`buildHermesInstructions` for the weekly workflow is split into four short per-stage builders behind `buildHermesStageInstructions(workflowKey, stage)`. Each ships only its stage's contract: the strategist builder carries no `image_generate` text, the production builder carries no research tool policy.

**Resume → independent run**

A resume token issued by one profile's gateway cannot resume on another. An approved weekly strategy/production/publish transition is now dispatched as a fresh `action: run` POST on the stage's dedicated profile, carrying the prior stage's output as input. A weekly denial short-circuits before any POST — the denying stage's run has already completed, so there is nothing to cancel; the orchestrator records the denied state locally.

**Config**

`docker-compose.yml` wires `aries-strategist` (gateway port 8654) and `aries-content-generator` (port 8655); the research stage stays on the default gateway. `.env.example` documents all six per-profile vars.

## v0.1.3.52 — fix(publishing): poll Instagram media container until FINISHED before publish

Instagram's Graph API requires the media container to reach `FINISHED` before `/media_publish` is called. Previously `publishInstagram` called `/media_publish` immediately after `createInstagramContainer()`, causing `graph_api_error: "Media ID is not available"` when the container was still `IN_PROGRESS` (campaign mkt_d166d5e6).

**Fix (`backend/integrations/meta-publishing.ts`)**

New exported helper `waitForInstagramContainerReady` polls `GET /{creationId}?fields=status_code` in a loop before the `/media_publish` call:
- `FINISHED` or `PUBLISHED` — returns immediately, proceed to publish.
- `ERROR` or `EXPIRED` — throws `MetaPublishError('instagram_container_failed', ..., { status: 422, retryable: false })`.
- `IN_PROGRESS` or unexpected — waits and polls again.
- Backoff schedule: 2s, 3s, 4s, then 5s per poll; 15 attempts max (~60s budget).
- Timeout throws `MetaPublishError('instagram_container_timeout', ..., { status: 504, retryable: true })`.
- Accepts optional `sleepImpl` for fast test injection; defaults to module-internal `sleep()`.

**Tests (`tests/meta-publishing.test.ts`)** — 3 new tests:
- `IN_PROGRESS x2 then FINISHED` — resolves, confirms poll called 3 times, `media_publish` called once.
- `ERROR status` — throws `instagram_container_failed`.
- `Never FINISHED` — throws `instagram_container_timeout` after 15 exhausted attempts.
Existing Instagram container test updated to handle the poll call (3 total fetch calls, not 2).

## v0.1.3.52 — fix(marketing): production copy + brand-kit operator precedence + caption fallback

Three regressions introduced in v0.1.3.49 (Phase A image generation) are fixed.

**Regression 1 — Production stage dropped content_package[] (empty captions) (`backend/marketing/ports/hermes.ts`, `backend/social-content/workflow-request.ts`)**

The PRODUCTION STAGE EXECUTION CONTRACT clause in `buildHermesInstructions()` stated "Returning content_package without artifacts.creative_assets is a violation". The LLM read this as either/or and returned images but dropped post copy entirely, causing blank captions on FB/IG. The clause is rewritten to require BOTH artifacts:
- `content_package[]` — one entry per post with: `post_number`, `theme`, `hook`, `body`, `cta`, `hashtags` (array of 3-6 tags), `platforms`, `format`, `visual_prompt`.
- `artifacts.creative_assets[]` — one generated image per post.

The clause now states explicitly: "You MUST return content_package AND artifacts.creative_assets. One without the other is incomplete." Applied to both the weekly social-content branch and the generic branch. The same output contract block in `buildProductionResumeContext()` is extended to describe both required sections including the content_package schema with hashtags.

**Regression 2 — Brand enrichment overrode operator-supplied styleVibe (`backend/marketing/brand-kit-enrich.ts`, `backend/marketing/brand-kit.ts`, `backend/social-content/workflow-request.ts`)**

`ARIES_BRAND_ENRICHMENT_ENABLED=1` LLM enrichment was overwriting `style_vibe` and `tone_of_voice` in brand-kit.json even when the operator had explicitly provided `styleVibe` and `brandVoice` in the campaign request. Fixed by adding `OperatorBrandKitOverrides` to `applyBrandKitEnrichment()` with precedence: operator request > existing brand kit > LLM enrichment. `extractEnrichAndSaveTenantBrandKit()` accepts optional `operatorOverrides`. `ensureFreshBrandKitForWeeklyRun()` extracts `styleVibe`/`brandVoice` from the doc's request and threads them through. Enrichment only fills fields the operator left blank.

**Regression 3 — Publish handlers posted empty captions when social-copy.json absent (`app/api/marketing/jobs/[jobId]/publish-facebook/handler.ts`, `publish-instagram/handler.ts`)**

When `ARIES_SOCIAL_COPY_FINALIZE_ENABLED=0` (the current production default), `loadSocialCopyArtifact()` returns null and the handler had no further fallback, posting empty captions. Both handlers now fall back to `runtimeDoc.stages.production.primary_output.content_package[]`: pick the post matching the platform (`platforms` array), fall back to first post, build caption as `${hook}\n\n${body}\n\n${cta}` + hashtags joined with spaces. social-copy.json remains the first-choice path.

Tests: `tests/marketing/build-hermes-instructions.test.ts` extended with 10 new assertions for `content_package`, `creative_assets`, and `hashtags` in both contract branches. New `tests/marketing/brand-kit-operator-precedence.test.ts` (10 tests). New `tests/marketing/publish-handler-caption-fallback.test.ts` (11 tests).

## v0.1.3.51 — fix(publishing): posts.caption column name + per-platform approval consumption

Two downstream bugs that blocked the final FB+IG publish step for multi-platform campaigns:

**Bug 1 — Schema mismatch in publish-verification (`backend/integrations/publish-verification.ts`)**
The INSERT statement referenced a `content` column that does not exist in the `posts` table; the correct column is `caption`. This caused the SQL write to fail after a successful Meta API publish, and the catch block in the publish handlers masked the error as `publish_failed`. Fixed by renaming the column reference and updating the `PersistPublishedPostArgs` type accordingly. Also added `job_id` to the INSERT (previously NULL) so posts can be correlated back to their marketing job.

**Bug 2 — Approval consumed by first platform, blocking second (`publish-facebook/handler.ts`, `publish-instagram/handler.ts`)**
A single `publish`-stage approval is synthesized for multi-platform campaigns. Both platform handlers consumed the approval wholesale (`record.status = 'consumed'`), so whichever ran second returned `publish_requires_approval`. Fixed using Option A (per-platform tracking): added `consumed_platforms: string[]` to `MarketingApprovalRecord`. Each platform handler now checks and appends its own platform key. The record status is flipped to `consumed` only when all platforms from `publish_config.live_publish_platforms` have been registered. Existing records without this field are backfilled to `[]` in `normalizeMarketingApprovalRecord`.

**Additional**: idempotency keys in the posts INSERT now include the platform (`mkt_<job>:publish:<platform>:1`) so FB and IG rows never collide on the UNIQUE constraint.

Tests: `tests/publish-verification.test.ts` updated for renamed fields; new `tests/marketing/publish-approval-consumption.test.ts` covers per-platform accumulation, final consumption, duplicate-platform rejection, and legacy-record backfill.

## v0.1.3.50 — fix(marketing): ingest production creative_assets into DB + workspace view

Phase A (v0.1.3.49 / PR #385) shipped image_generate so the production stage now calls Hermes and writes PNGs to disk. However, no code path read `doc.stages.production.primary_output.artifacts.creative_assets[]` and wrote to the `creative_assets` DB table, leaving the workspace view with empty assets even when 6 PNGs were present on disk.

This release closes the ingest gap:
- New `backend/marketing/ingest-production-assets.ts` module exports `ingestProductionCreativeAssetsToDb` which reads each `creative_assets` entry, computes SHA-256, and upserts into the DB with `ON CONFLICT (tenant_id, checksum) DO NOTHING`. Sequential awaits, per-row try/catch — batch never aborts on a single bad row.
- `backend/marketing/hermes-callbacks.ts` production-completed branch calls the new ingest function before `ingestSocialContentStageMedia`. Wrapped in try/catch; callback remains idempotent.
- `backend/marketing/workspace-views.ts` `buildCampaignWorkspaceView` queries `creative_assets WHERE source_type='generated_by_aries'` after building the creative review and merges DB-backed assets into `creativeReview.assets[]` so publish handlers and the dashboard can find approved creatives.
- 6 new unit tests in `tests/marketing/ingest-production-assets.test.ts` covering SQL shape, ON CONFLICT, per-row error isolation, and empty-path skipping.

## [0.1.3.48] - 2026-05-19

### Fixed
- fix(marketing): bridge-side completing-stage detection. Hermes inconsistently emits two completing-stage shapes — transition descriptors ("research_to_strategy") for research-stage completion, and BARE current-stage names ("strategy" when strategy run finishes) for strategy-stage completion. v0.1.3.47 handled the transition descriptor case in the pre-filter, but the bare-current-stage case still hit `approval_stage_mismatch` (validator wants the NEXT stage, not the current one). v0.1.3.48 adds a second-pass mapping in `buildBridgeCallbackPayload` where we know the current `run.stage`: when `approval.stage === run.stage`, remap via the completing→next table. Pre-filter still handles transition descriptors; bridge is now the per-run-stage disambiguator. Tests extended from 15 → 21 cases covering both Hermes emission shapes per stage transition. Verified against tenant-15 campaign mkt_0029a41b — research → strategy advance worked (v0.1.3.47); strategy → production blocked by this issue.

## [0.1.3.47] - 2026-05-19

### Fixed
- fix(marketing): move all `approval.stage` normalization into the single pre-filter at `workflowOutputFromRunRecord`, where the actual mangling was happening. v0.1.3.43 and v0.1.3.46 patched the wrong layer (`buildBridgeCallbackPayload`) and never actually fired end-to-end because an earlier defensive default-to-`"production"` fallback in `workflowOutputFromRunRecord` (existed since well before v0.1.3.43) was silently mapping anything outside `{plan, creative, video, publish, strategy, production}` to `"production"` — turning both the transition descriptor `"research_to_strategy"` and the bare completing-stage `"research"` into `"production"` before the bridge's normalization ever ran. The bridge then mapped `"production"` → `"publish"` via its completing→next map, and `validateApprovalTransition` rejected with `approval_stage_mismatch` for every brand_campaign / marketing_pipeline job since the regression landed. v0.1.3.47 puts the full normalization at the chokepoint: parse `X_to_Y` first, then accept canonical next-stage names, then fall back through the completing→next map, then default to `"production"` only for truly unknown shapes. Bridge reverts to a pass-through (no double-mapping). Confirmed against tenant-15 campaigns `mkt_43800cee`, `mkt_a8c03f06`, `mkt_34a16faf` (same root cause). Tests updated from 12 → 15 cases covering canonical pass-through, transition parsing, completing-stage mapping, and unknown-stage defense. Long-term fix remains Hermes adopting the v0.1.3.45 shared protocol package so the wire shape is enforced by Zod.

## [0.1.3.46] - 2026-05-19

### Fixed
- fix(marketing): extend `approval.stage` normalization in `buildBridgeCallbackPayload` to handle transition-descriptor shape (`"research_to_strategy"`, `"strategy_to_production"`, `"strategy_to_creative"`, `"production_to_publish"`). v0.1.3.43 closed the bare-completing-stage path (`"research"` → `"strategy"`) but Hermes actually emits the transition descriptor `"X_to_Y"` in prod (verified against `/v1/runs/run_8379acbd1c524b6f89eb066ef77dea80` output on tenant-15 campaign `mkt_a8c03f06-3b86-4557-a442-50996907d741`). That shape wasn't in v0.1.3.43's `COMPLETING_TO_NEXT_STAGE` map, fell through unchanged, and `validateApprovalTransition` rejected with `approval_stage_mismatch` — same symptom as the original v0.1.3.43 incident, different root cause. Fix anchors a `^[a-z][a-z0-9]*_to_([a-z][a-z0-9]*)$` regex ahead of the existing map: transition descriptors get parsed to their next-stage capture group; bare completing-stage names still hit the v0.1.3.43 map; unknown shapes still pass through unchanged. Test file extended from 6 → 12 cases covering all three known emission shapes plus malformed-input defenses (trailing underscore, uppercase, undefined). Social-content-weekly still bypasses this path via its `approvalStep`-based allowlist. Long-term fix remains Hermes adopting the v0.1.3.45 shared protocol package so the wire shape is enforced by Zod, not by a regex shim.

## [0.1.3.45] - 2026-05-19

### Added
- feat(admin): marketing job debug panel at `/admin/marketing/jobs/[jobId]/debug`. Server-rendered Next.js page gated to `tenant_admin` role. Surfaces full job state, per-stage timeline (status, started/ended UTC with local tooltip, duration, Hermes run ID, errors), Aries↔Hermes run-ID mapping table, expandable JSON viewers for submission input/hermes output/approval records per stage, "Copy curl" button per stage generating a reproduction command for Hermes `/v1/runs`, admin-gated "Retry Stage" button with confirm modal for research/strategy/production stages (publish blocked — irreversible), and a gateway ping button. Backed by two new internal routes: `GET /api/internal/admin/marketing/jobs/[jobId]/state` (full state dump including execution runs and approval records, tokens stripped) and `POST /api/internal/admin/marketing/jobs/[jobId]/stages/[stage]/retry` (re-submits a stage via the execution port). Strict tenant isolation on all paths — job not found returns 404 (not 403) for cross-tenant probes. `INTERNAL_API_SECRET` is never leaked to the browser; curl reproduction uses the env-var name as a placeholder. Adds `tests/admin-marketing-debug-route.test.ts` covering: route exports, fixture job shape, curl command secret redaction, approval record listing.
- feat(protocol): shared `@aries/hermes-protocol` package (`packages/aries-hermes-protocol/`) containing Zod schemas + TypeScript types for the Aries ↔ Hermes wire format. `PROTOCOL_VERSION = "1.1.0"`. `approval.stage` next-stage-to-gate convention encoded as `ApprovalStageSchema`. `protocol_version` is required (semver-validated) on submission payloads and optional-but-validated on inbound callbacks; major-version mismatches rejected fail-loud. `stopped` status added to `CallbackStatusSchema` (maps to `cancelled` internally). `submitRawRun` injects `protocol_version` at the chokepoint so no caller can accidentally omit it. Drift gate (`scripts/validate-protocol-drift.mjs`, wired into `npm run lint`) asserts: no inline type redeclarations in `backend/`, `HermesRunCallbackPayloadSchema.safeParse()` is called at runtime, no inline validator-shaped functions bypass Zod. 20 tests pass.

## [0.1.3.43] - 2026-05-19

### Fixed
- fix(marketing): normalize `approval.stage` from completing-stage → next-stage convention at the Hermes port boundary. Hermes emits `output.approval.stage` as the stage that just finished (e.g. `"research"` when research completes and pauses for strategy approval); Aries' `validateApprovalTransition` expects the stage gate to open (e.g. `"strategy"`). Without this normalization every `brand_campaign` / `marketing_pipeline` job hit `approval_stage_mismatch`, the run_id was never stored, and the stale-run reaper killed the job at +600 s. Confirmed root cause for 5+ failed_stale campaigns on tenant-15 today (affected jobs: `mkt_43800cee`, `mkt_89bec5df`, `mkt_2d92adff`, `mkt_ac24a07a`). Fix is a single normalization map (`research→strategy`, `strategy→production`, `production→publish`; terminal `publish` and unknown stages pass through unchanged) applied in `buildBridgeCallbackPayload` before constructing the approval object. Social-content-weekly is unaffected — it uses a separate `approvalStep`-based allowlist path in the validator. Recovery: failed_stale jobs are unrecoverable (run_id was never stored); Brendan should resubmit fresh campaigns — they will succeed with this fix.

## [0.1.3.42] - 2026-05-19

### Added
- feat(integrations): reconnect flow for Meta scope upgrades — detects connected Facebook integrations whose stored `granted_scopes` are missing `pages_show_list` (the new wider scope set from v0.1.3.37) and surfaces a yellow "Update permissions" badge on the integrations card. Clicking opens a confirmation dialog then redirects through the standard OAuth broker with `auth_type=reauthenticate` so Facebook forces full re-consent rather than a silent token link. The callback re-runs page discovery so the user can confirm or switch their connected Page. Badge clears once the new scopes are stored.

## [0.1.3.41] - 2026-05-19

### Added
- feat(tests): end-to-end Meta publish smoke test (`scripts/smoke-meta-publish.ts`, `npm run smoke:meta-publish`). Accepts `--tenant <id>`, `--provider instagram|facebook`, and `--dry-run` flags. Resolves a recent approved creative from runtime state, mints a signed public media URL, probes URL reachability without auth, then calls the publish route via HTTP. In `--dry-run` mode stops before the actual Meta Graph call and emits the full payload for inspection. Includes unit tests for payload-builder helpers (`tests/smoke-meta-publish.test.ts`).

## [0.1.3.40] - 2026-05-19

### Added
- feat(publishing): failure-state UX and retry for Meta publish — maps Meta API error codes to user-facing messages in the Instagram publish drawer (token expired → "Reconnect Meta to publish"; rate limit → "Try again in a moment"; page permission revoked → "Re-authorize Meta"; media unreachable → "Try regenerating creative"; caption policy violation → edit hint). Raw Meta error codes are never exposed to users. Transient errors (rate-limit, 5xx, network) surface a Retry button in the drawer; token/permission errors surface a "Reconnect Meta" link to `/oauth/connect/instagram?mode=reconnect`. After the drawer closes on error, a persistent banner on the post card shows "Last attempt failed: <reason> · Retry · Dismiss" so the user can recover without reopening the drawer. Publish handler now returns structured `{code, message, retryable, retryAfterSeconds}` error objects instead of generic 500s.

## [0.1.3.39] - 2026-05-19

### Added
- feat(publishing): cron-driven scheduled-posts worker that drains the `scheduled_posts` table every minute, dispatching due rows to the Meta publish pipeline via an internal auth-gated route. Adds `dispatch_status`, `dispatched_at`, `error_at`, `error_message` columns to `scheduled_posts` with a partial index on pending rows. Retries once on transient 5xx/network errors; permanently fails on 4xx (token revoked, page deleted). Idempotent — uses `SELECT ... FOR UPDATE SKIP LOCKED` to prevent double-dispatch across parallel worker instances.

## [0.1.3.38] - 2026-05-19

### Added
- feat(publishing): immediate Facebook Page publish UI — "Publish to Facebook" button on launch-ready publish items with `platform=facebook`, `FacebookPublishDrawer` component, and `POST /api/marketing/jobs/[jobId]/publish-facebook` server route that resolves caption from social-copy.json `facebook_feed` channel, signs the approved creative image URL via the public media proxy, and publishes directly to Meta Graph API with `provider=facebook`.

## [0.1.3.37] - 2026-05-19

### Fixed
- fix(integrations): request the Page-listing and Instagram-publish scopes during Meta OAuth so `/me/accounts` actually returns the user's Pages. Was failing with `meta_no_pages_available` because only `pages_manage_posts` was requested, and `/me/accounts` requires `pages_show_list` to enumerate Pages. Adds `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `business_management`, `instagram_basic`, `instagram_content_publish` to the Facebook provider's default scopes; aligns Instagram provider scopes for the co-provisioned IG-via-FB connection. Permissions are already enabled in the Meta app (Standard Access for app admins/testers); no App Review required for current admin tenants.

## [0.1.3.36] - 2026-05-19

### Added
- feat(publishing): immediate Instagram publish UI — "Publish to Instagram" button on launch-ready publish items, `InstagramPublishDrawer` component, and `POST /api/marketing/jobs/[jobId]/publish-instagram` server route that resolves caption from social-copy.json, signs the approved creative image URL via the v0.1.3.35 public media proxy, and publishes directly to Meta Graph API.

## [0.1.3.35] - 2026-05-19

### Added
- feat(publishing): HMAC-signed short-lived public media proxy so Meta Graph API (esp. Instagram) can fetch creative images during publish dispatch.

## [0.1.3.34] - 2026-05-19

### Added
- feat(marketing): badge campaigns generated with a previous brand-kit version on the campaign list.

## [0.1.3.33] - 2026-05-19

### Added
- feat(integrations): surface connected Facebook Page name + Switch page button on integrations card.

## [0.1.3.32] - 2026-05-18

### Fixed
- fix(social-content): manual new-job form defaults to 6 image creatives, matching backend default (was 2).

## [0.1.3.31] - 2026-05-18

### Fixed
- **`resolveMarketingApproval` now records `state='failed'` on gateway errors.** Regression from be82ed8 (v0.1.3.0): the catch path returned `{status:'error'}` for clean 4xx handling but dropped the `recordFailure` call, leaving the runtime doc stuck in `'running'` on gateway errors. Re-adds `recordFailure(doc, checkpoint.stage, error)` before the structured-error return so the legacy-openclaw path correctly persists failed state.

## [0.1.3.30] - 2026-05-18

### Changed
- **`MarketingExecutionPort` now exposes a public `submitRawRun()` surface** alongside `getCallbackUrl()` and `getSessionKey()`. `submitSocialCopyFinalizeRun` in the orchestrator calls `port.submitRawRun()` instead of duck-typing into private `HermesMarketingPort` internals (`gatewayUrl`, `authHeader`, `fetchImpl`, `sessionKey`, `persistCallbackTokenHash`, `runPollBridge`). All existing behavior — callback token hashing, idempotency keys, gateway error handling, poll-bridge kickoff — is preserved unchanged.

### Added
- `tests/marketing/marketing-execution-port-submit-run.test.ts` — covers `getCallbackUrl`, `getSessionKey`, and `submitRawRun` for both `social_content_weekly` and `social_copy_finalize` workflow keys, plus error paths (gateway unreachable, HTTP 4xx, missing config).

## [0.1.3.29] - 2026-05-18

### Added
- **Social-copy finalize pipeline stage** (feature-flagged, default-OFF via `ARIES_SOCIAL_COPY_FINALIZE_ENABLED`). After image creatives are approved and before video stages, a new `social_copy_finalize` Hermes workflow receives generated images, brand kit, and onboarding marketing focus and returns image-aware captions, hashtags, and CTAs per post. Results surface on `MarketingDashboardPost` (caption/hashtags/cta/copyWarnings) and render in `DashboardPostCard` and `DashboardAssetCard` (reverse-lookup via relatedPostIds). Caption validator enforces per-platform character caps; one retry on invalid responses with constraint feedback; partial results preserved on transient failure so a resume picks up where it left off.
- `backend/social-content/social-copy-store.ts` — atomic per-post write with merge preservation for resume idempotency.
- `backend/social-content/copy-finalize-request.ts` — Hermes workflow request builder (`SOCIAL_COPY_FINALIZE_WORKFLOW_KEY`).
- `backend/social-content/copy-finalize-handler.ts` — handler with caption validator and retry logic.

### Changed
- **DRY refactor:** extracted `backend/social-content/brand-kit-payload.ts` shared helper; `buildSocialContentWeeklyRequest` and `buildProductionResumeContext` now both call it. Closes the pattern that caused v0.1.3.25's silent field-drop on `MarketingBrandKitReference` growth. Byte-shape regression tests in `tests/social-content/brand-kit-payload.test.ts` confirm no behavior change.

### Notes
- Hermes-side workflow `social_copy_finalize` registration and LLM quality eval are prereqs before flipping the flag to `1` in `docker-compose.yml`. The PR ships the Aries-side wiring, UI, and tests only.

## [0.1.3.28] - 2026-05-18

### Fixed
- **Social-content status page now renders all image previews, not just the first 4.** The Assets, Posts, and Publish-queue columns in `frontend/marketing/job-status.tsx` each applied a hardcoded `slice(0, 4)` cap before mapping to card components. At `image_creative_count: 3` this was invisible; after the v0.1.3.27 bump to 6, two creatives were silently dropped from the visible list. The cap is removed — all items from the backend are now rendered. The grid layout scrolls naturally for any count.

## [0.1.3.27] - 2026-05-17

### Fixed
- **`DEFAULT_SOCIAL_CONTENT_COUNTS.imageCreativeCount` in `backend/social-content/types.ts` was still 3 after v0.1.3.26, so the UI-side normalize step (`normalizeWeeklySocialContentPayload` in `payload.ts:158-161`) baked 3 into the saved job doc before the workflow-side `SOCIAL_CONTENT_DEFAULT_SCOPE` ever got consulted.** Verified live on hermes-dev / tenant 16 with job `mkt_ee5b212a-8c34-4b0f-8a54-3151c150e644`: dashboard rendered 3 image creatives, Hermes payload had `scope.image_creative_count: 3` and `media_requests[0].count: 3` — both defaults must track together. Bumps `types.ts:DEFAULT_SOCIAL_CONTENT_COUNTS.imageCreativeCount` from 3 → 6 to match `defaults.ts:SOCIAL_CONTENT_DEFAULT_SCOPE.image_creative_count` so a UI-triggered weekly run with no explicit count actually delivers 6 creatives per the 7-post weekly framing.

## [0.1.3.26] - 2026-05-17

### Changed
- **Weekly social-content runs now generate 6 image creatives by default (was 3), one per static post.** `static_post_count: 7` minus the 1 video script slot leaves 6 static posts that need imagery — the prior default of 3 underdelivered, leaving 4 of the 7 posts without a matching creative. The hard cap also moves from 3 to 6 so operator-supplied `imageCreativeCount: 9` no longer silently clamps to 3. Per-tenant Hermes/Veo image budget doubles (3→6 per weekly run); at 50 tenants this is 300 images/week vs 150. Hermes production-stage tool policy has no per-call cap, so no Hermes prompt change is needed.
- **DRY: `MAX_IMAGE_CREATIVE_COUNT` and `MAX_VIDEO_RENDER_COUNT` now live in `backend/social-content/defaults.ts`** as `SOCIAL_CONTENT_MAX_IMAGE_CREATIVE_COUNT` / `SOCIAL_CONTENT_MAX_VIDEO_RENDER_COUNT`. `payload.ts` and `workflow-request.ts` import the shared constants instead of redefining their own — future cap changes are a one-line edit, not three.

## [0.1.3.25] - 2026-05-17

### Fixed
- **Enrichment fields now win over stale onboarding-derived `req.X` values in Hermes payload builders.** v0.1.3.23 wired `brandKit.style_vibe`, `brandKit.tone_of_voice`, and `brandKit.brand_voice_summary` into the Hermes payload with "operator override wins" semantics, but `req.styleVibe` and `req.brandVoice` are pre-populated at onboarding from heuristic fallbacks (e.g. `"Balanced and professional with neutral clarity"`) rather than operator input — so the stale fallbacks were stomping the LLM-derived signal. Inverted priority for these two fields: enrichment wins when non-null; `req.X` falls back only when enrichment is absent. `tone_of_voice` now always appends as a `Tone: <list>.` suffix when present, even alongside an operator-set voice. Surfaced by post-deploy verification on the hermes-dev / alecferrismusic.com sparse-profile tenant.

## [0.1.3.24] - 2026-05-17

### Changed
- **Enable `ARIES_BRAND_ENRICHMENT_ENABLED` by default in `docker-compose.yml`.** The enrichment plumbing shipped in v0.1.3.23 was env-gated OFF for safe rollout; this flips the default to ON so the weekly social-content workflow and URL-preview route persist LLM-derived `positioning`, `audience`, `tone_of_voice`, and `style_vibe` to `brand-kit.json`. Set `ARIES_BRAND_ENRICHMENT_ENABLED=0` in your environment to disable.

## [0.1.3.23] - 2026-05-17

### Added
- **Enrichment fields from `enrichBrandKitWithGemini` now persist to `brand-kit.json` and flow into the Hermes weekly social-content payload.** Previously the LLM-generated `positioning`, `audience`, `tone_of_voice`, and `style_vibe` fields were computed for the URL-preview card and immediately discarded — the weekly run re-scraped from scratch each time and sent Hermes only the HTML-derived `brand_voice_summary` and `offer_summary`. Four new `string | null` fields on `TenantBrandKit` and `MarketingBrandKitReference` give the enrichment a persistent home.
- **`extractEnrichAndSaveTenantBrandKit` wrapper** in `backend/marketing/brand-kit.ts`: fast path reuses a fresh, already-enriched kit (skipping the LLM call); slow path scrapes, enriches, and persists. Both the `ensureFreshBrandKitForWeeklyRun` weekly kick-off and the `url-preview` route now call this wrapper, so the preview card and the Hermes payload read from the same persisted source.
- **`applyBrandKitEnrichment`** pure merge helper in `backend/marketing/brand-kit-enrich.ts`: enrichment wins per-field when present, null-coalesces to base otherwise.
- **`marketingBrandKitReferenceFromTenantBrandKit`** exported helper in `backend/marketing/runtime-state.ts`: DRYs the three previous inline `MarketingBrandKitReference` literal builders in `orchestrator.ts`, `runtime-state.ts`, and `workflow-request.ts` into one call site that auto-includes any future `TenantBrandKit` additions.

### Changed
- **Hermes weekly payload now carries enrichment-derived brand signals.** `resolveBrandStyleVibe` (new) and `resolveBrandAudience` (new) feed `brand.style_vibe` and `objective.audience` from the persisted brand kit, with operator-note fields winning when set. `resolveBrandVoice` (updated) appends a `"Tone: <tone_of_voice>."` suffix when both voice and tone are present from the kit; operator-supplied `brandVoice` skips the suffix entirely. `resolveBrandOffer` (fixed) now passes `brandKit.positioning` as the positioning argument instead of reusing `offer_summary` as a surrogate.
- **`backward-compat`** `normalizePersistedBrandKit` defaults all four new fields to `null` when loading old `brand-kit.json` files that predate this release — no migration step required.

## [0.1.3.22] - 2026-05-17

### Fixed
- **Hermes research-stage agent looped on local-workspace tools until 600s timeout.** The `instructions()` prompt in `backend/marketing/ports/hermes.ts` did not enumerate allowed or forbidden tools, so the research agent — even after successfully scraping the brand URL and running web searches — frequently looped on `read_file`, `search_files`, and `terminal` until the `did not reach a terminal status` timeout fired. Added an explicit tool policy forbidding `read_file`, `search_files`, `write_file`, and `execute_code`, plus a 6-total-tool-call cap, to both the weekly social-content block and the generic block. A snapshot test now asserts the forbid clause is present in both branches of `buildHermesInstructions`. PR #351 patched the median symptom (thin payloads sending less context); this stops the underlying agent-loop class that persisted even with a rich payload.

## [0.1.3.21] - 2026-05-17

### Changed
- **CLAUDE.md cleanup.** Dropped the stale `## Protected Systems: OpenClaw is Brendan-only` directive — OpenClaw was removed and replaced by Hermes; the line misled past agents researching gateway config.

## [0.1.3.20] - 2026-05-17

### Changed
- **Tenants with sparse brand profile fields now keep working when the Hermes research stage runs.** Tenants whose Business Profile leaves `notes` blank (the minimum-config path through onboarding) previously sent Hermes a thin request — no `brand.notes` field at all and an inline `brand.name` fallback to `brand_kit.brand_name` that worked but wasn't centrally documented. With a thin payload, the research agent scraped the site successfully then looped on `read_file`/`search_files`/`terminal` tool calls until the 600s `did not reach a terminal status` timeout fired. Two new `resolve*` helpers in `backend/social-content/workflow-request.ts` close the gap: `resolveBusinessName` formalizes the existing brand-kit fallback into a named helper, and the new `resolveNotes` falls back to a 300-char-truncated `brand_voice_summary` when operator notes are null. A new `notes: string` field on `SocialContentWeeklyBrandPayload` carries the fallback into the request payload Hermes serializes as part of its prompt. Operator-supplied values still win when present.

- **`SOCIAL_CONTENT_WEEKLY_WORKFLOW_VERSION` bumped to `v2`.** The Hermes idempotency key (`generateIdempotencyKey(ariesRunId, workflow_version, tenantId)`) does not include a payload hash. Without a version bump, the same `ariesRunId` retried after this fallback change could have served a stale pre-fallback cached result. The version bump invalidates the cache so the new fallback path actually exercises on retry.

## [0.1.3.19] - 2026-05-16

### Fixed
- **Hermes media route 404 on legitimate tenant-owned image creatives.** `/api/internal/hermes/media/<basename>` checks tenant ownership via `tenantOwnsHermesMediaBasename`, which previously walked ONLY `social_content_runtime.stages[X].output.weekly_content_plan.image_creatives`. When auto-approve fires on the production→publish gate, the social-content runtime stages get overwritten with the resume-context payload (NOT the production result), so the bridged image_creatives live only in `doc.stages[stage].primary_output` (marketing-side). Ownership check returned false, route returned 404, dashboard <img> tags rendered as broken. Mirrors the v0.1.3.16 dashboard projection fallback. Adds `marketingStagesContainBasename` that walks `doc.stages[stage].primary_output.weekly_content_plan.image_creatives` as a secondary ownership source.

## [0.1.3.18] - 2026-05-16

### Fixed
- **Hardcoded `Math.min(2, ...)` cap in `weeklyMediaDemand` overrode the default image_creative_count and pinned every weekly run to 2 images.** `backend/marketing/orchestrator.ts:273` ignored both the v0.1.3.17 default bump (3) and any tenant-side override, because the outer clamp was `Math.min(2, integerPayloadValue(...))`. Net result: dashboard `imageAds` could never exceed 2 regardless of config. Fix: replace the literal `2` with `SOCIAL_CONTENT_DEFAULT_SCOPE.image_creative_count` so the orchestrator clamp tracks the defaults module as the single source of truth.

## [0.1.3.17] - 2026-05-16

### Changed
- **Default weekly image creative count: 2 → 3.** `SOCIAL_CONTENT_DEFAULT_SCOPE.image_creative_count` and `DEFAULT_SOCIAL_CONTENT_COUNTS.imageCreativeCount` both bumped from 2 to 3. `MAX_IMAGE_CREATIVE_COUNT` in `payload.ts` and `workflow-request.ts` also raised to 3 to match. The autonomous goal-loop verifier expects ≥ 3 image creatives per weekly run; the previous default of 2 left every clean autonomous run one short. All asserting tests updated (5 sites across `marketing-execution-port.test.ts` and `social-content-weekly-defaults.test.ts`).

### Fixed
- **Publish stage left with `completed_at: null` on every publish-skip run.** When publishing is disabled (Meta not connected), the existing publish-skip branch in `applyHermesMarketingCallback` sets `doc.state = 'completed'` but never marked the publish stage record itself complete. Downstream consumers expecting a populated `stages.publish.completed_at` (audit-trail UI, the goal-loop hook) saw null and treated the run as incomplete. Fix: when the publish-skip branch fires, set `publish.status = 'completed'`, `publish.completed_at = now`, `started_at = now` if missing, and a one-line summary `"Publish skipped: publishing not requested."`. Idempotent — only fires when status isn't already `completed`.

## [0.1.3.16] - 2026-05-16

### Fixed
- **Dashboard `Generated assets` count stuck at 0 even when Hermes generated image creatives on disk.** Today's autonomous E2E (`mkt_d6817de2`, v0.1.3.15) completed all 4 stages cleanly with 2 generated images cached at `~/.hermes/cache/images/*.png` and bridged correctly into `doc.stages.production.primary_output.weekly_content_plan.image_creatives`. But the dashboard still showed `Generated assets: 0` / `imageAds: 0` because `latestSocialProjection` (`backend/social-content/dashboard-projection.ts:255`) read ONLY from `social_content_runtime.stages[X].output` — and those slots end up with the resume-context payload (not the production result) after auto-approve fires on the production → publish gate (`workflow_step_id: approve_image_creatives`). The marketing-side bridge writes the canonical `weekly_content_plan.image_creatives` into `doc.stages[stage].primary_output` via `markStageCompleted`, but the social-content-runtime side gets overwritten by the next callback's context.

  Fix: `latestSocialProjection` now also walks `runtimeDoc.stage_order` and parses each `doc.stages[stage].primary_output` via `parseSocialContentWorkflowOutput`, filling any field the social-content runtime didn't supply. The runtime stays the primary source — the marketing-side stages are a strict fallback used only for fields the runtime left empty. Defensive guards: `Array.isArray(runtimeDoc.stage_order)` and `runtimeDoc.stages?.[marketingStage]` so test fixtures without these keys still work.

## [0.1.3.15] - 2026-05-16

### Added
- **Autonomous-mode auto-approve for the weekly marketing pipeline.** When Hermes emits `requires_approval` for the strategy / production / publish gates and the new `ARIES_AUTO_APPROVE_MARKETING_PIPELINE=1` flag is set (default ON in `docker-compose.yml`), Aries synthesizes an `ai-orchestrator` approval directly from `applyHermesMarketingCallback`. Same code path a UI click would take — same `approveMarketingJob` → `resolveMarketingApproval` → `finalizeStrategyAndRunProductionReview` resume chain — just triggered from inside the callback instead of from `app/api/marketing/jobs/[jobId]/approve`. Closes the autonomous E2E loop introduced when v0.1.3.14's `maybeAutoAdvanceNextStage` only covered the `status:completed` Hermes path; today's run `mkt_ac24a07a` came back with `requires_approval` and stalled at the 5-min stale-run-reaper threshold because no Aries-side mechanism resolved the checkpoint.

  Reentrancy verified safe: `withExecutionRunLock` is keyed on `aries_run_id` (`run-store.ts:271`); `port.resumePipeline()` creates a new run record before submitting (`ports/hermes.ts:309`), so the next-stage callback acquires a different lock. `withMarketingApprovalLock` (`approval-store.ts:338`) plus the in-lock record re-read at `orchestrator.ts:1823` keeps a parallel UI click safe — auto-approve treats `approval_not_available` and `approval_resolution_in_progress` returns as benign no-ops. Failure path appends to history and logs `auto_approve_failed` / `auto_approve_threw`; it does NOT call `recordStageFailure` on the awaiting-approval stage, because `resolveMarketingApproval`'s catch already restores the checkpoint via `restoreApprovalCheckpointAfterFailure` (`orchestrator.ts:2070-2103`) — adding stage failure would conflict and strand the doc. The reaper is the catch-all if auto-approve genuinely cannot resolve the gate.

  9 unit tests in `tests/marketing/callback-auto-approve.test.ts`: flag-off default, strategy and production auto-approve, publish-skip no-op, approve-throws path, both idempotent error paths (`approval_not_available`, `approval_resolution_in_progress`), missing-checkpoint guard, missing-tenant guard. Plan + opus eng review (verdict APPROVED_WITH_CHANGES, all 5 required changes applied) saved in `plans/marketing-auto-approve.md`.

## [0.1.3.14] - 2026-05-16

### Fixed
- **Marketing pipeline stalled at research when Hermes returned `status:completed` without `requires_approval` (no progression to strategy).** Today's live E2E (`mkt_89bec5df`, v0.1.3.13) completed research cleanly at 10:53:54 UTC and never started strategy. The orchestrator's stage-advance path lives only in the approval-resume code (`finalizeStrategyAndRunProductionReview` et al.), which throws `missing_*_resume_token` when called without an approval token. With no approval emitted and no auto-advance path, the runtime state file stuck at `running/research/completed` until the stale-run reaper killed it 12.85 min later. Root cause traced to `backend/marketing/hermes-callbacks.ts:937` `markJobCompleted` — it only flips `doc.state` to `completed` when `stage === 'publish'`; non-publish stages get marked complete with no follow-on action.

  Fix: defense-in-depth on the Aries side so the pipeline survives Hermes returning either `requires_approval` (existing path) OR `completed` without approval (new path).

  - **New port verb `MarketingExecutionPort.submitNextStage`** alongside `runPipeline` and `resumePipeline`. Submits the next stage as a fresh run (creates a new `ExecutionRunRecord`), not a resume — bypasses the resume-token requirement.
  - **New helper `maybeAutoAdvanceNextStage`** in `hermes-callbacks.ts`. Fires inside the `payload.status === 'completed'` branch when (a) stage in {research, strategy, production}, (b) no approval payload present, (c) next stage status == `not_started`, (d) doc not terminal, (e) `doc.tenant_id` present. Marks next stage `in_progress` + `started_at` + saves doc **before** submitting so any racing callback or retry sees a non-`not_started` status. On submission failure, records `auto_advance_submit_failed` to the doc and logs structured error.
  - **Hermes payload prefix** — `submissionPayload` injects `Starting stage: ${stage}` into the prompt and `auto_advance: true` into `callback_context` when the submission carries a `starting_stage` argument, so Hermes targets the requested stage rather than restarting from research.
  - **Test coverage** — 9 unit tests in `tests/marketing/callback-auto-advance.test.ts` cover all 6 documented risks from the planning doc (R1 double-submit, R2 multi-stage payload, R3 publish-skip flow, R4 publish-no-op guard, R5 idempotency, R6 missing-resume-token path) plus M1 (tenant context propagation), M4 (try/catch with `auto_advance_submit_failed`), and submit-throws failure path.

  Plan + two-pass review (sonnet eng-review + opus architectural review picking Option A over Option B) recorded in `plans/aries-stage-auto-advance.md`. All gates green: `npm run verify`, `npm run validate:execution-provider` (51 tests), `npm run validate:social-content` (91 tests).

## [0.1.3.13] - 2026-05-16

### Fixed
- **Stale-run reaper cron was never installed (PR #334 follow-up).** PR #334 shipped `scripts/reap-stale-runs.ts` and added `aries-marketing-stale-run-reaper` to the OpenClaw cron manifest, but `npm run automation:install` was never run post-merge, and there is no traditional Linux cron inside the container (`crontab: executable file not found in $PATH`). The manifest's install path calls `openclaw cron add`, which is not available in the container runtime at all. A 30-minute window confirmed zero reaper log lines while a stuck job (mkt_2d92adff) sat past the 10-min research threshold — manual `docker exec ... reap-stale-runs.ts --apply` reaped it immediately, proving the script works but the trigger was absent.

  Fix: mirrors the existing `partner-attribution-outbox-worker` pattern. A new in-process side-process `scripts/stale-run-reaper-worker.ts` is spawned by `scripts/start-runtime.mjs` (both cluster and single-node paths) when `ARIES_REAPER_ENABLED=1`. `docker-compose.yml` defaults `ARIES_REAPER_ENABLED=1` and `ARIES_REAPER_INTERVAL_MS=300000` (5 min), matching the manifest's `*/5 * * * *` schedule. The worker calls `runStaleRunReaper({ dataRoot, dryRun: false })` on each tick and logs `[stale-run-reaper]` lines only when jobs are reaped or errors occur. Shutdown is clean: SIGTERM to the worker on SIGINT/SIGTERM to the primary process.

## [0.1.3.12] - 2026-05-16

### Fixed

- **Stage-gated PNG path fallback for production callbacks (no Stage 1→2 regression).** The schema-agnostic PNG path harvester (`harvestPngPathsRecursively`) and supporting helpers (`isHermesCacheImagePath`, `buildCreativesFromPngFallback`) are re-introduced from PR #341, but now gated strictly to `stage === 'production'` via a new `stage` parameter on `bridgeHermesCreativeAssets`. Research, strategy, and publish callbacks bypass the fallback walker entirely. This eliminates the regression vector from PR #341: a research callback containing competitor screenshot URLs or other image-like strings in `cache/images`-looking paths could match `isHermesCacheImagePath` and inject phantom `image_creatives`, which disrupted the `markStageAwaitingApproval` data that drives the Stage 1→2 "Continue to brand analysis" UI card. `countRecognizedImagesInOutputRecord` also gains Shape 4 (the same walker) for the fail-loud `hermes_image_generation_unrecognized` gate — safe because that function is only called within the production-stage callback path. Live evidence: job `mkt_de108fd2-5b31-4329-9136-0230b822ae17` (v0.1.3.11) rendered two PNGs to `/home/node/.hermes/cache/images/` but the dashboard showed "Generated assets 0 / Image ads 0 / Posts 0" because the un-gated bridge on v0.1.3.11 lacked the fallback; this release restores it with the production-only gate. 11 new tests in `tests/hermes-image-projection-stage-gated.test.ts` cover all four production shapes, the regression path (research with competitor PNG URLs), strategy passthrough, publish passthrough, deduplication, and the fail-loud no-phantom assertion.

## [0.1.3.11] - 2026-05-15

### Reverted
- **Revert v0.1.3.10 PR #341 (schema-agnostic PNG path fallback)** — the fallback worked on its own but live E2E (mkt_2d92adff) showed Stage 1 → 2 UI transition stopped surfacing the "Continue to brand analysis" approval card after this PR landed. The previous run on v0.1.3.9 (mkt_10fd7f1b) successfully walked through all four stages via the UI buttons. Reverting restores Stage 1 → 2 UI behavior. The original image-projection gap (PNGs render to disk but `Generated assets 0` in workspace) returns and needs a separate forward-fix that doesn't disturb the research-callback processing path.

## [0.1.3.9] - 2026-05-15

### Added
- **Real Meta and Instagram publish dispatch (#327).** `app/api/publish/dispatch/handler.ts` now invokes the Graph API for real publishes instead of returning stub responses. Approval enforcement is hard-required: every publish dispatch must present a valid, unconsumed `marketing_approval_record` (atomic consume via DB transaction) — no approval → HTTP 403 with `publish_requires_approval`. Retry path (`app/api/publish/retry/handler.ts`) is now idempotent via a new unique index on `posts (tenant_id, platform, idempotency_key)` plus pre-Graph short-circuit when a successful post row already exists. `requestGraphJson()` (`backend/integrations/meta-publishing.ts`) retries 429s with `Retry-After` backoff (capped, bounded retry budget). Migration: `migrations/20260515120000_posts_idempotency_key.sql`. Covered by 10 new tests in `publish-dispatch-approval.test.ts`.
- **Hermes image bridge multi-schema tolerance + canonical schema in resume prompt (#337).** `bridgeHermesCreativeAssets` in `backend/marketing/hermes-callbacks.ts` now accepts THREE Hermes output shapes: legacy `image_creatives[]`, `artifacts.creative_assets[]` (May-13 working shape), and `artifacts.images[].filePath` (May-15 emerging shape). Schema variance is inherent because Hermes is a pure LLM agent with no enforced output contract. `buildProductionResumeContext` in `backend/marketing/workflow-request.ts` now shows Hermes the canonical `creative_assets` JSON schema verbatim in the resume rich-prompt — defense in depth so Hermes prefers the recognized shape. New `productionCallbackImageGenerationUnrecognized` check fails loud with code `hermes_image_generation_unrecognized` when `media_requests` count > 0 but zero recognized images surface across any known shape. 13 new tests in `hermes-image-bridge-multischema.test.ts` and `hermes-image-generation-fail-loud.test.ts`.
- **Video render artifact ingest from Hermes cache (#326).** `backend/social-content/media-ingest.ts` now ingests `social_content_weekly` video outputs into local `DATA_ROOT` mirroring the existing image-ingest pattern. Source allowlist narrowed to explicit Hermes cache dirs (`~/.hermes/cache/videos` only — not `~/.hermes` broadly) for tenant isolation. ReDoS hardening: replaced ambiguous slug regex with split anchored passes + 256-char input cap. Bonus fix: `approve_video_render` and `approve_video_script` no longer misclassified as `production`-stage approvals (`backend/execution/hermes-callbacks.ts`).
- **Stale-run reaper for stuck marketing jobs (#334).** New `aries-marketing-stale-run-reaper` cron (every 5 min) sweeps `running` jobs whose latest progress timestamp exceeds per-stage thresholds (research 10m, strategy 5m, production 90m, publish 5m — env overridable). Mutates to `failed_stale` with structured code `marketing_job_stalled`. Closes the `mkt_e6d7d734`-style "frozen forever" failure mode.

### Fixed
- **Brand-kit: stale "handcrafted leather goods" copy purged from active profiles (#335).** `repairStaleMarketingOffer` in `backend/marketing/brand-kit.ts` runs in the business-profile projection, workspace brief normalization, and social-content request builder paths. Removes the stale descriptor while preserving real coaching-network offer text. Idempotent dry-run/apply script `scripts/repair-stale-brand-offers.ts`. Also fixed: `creative_briefs` in image `media_requests` no longer leak the raw stale offer (was constructed pre-repair).
- **CI: deploy.yml actions bumped past Node 20 deprecation cutoff (#333).** `actions/checkout` v4→v5.0.1, `docker/login-action` v3→v4.1.0, `docker/setup-buildx-action` v3→v4.0.0 across deploy, PR-agent autofix, and issue-agent-fix workflows. checkout intentionally held at v5.0.1 (not v6) to avoid the credential-persistence behavior shift.

## [0.1.3.8] - 2026-05-15

### Fixed
- **Gating: failed runs no longer block new weekly content runs.** `Generate this week's content` was disabled whenever any run existed — including terminal-failed runs — because the guard used a raw "any in-progress run" check that did not exclude terminal states. The fix threads a new `executionState` field through `backend/marketing/runtime-views.ts`, uses `isPipelineActive()` to exclude terminal states (`failed`, `cancelled`, `timed_out`), and updates `frontend/aries-v1/generate-this-week.ts` and `lib/api/aries-v1.ts` accordingly. The campaigns list also previously mislabelled failed runs as "Campaign in progress" — that label now reflects the actual terminal state. Covered by expanded tests in `dashboard-generate-week-trigger.test.ts`, `dashboard-home-view-model.test.ts`, and `calendar-view-model.test.ts`.
- **Image generation: rich per-image prompts + fail-loud verification.** Hermes was silently completing production callbacks that contained only `image_creatives` prompt entries (no rendered image files) — meaning the `image_generate` tool call was quietly skipped and the dashboard showed zero images. The fix has two parts: (1) `backend/social-content/workflow-request.ts` now injects a rich per-image context block into every production resume sent to Hermes — including N-of-M framing, brand voice/palette/must-avoid constraints from research output, creative strategy, and platform-aware aspect ratio — so Hermes has the context it needs to actually call `image_generate`; (2) `backend/marketing/hermes-callbacks.ts` and `backend/marketing/ports/hermes.ts` now reject production callbacks whose `image_creatives` entries lack rendered image paths, returning a 422 so the run fails loud rather than silently completing with no images. No Hermes-side changes required. Covered by 11 new tests in `social-content-rich-prompts-and-failloud.test.ts`.

## [0.1.3.7] - 2026-05-14

### Added
- **Hermes research guidance via `last30days` skill.** Both `instructions()` branches in `backend/marketing/ports/hermes.ts` now instruct Hermes to use the `last30days` skill when researching the brand URL and competitor URL. Requires `SCRAPECREATORS_API_KEY` in the Hermes environment to return live data.

### Fixed
- **Workflow UI: runtime status fold-in (fixes navigational dead-end).** "View runtime status" previously routed to a bare `/dashboard/social-content/[jobId]` page with no back/forward/stage navigation and a blank Job ID form. The runtime status is now rendered as a "Runtime Status" view inside the campaign workspace shell (`frontend/aries-v1/campaign-workspace.tsx` + `campaign-workspace-state.ts`). Legacy `/social-content/status` and `/social-content/review` routes are left as-is (still linked from other surfaces; a separate broader PR can redirect them).

## [0.1.3.6] - 2026-05-14

### Fixed
- **Social-content sub-stages no longer strand when `approve_publish` skips the publish step.** The `approve_publish` publish-skip terminal path in `backend/marketing/hermes-callbacks.ts` was marking the job `completed` without sweeping in-flight social-content sub-stages — leaving `copy_production`, `image_briefing`, and `image_generation` perpetually `in_progress` (root cause of the `mkt_0735c3b1` stranding failure). A new `reconcileSocialContentIntermediateStages()` call in `backend/social-content/runtime-state.ts` runs immediately before the `completed` sentinel is written, sweeping any in-flight sub-stage to `completed`. **Known bounds:** (1) The sweep is only as good as the stage the callback reports — if Hermes ever sends an earlier `payload.stage`, later stages could still strand; worth a follow-up if that pattern appears. (2) The reconcile MUST run before the `completed` sentinel is set; ordering is currently correct and should be preserved.

## [0.1.3.5] - 2026-05-14

### Fixed
- **Hermes media route now enforces per-tenant ownership.** The `/api/internal/hermes/media/[...path]` route added in v0.1.3.4 deferred tenant-scoping (noted in a route `NOTE:` comment). This release closes that gap: `resolveHermesMediaTenantOwnership()` in `backend/marketing/runtime-state.ts` performs a sequential filesystem scan of the tenant's social-content run state to confirm the requested basename belongs to the authenticated tenant before serving the file. Cross-tenant requests receive 404 (not 403, to avoid leaking file existence). Path-traversal containment from v0.1.3.4 is preserved. No database fan-out — the scan is FS-only (guardrail #1). Covered by 7 unit tests including a path-traversal assertion.

## [0.1.3.4] - 2026-05-14

### Added
- **Hermes image bridge: generated images from social-content runs now render in the dashboard.** Two compounding bugs prevented dashboard images: (1) Hermes emits `creative_assets[].path` (host-absolute filesystem paths) but the schema expected `image_creatives[].artifact_url` (browser-loadable URLs) — a `bridgeHermesCreativeAssets()` function now maps the path to an authenticated internal URL; (2) there was no route to serve those files to the browser — a new session-authed, path-traversal-safe `/api/internal/hermes/media/[basename]` route reads from the Hermes image cache mount. `docker-compose.yml` and `docker-compose.local.yml` add a read-only bind-mount of `~/.hermes/cache/images` at `/hermes-media` inside the container.
- **`/api/internal/hermes/media` route** — session-authenticated image-serving route with path-traversal containment; tenant-ownership scoping is intentionally deferred (see route `NOTE:` comment and PR known follow-up).

## [0.1.3.3] - 2026-05-14

### Fixed
- **Social-content approval transition now uses an explicit per-stage allowlist.** The previous conditional had two logic gaps: research→production skip-forward was allowed, and strategy→strategy self-transition was not caught. Replaced with `SOCIAL_CONTENT_ALLOWED_APPROVAL` record mapping each run stage to exactly one valid approval stage; any other transition (skip, regression, unknown stage) returns `approval_stage_mismatch` and fails loud at the callback boundary instead of silently misrouting the pipeline.

## [0.1.3.2] - 2026-05-13

### Fixed
- **Weekly social-content posts now surface on /dashboard/posts and /dashboard/calendar.** Two wiring gaps prevented the content from reaching the dashboard list endpoints. (1) `parseSocialContentWorkflowOutput` only recognised the `weekly_content_plan` (snake_case) key in Hermes production output, but Hermes actually emits `weeklyPlan` (camelCase); it now accepts either. (2) `buildCampaignWorkspaceView` computed the raw dashboard but never applied `buildSocialContentDashboardProjection`, so posts/assets/calendar events synthesised from the social-content runtime were dropped before the list endpoints read the result. Both gaps are now closed and covered by a regression test.
- **Default weekly post count is now 7 (was 3) to match the "weekly content" product framing.** The new-job form, backend default scope, and workflow request all now default to 7 static posts per week so a fresh run produces a full week of content without the operator needing to manually adjust the count.

## [0.1.3.1] - 2026-05-13

### Fixed
- **Marketing research/strategy stages timed out after 120s against real Hermes runs.** `backend/marketing/ports/hermes.ts` falls back to a 120_000ms code default when `HERMES_RUN_TIMEOUT_MS` is unset, and `docker-compose.yml` was passing the env through with no default, so prod always inherited 120s. On populated tenants the Hermes research agent routinely takes 3-8 minutes, so Aries marked the stage failed before Hermes finished and the operator saw an opaque "did not reach a terminal status" error. Compose default is now `${HERMES_RUN_TIMEOUT_MS:-600000}` (10 min) — per-tenant `.env` overrides still win. After this lands: research/strategy completes against real workloads, no operator action required beyond the redeploy.

## [0.1.3.0] - 2026-05-13

### Fixed
- **Weekly social-content pipeline halted at Stage 1→2 transition because Hermes resume payload had no `input` field.** v0.1.2.9 fixed the upstream contract but the social-content resume branch in `backend/marketing/ports/hermes.ts` still returned a structured object (action/resume_token/approval_step) without the `input` string Hermes `/v1/runs` requires. Approving "Continue to brand analysis" produced HTTP 400 "No user message found in input" and the pipeline never reached Strategy/Production/Publish. Resume payload now serializes a prompt string (workflow key, action, run id, approval step, resume token, approve flag, job id, tenant id, approval id) plus `instructions` and `session_id` mirroring the run path. After this lands: approving research advances Strategy live, the full 4-stage flow completes, and posts surface on /dashboard/posts + /dashboard/calendar.
- **Review-decision endpoint returned 500 on every retry against a failed-state job.** `resolveMarketingApproval`'s outer catch in `backend/marketing/orchestrator.ts` called `handleFailure` which is typed `never` and always rethrows. Any error from `resumeMarketingPipeline` (Hermes network failures, stale resume tokens, `workflow_deny_failed` throws) escaped as an unhandled exception, skipped `assertApprovalResult`, fell through `mapAriesExecutionError`, and produced a generic 500 — which matched every prod campaign's current state (5/5 failed). The outer catch now returns a structured `{status: 'error', reason}` so `assertApprovalResult` converts it to a clean `RuntimeReviewDecisionError(400)` the route handler maps correctly. New regression test in `tests/review-decision-failure-paths.test.ts` walks an approval to Stage 4, stubs `resumePipeline` to throw `hermes_unreachable`, and asserts no uncaught exception + a 4xx surface error.

### Changed
- Removed `gh_config` named volume from `docker-compose.yml`. The web container no longer mounts `/home/node/.config/gh` from a shared volume — `gh` auth state is no longer expected to persist across container restarts.

### Removed
- Archived `docs/product/aries-ai-prd-audit.md` and `docs/product/aries-ai-prd-audit-critical-verification.md` into `docs/audits/2026-05-12-prd-audit*.md` (history preserved via `git mv`). The PRD was a confusing three-document set where two of the three were point-in-time snapshots competing with the live PRD; the audits now live in a clearly historical directory. The live PRD picked up targeted §9.4 (Hermes poll-bridge note), §15.5 (debt status), and §16.3/§19.5 (campaign→posts terminology backlog acknowledgment) updates.

## [0.1.2.9] - 2026-05-13

### Fixed
- **Weekly social content pipeline stalled after research because the Hermes approval contract was wrong.** Commit `eacbdca` tried to fix the prior "Hermes returns `completed` after research and skips strategy/production/publish" bug by encoding an explicit 4-stage requires_approval contract, but it sent `approval.stage="brand"` and `approval.workflowStepId="strategy"|"production"|"publish"|"publish_review"` — none of which are valid identifiers in Aries. `parseApproval` drops the research callback (rejected with `missing_approval_payload`), and on the default-on poll-bridge path the stage gets silently rewritten to `"production"` which produces a malformed checkpoint that skips the `strategy` stage entirely. The frontend `approvalStepToView` returns `null` for the bad workflow_step_id, so the "Continue to brand analysis" CTA never renders. Restore the canonical identifiers proven by `tests/marketing-hermes-callback-flow.test.ts` (`approval_step` in {approve_weekly_plan, approve_post_copy, approve_publish}; `workflowStepId` in {approve_stage_2, approve_stage_3, approve_stage_4, approve_stage_4_publish}) and add `approval_step` to the schema hint. Every downstream component (parser, validator, approval-store, jobs-status projection, frontend view-mapper, friendly first-checkpoint CTA gate) was already wired for these exact identifiers; the fix flips the upstream instructions to match. Live behaviour after this lands: research completes, workspace shows "Continue to brand analysis" with a working approve-and-continue button, strategy fires, production fires, publish fires, posts surface in the dashboard.
- **Onboarding submitters landed on a "Welcome Back" login page they had no account for.** After completing the 5-step unauthenticated onboarding flow and clicking "Save and continue", new users were sent to `/login?callbackUrl=/onboarding/resume...&draftSaved=1&businessName=...` where the primary heading reads "Welcome Back / Sign in to your Aries AI account". The "create one" link was small text at the bottom. The login page now server-side redirects to `/signup` with all query params preserved when `draftSaved=1` and `callbackUrl` starts with `/onboarding/resume`, so first-time onboarders land on Create Account instead of Sign In.
- **Competitor URL validation error leaked the raw server field name.** The inline error on the Goal step was `competitor_url must be the competitor's website, not a Facebook or Ad Library URL` but the visible UI label is "Competitor website". Replaced both error constants in `lib/marketing-competitor.ts` (and their copies in `lobster/bin/meta-ads-extractor`) with user-facing copy ("Competitor website must point to the competitor's site..." / "Competitor website must be a valid HTTPS URL") and updated the four test assertions that pin the literal.
- **"Other" goal radio on onboarding did not focus its custom-outcome textarea.** Clicking "Other" revealed the "Describe your business outcome goal" input but left focus on the radio, so the user had to click into the input manually. Added a transition-keyed `useEffect` that focuses the input only when goal flips into `Other` (not on initial draft hydration when Other is already selected).

## [0.1.2.8] - 2026-05-12

### Added
- **Nightly marketing-pipeline synthetic regression gate.** New automation job `aries-nightly-marketing-synthetic` (runs daily at 02:00 America/Los_Angeles) invokes `scripts/automations/nightly-marketing-synthetic.mjs` which verifies prod liveness (`/` + `/api/health/db`), runs `validate:marketing-flow` (orchestrator + Hermes four-stage fan-out contract), and runs `validate:execution-provider` (Hermes adapter + callback route contract). Emits a single-line JSON summary on stdout and exits non-zero on any failure so the cron orchestrator can route failures. Supports `--preflight` and `--dry-run` for `verify-automations` parity.
- **Post-deploy canary configuration.** `scripts/canary/config.json` documents the canonical production URL (`https://aries.sugarandleather.com`), the page list to monitor (`/`, `/signup`, `/dashboard`, `/dashboard/posts`, `/marketing/new-job`, `/onboarding`), API health endpoints, performance thresholds (LCP 3500ms, FCP 2000ms, 2x perf regression alert), and the standard `/canary` invocations. `scripts/canary/README.md` is the operator entry point; `/canary` writes its reports under `.gstack/canary-reports/` (gitignored).
- Marketing orchestrator now fans out a one-shot Hermes completion into all four marketing-pipeline stages. When Hermes returns a single `completed` callback whose `output` carries per-stage entries (either an array of `{stage, run_id, summary, …}` records, or a record with a `stages` sub-object), `applyHermesMarketingCallback` walks `STAGE_ORDER` (`research → strategy → production → publish`), records each stage's artifacts/summary on its own `MarketingStageRecord`, clears the approval checkpoint, and — if `publish` is included — finalizes the job (`state=completed`, `current_stage=publish`) and schedules the publish→honcho write. Single-stage callbacks fall through to the existing path unchanged, and already-terminal stage records are left alone, so late/duplicate one-shot callbacks cannot regress state. This unblocks any Hermes workflow variant that produces the full four-stage marketing result in a single run instead of one callback per stage.

## [0.1.2.7] - 2026-05-12

### Fixed
- Marketing pipeline runs were stranded indefinitely at `research/in_progress` because Hermes's `/v1/runs` API is OpenAI-style polled and **does not invoke the `callback_url`** field that Aries sends. The marketing port submitted the run, returned `kind: 'submitted'`, and waited for a callback that never arrived. Within 5 minutes Hermes would GC the orphaned run, leaving the campaign stuck forever (`isPipelineActive` true, dashboard "Generate this week's content" button disabled, no progress through strategy/production/publish). Added a poll-bridge in `HermesMarketingPort`: after submission, a background task polls `GET /v1/runs/{id}` until terminal, then invokes `handleHermesRunCallback` directly (bypassing the HTTP route and auth since we are already inside the trusted backend). Default-on; disable in tests with `HERMES_POLL_BRIDGE_ENABLED=0`.

## [0.1.2.6] - 2026-05-12

### Fixed
- Weekly social content marketing pipeline was failing immediately at the research stage with HTTP 400 from Hermes (`"No user message found in input"`). `HermesMarketingPort.submissionPayload` for `social_content_weekly` was sending the structured workflow request (`{input: {brand, objective, competitor, ...}, workflow_key, workflow_version, ...}`) as top-level fields, but Hermes's `/v1/runs` is an OpenAI-style chat-completions endpoint that requires `input` to be a string. The brand_campaign path already serialized to a string via `prompt()` and worked; the social-content path bypassed that path and never got migrated. Now both paths serialize the structured request into a prompt string (with `Workflow:`, `Aries run ID:`, `Request (JSON):` lines), keep the workflow key/version/run id in `callback_context` for the callback, and use the same `instructions()` schema spec. The "Generate this week's content" button on the dashboard now actually starts a run instead of failing in 24 ms.

## [0.1.2.5] - 2026-05-12

### Fixed
- Hermes execution adapter was silently 501-ing every non-demo workflow because `HERMES_SUPPORTED_RUN_WORKFLOWS` in `backend/execution/providers/hermes.ts` was hardcoded to `['demo_start']`. PR #258 made Hermes the default provider for all `runAriesWorkflow` callers (calendar sync, sandbox launch, integrations sync, publish retry/dispatch, onboarding start, tenant workflow runs) but never widened the allowlist, so every one of those routes returned HTTP 501 `not_implemented` with the gateway healthy and configured. Marketing was unaffected because it uses a separate `HermesMarketingPort`. The allowlist now derives from `ARIES_WORKFLOWS` in `workflow-catalog.ts`, so the catalog is the single source of truth — any new workflow key added there is automatically reachable through Hermes.
- Hermes adapter's fallback `instructionsForWorkflow()` now communicates the same `{status, output, message}` envelope schema that `demo_start` uses, so the gateway agent gets actionable instructions regardless of workflow key (previously it only got "reply with JSON only" with no schema spec).

## [0.1.2.4] - 2026-05-11

### Added
- Engineering plan for Aries Honcho continuous profile writes (`docs/plans/2026-05-11-aries-honcho-continuous-profile-writes.md`). Maps the four day-to-day write surfaces (approvals/rejections, publishing/performance, UI preferences, pipeline stages 2-4) to the v1 plan's already-designed peers and sessions. Three rollout phases (P1 = strategy approvals + creative rejections, P2 = publishing + performance feedback, P3 = explicit UI preferences). Passed `/plan-eng-review` with 7 architecture decisions locked in (peer mapping, user pseudonym salt reuse, idempotency table, structured reason codes, single `write-events.ts` ingestion module, Phase 2 load test, in-process best-effort writes).
- TODOS.md entries for the three rollout phases. Phase 1 effort revised from M to L after the eng review locked in scope.

## [0.1.2.3] - 2026-05-11

### Changed
- `npm run verify` now catches Next.js 16 route-handler type errors before push. The verify gate runs `next typegen` (generates `.next/types/**/*.ts` route constraints) then `tsc --noEmit` as a pre-suite step, closing the CI gap that required hotfix PR #284.
- `npm run typecheck` and `npm run lint` also run `next typegen` first, so route-handler `RouteHandlerConfig<Route>` constraint violations are visible regardless of which gate the developer uses locally.
- Added `## Deploy Configuration` to CLAUDE.md with the production URL and health-check command, enabling `/land-and-deploy` canary checks against the live environment.

## [0.1.2.2] - 2026-05-07

### Added
- Onboarding "Brand identity" step now has the wiring to show real LLM analysis (brand voice, offer, positioning, audience, tone of voice, style vibe) instead of the truncated meta-description text the heuristic scraper produced. The enrichment lives behind the `ARIES_BRAND_ENRICHMENT_ENABLED` flag (off by default) and routes through Hermes; until the flag is flipped, the step renders the existing scraper output unchanged.

### For contributors
- Added `backend/marketing/brand-kit-enrich.ts` as the Hermes-backed enrichment helper. It submits a structured JSON-schema prompt to `/v1/runs`, sync-polls until terminal, and returns typed failure reasons (disabled, not_configured, unreachable, timeout, run_failed, output_invalid) so callers can fall back to the scraper-only path on any error.
- Extended `OnboardingDraftPreview.brandKitPreview` and `UrlPreviewBrandKitPreview` with `positioning`, `audience`, `toneOfVoice`, `styleVibe` (all nullable). The draft-store sanitizer round-trips them.
- New regression: `tests/brand-kit-enrich.test.ts` covers all six failure modes plus the happy path.
- Compose now reads `ARIES_BRAND_ENRICHMENT_ENABLED`, `HERMES_BRAND_ANALYSIS_SESSION_KEY`, and `HERMES_BRAND_ANALYSIS_TIMEOUT_MS` through env with sensible defaults.

## [0.1.2.0] - 2026-04-23

### Added
- Shared inline form validation across auth and onboarding. Fields now show real-time "Enter a valid email address"-style feedback and the submit button stays disabled until every input actually satisfies its contract.
- Review workspace recovery screen. When a review deep link resolves to a review your current workspace does not own, you now see a clear explanation plus "Open review queue" and "Open campaigns" next steps instead of a blank page.

### Fixed
- Review detail deep links survive the login redirect, so opening a shared `/review/[reviewId]` URL while signed out lands you back on that exact review after auth, not the dashboard.
- Onboarding handoff and navigation: the resume page honors pending state, browser history no longer strands you on a broken step, and step-one validation blocks empty submits before they fire.
- Dashboard campaign-start failures now surface a visible error banner instead of silently swallowing the failure.
- Contact page replaces the "Contact intake is not available yet" dead end with a `support@sugarandleather.com` mailto action, so users can actually reach support.
- Homepage request-access form validates inputs inline and keeps the submit disabled until the form is valid, with a dedicated loading state while the request is in flight.
- Forgot-password and login screens share the same inline validation contract as signup, removing divergent error copy across auth forms.
- Signup email addresses are normalized (trim + lowercase) before submission so duplicate-account checks match the real stored identity.
- Docker production port publish moved into `docker-compose.yml` base so deploys and production-style runs expose `${PORT:-3000}` without depending on the local override being layered in.
- CI deploy workflow checks out over HTTPS with the workflow token, unblocking the self-hosted deploy host when SSH origin access is not available.

### For contributors
- Added `lib/form-validation.ts` as the shared primitive behind inline validation (`EMAIL_ADDRESS_REGEX`, `isValidEmailAddress`, `getRequiredFieldError`, `getEmailFieldError`, `useDisabledUntilValid`).
- Added `frontend/aries-v1/review-recovery.ts` as the workspace-recovery state builder consumed by the review detail screen.
- Added GitHub issue templates (`.github/ISSUE_TEMPLATE/bug_report.md`, `.github/ISSUE_TEMPLATE/feature_request.md`) so incoming bug and feature reports arrive with consistent structure.
- New regression specs pinned to this wave: `tests/login-form-validation.regression-010.test.ts`, `tests/forgot-password-form-validation.regression-011.test.ts`, `tests/onboarding-step-one-validation.regression-012.test.ts`, `tests/homepage-request-access-validation.regression-013.test.ts`, `tests/route-metadata-and-docs-anchors.regression-015.test.ts`, `tests/deploy-workflow-self-hosted.regression-015.test.ts`, `tests/homepage-request-access-loading.regression-016.test.ts`, `tests/production-compose-port-publish.regression-016.test.ts`, `tests/signup-email-normalization.regression-017.test.ts`.

## [0.1.1.0] - 2026-04-23

### Fixed
- Blocked signup submission until full name, email, and password all satisfy real validation requirements.
- Removed false click affordance from the homepage Meet Aries workflow chips and exposed them as non-interactive list semantics.
- Added Escape dismissal to the desktop account menu while preserving click-outside close behavior.
- Repaired stale encoded marketing text on campaign workspace and business-profile read paths before UI and API consumers render it.
