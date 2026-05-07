# T21: Reschedule per-post drawer — evidence

## Scope

- Backend helper `backend/social-content/scheduled-posts.ts` performs the
  tenant-scoped upsert into `scheduled_posts` (T7 schema).
- API route
  `PATCH /api/social-content/jobs/[jobId]/posts/[postId]/schedule`
  validates body, resolves tenant, confirms post ownership, and writes
  the row.
- Standalone UI drawer `frontend/aries-v1/reschedule-drawer.tsx` provides
  date+time picker (HTML `datetime-local`), Facebook/Instagram toggles,
  and the PATCH submit. Falls back to `America/New_York` per plan.
- Targeted regression `tests/review-reschedule.test.ts` covers the DB
  write shape and validation contract.

`review-item.tsx` was concurrently being modified by T19 (inline copy
edit). Per the plan note "coordinate carefully if T19 also changed it,
but keep this task scoped", the drawer ships as a self-contained
component that T19/F-wave can wire in without contention. The drawer is
already exported (default export) and accepts `jobId`, `postId`,
`defaultScheduledAt`, `defaultPlatforms`, and `onSaved`/`onClose`
callbacks.

## DB write shape — verified by `tests/review-reschedule.test.ts`

The fixture mocks the `pg` queryable and asserts the actual SQL params
passed to `INSERT INTO scheduled_posts ...`:

```
SELECT id, tenant_id FROM posts WHERE id = $1 AND tenant_id = $2 LIMIT 1
INSERT INTO scheduled_posts (post_id, tenant_id, scheduled_for, target_platforms, updated_at)
VALUES ($1, $2, $3, $4, now())
ON CONFLICT (post_id) DO UPDATE
  SET scheduled_for = EXCLUDED.scheduled_for,
      target_platforms = EXCLUDED.target_platforms,
      updated_at = now()
  WHERE scheduled_posts.tenant_id = EXCLUDED.tenant_id
RETURNING id, post_id, tenant_id, scheduled_for, target_platforms, updated_at
```

Asserted DB write for the FB-off scenario:

| param | value |
| --- | --- |
| `post_id` | `42` |
| `tenant_id` | `7` |
| `scheduled_for` | `'2026-05-13T13:00:00.000Z'` (ISO 8601) |
| `target_platforms` | `['instagram']` |

The `ON CONFLICT ... WHERE scheduled_posts.tenant_id = EXCLUDED.tenant_id`
clause prevents cross-tenant overwrite even if a `post_id` collision
were possible across orgs (the typed
`ScheduledPostTenantMismatchError` collapses that into a 404 at the
route layer).

## Test run

```
$ APP_BASE_URL=https://aries.example.com ./node_modules/.bin/tsx --test tests/review-reschedule.test.ts
ok 1  - PATCH schedule persists scheduled_at ISO and platforms with FB toggled off (instagram only)
ok 2  - PATCH schedule preserves both platforms when FB and IG selected
ok 3  - PATCH schedule rejects empty platforms array with 400
ok 4  - PATCH schedule rejects unknown platform values with 400
ok 5  - PATCH schedule rejects invalid scheduled_at with 400
ok 6  - PATCH schedule rejects malformed JSON body with 400
ok 7  - PATCH schedule returns 404 when post does not belong to tenant
ok 8  - PATCH schedule returns 404 when postId is not numeric
ok 9  - PATCH schedule rejects unauthenticated requests with 403
ok 10 - PATCH schedule deduplicates and lowercases platform names

# tests 10
# pass 10
# fail 0
```

## LSP

`lsp_diagnostics` clean on every changed file. The only output is two
`6385` hints on `lucide-react`'s `Facebook`/`Instagram` icons being
deprecated, identical to existing usage in
`frontend/onboarding/pipeline-intake/steps/ConnectPlatformsStep.tsx:4` —
not introduced by this task.

## Files

- `backend/social-content/scheduled-posts.ts` (new)
- `app/api/social-content/jobs/[jobId]/posts/[postId]/schedule/route.ts` (new)
- `frontend/aries-v1/reschedule-drawer.tsx` (new)
- `tests/review-reschedule.test.ts` (new)
