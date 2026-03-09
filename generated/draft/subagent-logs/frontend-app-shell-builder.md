# frontend-app-shell-builder log

## Scope handled
- Created shared app shell route registry and navigation layout under `frontend/app-shell`.
- Preserved bounded scope: no backend edits, no contract redesign, no workflow behavior changes.

## Files added
- `frontend/app-shell/routes.ts`
- `frontend/app-shell/layout.tsx`

## Implementation summary
- `routes.ts`
  - Defines typed route ids for:
    - onboarding: start, status
    - marketing: new-job, job-status, job-approve
  - Exposes:
    - `APP_ROUTES`
    - `getRouteById(routeId)`
    - `getSectionRoutes(section)`

- `layout.tsx`
  - Defines `AppShellLayout` reusable wrapper with:
    - header/title/subtitle
    - grouped onboarding/marketing nav links
    - active state via `currentRouteId`
    - content slot (`children`)
  - Keeps implementation minimal and self-contained using existing frozen route paths.

## Notes for integrator
- Existing screens/pages can opt into shared shell by wrapping screen content in `AppShellLayout` and passing `currentRouteId`.
- No required additional files were needed.
