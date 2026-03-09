# frontend-ui-quality-builder log

## Scope handled
Updated shared UI helper components only under `frontend/components`:
- `status-badge.tsx`
- `error-panel.tsx`
- `next-step-card.tsx`

No backend changes or contract redesign.

## Changes made

### 1) StatusBadge
- Preserved `StatusBadgeProps` contract (`status` unchanged).
- Added explicit display labels (`labelByStatus`) so UI shows human-readable text.
- Kept existing tone map and added `data-state-group` classification for:
  - `retry` (`retry_scheduled`, `retry_complete`)
  - `empty` (`not_found`, `not_required`, `unknown`)
  - `active`, `done`, `error`, `neutral`
- Added accessibility metadata:
  - `role="status"`
  - `aria-label="Status: ..."`

### 2) ErrorPanel
- Preserved `ErrorPanelProps` contract (`error: BackendError` unchanged).
- Added kind-specific heading labels.
- Added retry guidance logic:
  - Repair errors show retry available vs exhausted.
  - Hard failures show investigation guidance before rerun.
- Improved validation handling with an explicit empty-state helper message and conditional field list.
- Added accessibility metadata:
  - `role="alert"`
  - `aria-live="assertive"`

### 3) NextStepCard
- Preserved `NextStepCardProps` contract (`nextStep` unchanged).
- Added human-readable step labels (`labelByStep`) while keeping existing explanatory copy.
- Added semantic state flags:
  - `data-empty` when `nextStep === 'none'`
  - `data-urgency` (`none`/`low`/`medium`/`high`)

## Verification
- Ran TypeScript check against frontend config:
  - `npx -y tsc -p frontend/tsconfig.json --noEmit`
  - Result: pass
