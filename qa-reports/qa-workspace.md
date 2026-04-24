## ISSUE-001: Strategy deep link intermittently collapses into a generic 502 error
- Severity: High
- Category: Functional
- Page/URL: `https://aries.sugarandleather.com/dashboard/campaigns/mkt_63d45c2b-6f8e-4036-9ebf-703892f3dd63?view=strategy`
- What I saw: The strategy workspace does not render strategy content reliably. After loading the strategy URL and waiting for data, the page body degrades to a single `Request failed with status 502` message.
- Repro:
  1. Sign in with the shared QA account.
  2. Open the strategy deep link above.
  3. Wait 8-12 seconds for the workspace fetch to settle.
  4. Reload the page or re-open the same deep link.
- Expected vs Actual: Expected the Strategy tab to render the stage payload or its defined empty state. Actual behavior is a generic 502 failure state with no usable strategy review UI.
- Evidence: Log excerpt: `GET ...?view=strategy → 200`, followed by page text `Request failed with status 502`.

## ISSUE-002: Creative deep link intermittently fails before any creative content renders
- Severity: Critical
- Category: Functional
- Page/URL: `https://aries.sugarandleather.com/dashboard/campaigns/mkt_63d45c2b-6f8e-4036-9ebf-703892f3dd63?view=creative`
- What I saw: The required creative workspace repeatedly fails to load. In separate passes it rendered as a blank body, then as `Loading campaign...`, and then as `Request failed with status 502`.
- Repro:
  1. Sign in with the shared QA account.
  2. Open the creative deep link above.
  3. Wait 8-12 seconds.
  4. Reload once and wait again.
- Expected vs Actual: Expected the Creative tab to load the review surface and rendered videos section. Actual behavior is an unstable failure loop that ends in a generic 502 error.
- Evidence: Console excerpt: `Failed to load resource: the server responded with a status of 502 ()`; network excerpt: `GET ...?view=creative → 502`.

## ISSUE-003: Creative tab never mounts the required rendered video cards despite 16 video artifacts being present
- Severity: Critical
- Category: Functional
- Page/URL: `https://aries.sugarandleather.com/dashboard/campaigns/mkt_63d45c2b-6f8e-4036-9ebf-703892f3dd63?view=creative`
- What I saw: The authenticated job JSON contains 16 video artifacts, but the creative screen never produces a single `<video>` element because the page fails before the section mounts.
- Repro:
  1. Sign in and open the creative deep link.
  2. Wait for the page to settle.
  3. Inspect the DOM or query the job JSON from the authenticated browser session.
- Expected vs Actual: Expected 16 rendered video cards with posters and playable video controls. Actual behavior is `0` rendered `<video>` elements on the page even though the authenticated job payload returns 16 video artifacts.
- Evidence: Browser JS excerpt: job payload returned 16 `type === 'video'` artifacts; browser JS excerpt on the creative page returned `Array.from(document.querySelectorAll('video')).length === 0`.

## ISSUE-004: Session drops back to the login screen during workspace deep-link navigation
- Severity: High
- Category: Functional
- Page/URL: `https://aries.sugarandleather.com/dashboard/campaigns/mkt_63d45c2b-6f8e-4036-9ebf-703892f3dd63?view=publish`
- What I saw: After a successful login, a later deep-link navigation to the publish workspace landed back on `/login` instead of the requested campaign route.
- Repro:
  1. Sign in with the shared QA account.
  2. Open the publish deep link.
  3. Wait roughly 10 seconds.
  4. Repeat from a fresh dashboard load.
- Expected vs Actual: Expected the authenticated user to stay inside the workspace. Actual behavior is an unexpected redirect back to the login screen.
- Evidence: Page text excerpt after navigation: `Back to Home ... Welcome Back ... Sign in to your Aries AI account`; browser JS excerpt: `window.location.href === "https://aries.sugarandleather.com/login"`.

## ISSUE-005: Background refresh can replace loaded workspace content with loading and failure shells
- Severity: High
- Category: Functional
- Page/URL: `/dashboard/campaigns/mkt_63d45c2b-6f8e-4036-9ebf-703892f3dd63?view=publish`
- What I saw: A fully rendered workspace can regress into `Loading campaign...` and later `Request failed with status 502` without any user action other than waiting through the page’s background refresh loop.
- Repro:
  1. Open a working workspace tab such as Brand or Publish.
  2. Wait 10-20 seconds after the content renders.
  3. Observe the page during its background refresh.
- Expected vs Actual: Expected background refresh to be silent and preserve the currently visible content. Actual behavior causes the UI to flicker back to a loading shell and sometimes a hard error state.
- Evidence: Sequential page text excerpts from the same session: full publish content → `Loading campaign...` → `Request failed with status 502`.

## ISSUE-006: Nav pill transitions do not preserve scroll position
- Severity: Medium
- Category: UX
- Page/URL: `/dashboard/campaigns/mkt_63d45c2b-6f8e-4036-9ebf-703892f3dd63?view=brand`
- What I saw: After scrolling down the Brand tab and switching tabs through the view pills, the next view resets to the top of the page.
- Repro:
  1. Open the Brand tab.
  2. Scroll down until the history block is visible.
  3. Click `Launch Status`.
  4. Check the new view’s scroll position.
