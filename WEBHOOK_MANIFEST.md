# Aries AI — Webhook Manifest

Discovered from the live n8n instance at `n8n.sugarandleather.com` and local `n8n/*.workflow.json` files.

## Active Webhook Endpoints

| Webhook Path | n8n Workflow Name | n8n ID | HTTP Method | Used By (API Route) |
|---|---|---|---|---|
| `/webhook/tenant-provisioning` | tenant-provisioning | `9RtLUPv8wQLtgQUE` | POST | `/api/onboarding/start`, `/api/demo`, `/api/sandbox/launch` |
| `/webhook/tenant-repair` | tenant-repair | `vATLKcdEKm9ete08` | POST | Internal repair chain |
| `/webhook/brand-campaign` | brand-campaign | — | POST | `/api/marketing/jobs` |
| `/webhook/marketing-research` | marketing-research | `I9lRSG4BkD98yGY7` | POST | Legacy/manual stage entry, not the current product create route |
| `/webhook/marketing-strategy` | marketing-strategy | `fHpqn4kKkfwO4MTv` | POST | Pipeline stage 2 |
| `/webhook/marketing-production` | marketing-production | `DLawm6bvd2Ixpv7j` | POST | Pipeline stage 3 |
| `/webhook/marketing-publish` | marketing-publish | `DF33XGltzCSl7uCm` | POST | Pipeline stage 4 |
| `/webhook/marketing-approval-resume` | marketing-approval-resume | `x9z1ZRYK8Rv0FfYn` | POST | `/api/marketing/jobs/:jobId/approve` |
| `/webhook/marketing-repair` | marketing-repair | `opZ7SNbIvOqxdExJ` | POST | Repair chain |
| `/webhook/aries/publish` | publish-dispatch | — | POST | `/api/publish/dispatch` |
| `/webhook/aries/connection-events` | connection-events | — | POST | OAuth lifecycle |
| `/webhook/get-groq-key` | API Key Provider - Groq | `KUOO8ZvdAk9sYpk7` | POST | API Key Management |
| `/webhook/get-openai-key` | API Key Provider - OpenAI | `R1ZzHMhK4CG312da` | POST | API Key Management |
| `/webhook/get-gemini-key` | API Key Provider - Gemini | `V9a5Y1ESQoHb12TP` | POST | API Key Management |
| `/webhook/openclaw-codex-router` | OpenClaw Codex Router | `T9LffDBRC9v4N5Rx` | POST | Code Router |
| `/webhook/research-intake` | WF-01 Research Intake Router | `KMeUrkij1po3ItzE` | POST | Research Pipeline |
| `/webhook/clickup-sync` | WF-06 ClickUp Sync (Event-Driven One-Way) | `IdVHMV414VqtoYrC` | POST | Task Management |
| `/webhook/ripr-gemini` | RIPR - Gemini Validator | `yyokiIvSX6fTux3z` | POST | Validation Pipeline |
| `/webhook/ripr-gpt` | RIPR - ChatGPT Validator | `hnFzDclWhC7QTqkr` | POST | Validation Pipeline |

## Other Active Workflows (No Direct Webhook)

| Workflow Name | n8n ID | Trigger Type | Purpose |
|---|---|---|---|
| WF-02 Competitor Intel Weekly | `24A9l8uQDuHwn40x` | Schedule | Weekly competitor analysis |
| calendar-schedule-sync | — | Schedule | Periodic syncing |
| publish-retry | — | Schedule | Recovering failed jobs |
| video-job-intake | — | Manual | Video processing |
| video-generate | — | Manual | Video processing |
| video-approve | — | Manual | Video processing |
| video-poll | — | Manual | Video processing |
| video-repair | — | Manual | Video processing |
| API Key Provider - Anthropic | — | Manual | API Key Management |
| API Key Provider - Stability | — | Manual | API Key Management |
| API Key Provider - Luma | — | Manual | API Key Management |

## Missing Workflows

These API routes have no corresponding n8n workflow and now return explicit `501` placeholder responses after logging the payload:

| API Route | Expected Workflow | Status |
|---|---|---|
| `/api/contact` | `contact-form` | ❌ Not deployed |
| `/api/waitlist` | `waitlist-signup` | ❌ Not deployed |
| `/api/events` | `event-tracking` | ❌ Not deployed |

When these workflows are created in n8n, update the corresponding route handler in `app/api/*/route.ts` to call `postToN8n(webhookPath, payload)` via `lib/api-service.ts`.