- Expected vs Actual: Expected the campaign workspace to preserve scroll state across view switches. Actual behavior resets the next view to `scrollY: 0`.
- Evidence: Browser JS excerpt before navigation: `scrollY: 397`; after the tab transition: `scrollY: 0`.

## ISSUE-007: Brand and publish deep-link loads are slow enough to trip the browser driver timeout
- Severity: Medium
- Category: Performance
- Page/URL: `/dashboard/campaigns/mkt_63d45c2b-6f8e-4036-9ebf-703892f3dd63?view=brand`
- What I saw: The workspace load is slow and inconsistent enough that direct `goto` calls timed out at 15 seconds even when the route eventually returned a response.
- Repro:
  1. Sign in.
  2. Open a campaign workspace deep link directly.
  3. Repeat with another view.
- Expected vs Actual: Expected deep-link loads to settle comfortably within the standard navigation timeout. Actual behavior intermittently hits the 15 second timeout window.
- Evidence: Log excerpt: `Operation timed out: goto: Timeout 15000ms exceeded.`

## ISSUE-008: Core dashboard APIs take 12-17 seconds to settle during navigation
- Severity: Medium
- Category: Performance
- Page/URL: `/dashboard` and workspace routes
- What I saw: Several key API calls were materially slow during this run, which aligns with the observed loading flashes and delayed route stability.
- Repro:
  1. Sign in and allow the dashboard to load fully.
  2. Inspect network timing while the dashboard and workspace boot.
- Expected vs Actual: Expected the supporting dashboard APIs to return promptly enough to keep navigation stable. Actual timings were regularly in the double digits.
- Evidence: Network excerpts: `GET /api/marketing/campaigns → 200 (12372ms)`, `GET /api/marketing/reviews → 200 (16950ms)`, `GET /api/business/profile → 200 (17351ms)`, `GET /api/integrations → 200 (17511ms)`.

## ISSUE-009: Brand header shows raw ISO timestamps instead of user-facing campaign dates
- Severity: Low
- Category: Content
- Page/URL: `/dashboard/campaigns/mkt_63d45c2b-6f8e-4036-9ebf-703892f3dd63?view=brand`
- What I saw: The campaign date pill displays unformatted ISO strings directly in the UI.
- Repro:
  1. Open the Brand tab.
  2. Read the date pill in the campaign header.
- Expected vs Actual: Expected a human-readable range such as `Apr 24, 2026 - May 24, 2026`. Actual behavior shows raw ISO timestamps.
- Evidence: Page text excerpt: `2026-04-24T00:00:00.000Z - 2026-05-24T00:00:00.000Z`.

## ISSUE-010: Brand voice copy is malformed and loses sentence boundaries
- Severity: Medium
- Category: Content
- Page/URL: `/dashboard/campaigns/mkt_63d45c2b-6f8e-4036-9ebf-703892f3dd63?view=brand`
- What I saw: The Brand voice field contains broken copy with missing words and punctuation, making the approved brief look unedited.
- Repro:
  1. Open the Brand tab.
  2. Read the `Brand voice` field in the Brand brief section.
- Expected vs Actual: Expected a coherent brand voice statement. Actual copy is malformed and reads like a broken scrape.
- Evidence: Page text excerpt: `Collaborate effortlessly and gain clarity across your, resources, and goals — all in one Bring your strategy life Calls action include Contact sales, Watch how, AI overview Discover AI at monday.com.`

## ISSUE-011: Approved brand review still exposes multiple “pending” placeholders
- Severity: Medium
- Category: Content
- Page/URL: `/dashboard/campaigns/mkt_63d45c2b-6f8e-4036-9ebf-703892f3dd63?view=brand`
- What I saw: The approved Brand direction review still shows unresolved placeholders across key fields, which makes the supposedly approved output feel incomplete.
- Repro:
  1. Open the Brand tab.
  2. Scroll to the approved Brand direction section.
  3. Read the positioning, audience, voice, and style rows.
- Expected vs Actual: Expected approved brand content to avoid placeholder language. Actual behavior shows several fields as unfinished.
- Evidence: Page text excerpts: `Positioning pending.`, `Audience summary pending.`, `Voice summary pending.`, `Style summary pending.`

## ISSUE-012: Missing brief fields are dumped as repeated “Not provided” blocks instead of a cleaner empty state
- Severity: Low
- Category: UX
- Page/URL: `/dashboard/campaigns/mkt_63d45c2b-6f8e-4036-9ebf-703892f3dd63?view=brand`
- What I saw: Multiple adjacent brand-brief fields render as `Not provided`, which makes the page feel unfinished rather than intentionally empty.
- Repro:
  1. Open the Brand tab.
  2. Review the `Style / vibe`, `Visual references`, `Must-use copy`, and `Must-avoid aesthetics` rows.
- Expected vs Actual: Expected a single grouped empty state or a clearer explanation that these inputs are missing. Actual behavior repeats `Not provided` four times in the main content.
- Evidence: Page text excerpts: `Style / vibe Not provided`, `Visual references Not provided`, `Must-use copy Not provided`, `Must-avoid aesthetics Not provided`.

## ISSUE-013: Publish queue platform naming is inconsistent and under-humanized
- Severity: Medium
- Category: Content
- Page/URL: `/dashboard/campaigns/mkt_63d45c2b-6f8e-4036-9ebf-703892f3dd63?view=publish`
- What I saw: The publish queue mixes platform names with inconsistent casing and formatting, which makes the list harder to scan.
- Repro:
  1. Open the Publish tab.
  2. Read the platform labels on the launch-ready items.
- Expected vs Actual: Expected polished platform names such as `YouTube` and `LinkedIn`. Actual behavior uses inconsistent forms such as `Youtube` and `Linkedin`.
- Evidence: Page text excerpt: `... Reddit ... Youtube ... TikTok ... Instagram ... Linkedin ...`

## ISSUE-014: One publish queue item is labeled only as “Video”
- Severity: Medium
- Category: UX
- Page/URL: `/dashboard/campaigns/mkt_63d45c2b-6f8e-4036-9ebf-703892f3dd63?view=publish`
- What I saw: One launch item is surfaced with the platform label `Video`, which is too generic to identify the destination or family at a glance.
- Repro:
  1. Open the Publish tab.
  2. Scan the labels in the launch-ready item list.
- Expected vs Actual: Expected every launch item to show a recognizable platform label. Actual behavior includes a bare `Video` label with no platform context.
- Evidence: Page text excerpt: `... Instagram ... Video ... Linkedin ... X Video ...`

## ISSUE-015: Campaign header counts are global and misleading on non-creative tabs
- Severity: Low
- Category: UX
- Page/URL: `/dashboard/campaigns/mkt_63d45c2b-6f8e-4036-9ebf-703892f3dd63?view=brand`
- What I saw: The brand and publish tabs both show campaign-wide counts like `Generated assets 52` and `Creative approvals 0/19`, even when the active view exposes only brand or publish content.
- Repro:
  1. Open Brand or Publish.
  2. Read the metric cards under the campaign summary.
  3. Compare them to the active view’s visible content.
- Expected vs Actual: Expected the header counts to either scope to the active view or clarify that they are campaign-wide totals. Actual behavior makes the numbers look like view-specific counts.
- Evidence: Page text excerpt on Brand: `Generated assets 52`, `Creative approvals 0/19`, while the visible content is only brand brief and brand review material.

## ISSUE-016: Asset traversal attempts are treated as ordinary 404s instead of invalid requests
- Severity: Medium
- Category: API
- Page/URL: `/api/marketing/jobs/mkt_63d45c2b-6f8e-4036-9ebf-703892f3dd63/assets/video-../../secrets`
- What I saw: A traversal-style video asset request returns the normal not-found payload instead of the expected invalid-request response.
- Repro:
  1. Authenticate in the browser.
  2. Request `/api/marketing/jobs/mkt_63d45c2b-6f8e-4036-9ebf-703892f3dd63/assets/video-../../secrets`.
- Expected vs Actual: Expected a `400` invalid request response for a traversal attempt. Actual behavior returns `404` with the regular `marketing_asset_not_found` body.
- Evidence: Browser JS fetch result: `{ "status": 404, "body": "{\"error\":\"Marketing asset not found.\",\"reason\":\"marketing_asset_not_found\"}" }`.

## ISSUE-017: Fake-job asset requests leak a specific missing-job reason
- Severity: Medium
- Category: API
- Page/URL: `/api/marketing/jobs/fake-job-id/assets/video-youtube-shorts-video-outcome-proof`
- What I saw: The API returns a specialized `marketing_job_not_found` body for a fake job id, which reveals internal existence semantics rather than staying opaque.
- Repro:
  1. Authenticate in the browser.
  2. Request `/api/marketing/jobs/fake-job-id/assets/video-youtube-shorts-video-outcome-proof`.
- Expected vs Actual: Expected an opaque `403` or `404` that does not reveal whether the job exists. Actual behavior returns an explicit missing-job reason.
- Evidence: Browser JS fetch result: `{ "status": 404, "body": "{\"error\":\"Marketing job not found.\",\"reason\":\"marketing_job_not_found\"}" }`.

## ISSUE-018: Strategy and creative failures fall back to a generic request error instead of a stage-specific empty/error state
- Severity: Medium
- Category: UX
- Page/URL: strategy and creative workspace views
- What I saw: When the fetch fails, the user gets only `Request failed with status 502`, which gives no recovery path and no stage-specific context.
- Repro:
  1. Open the Strategy or Creative deep link.
  2. Wait for the page to fail.
- Expected vs Actual: Expected an Aries-specific fallback that explains which stage failed and how to recover. Actual behavior is a generic request string with no next step.
- Evidence: Page text excerpt on both views: `Request failed with status 502`.

## Summary
- Critical: 2
- High: 4
- Medium: 9
- Low: 3
- Overall health: 38/100

Primary blockers are the strategy and creative workspace failures, the unstable authenticated navigation, and the mismatch between the required rendered-video experience and what the live workspace can actually load.
