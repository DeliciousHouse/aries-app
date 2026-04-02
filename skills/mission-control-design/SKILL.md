---
name: mission-control-design
description: Design and refine Aries Mission Control interfaces, components, and dashboards with the approved module-specific visual system. Use when building or restyling Mission Control pages, shells, cards, navigation, session views, design tokens, or internal dashboard UI for Ops, Brain, or Lab. Applies especially to React/TypeScript dashboard work, design-system extraction, layout polish, hover/focus cleanup, expandable session-card patterns, and multi-model control surfaces for Mission Control.
---

# Mission Control Design

Use this skill to keep Mission Control visually coherent while the product evolves. Treat Mission Control as an internal operating surface for Aries product execution, agent operations, and decision visibility — not a generic admin panel and not an external client CRM.

## Core design direction

Design for a dark, operational, high-signal control room.

Anchor the product around three module identities:

- **Ops** → amber hue with a restrained neon effect
- **Brain** → sky-blue hue with a calm analytical tone
- **Lab** → matrix green with experimental energy

Use neon sparingly. Reserve the strongest glow for:

- module icons
- major section titles
- active nav states
- selected-card accents
- critical system indicators

Keep panels, surfaces, and backgrounds quieter than the accents so the interface still reads as production-grade rather than gimmicky.

## Required visual system

### Color identity

Use these module hues as the primary accent families:

- **Ops / amber**
  - primary: `#F6B94C`
  - bright: `#FFD27A`
  - deep: `#9A640E`
  - glow: `rgba(246, 185, 76, 0.35)`

- **Brain / sky blue**
  - primary: `#66B8FF`
  - bright: `#A7D8FF`
  - deep: `#1C5E91`
  - glow: `rgba(102, 184, 255, 0.32)`

- **Lab / matrix green**
  - primary: `#59F28C`
  - bright: `#9DFFC0`
  - deep: `#167A3D`
  - glow: `rgba(89, 242, 140, 0.3)`

Use a dark base surface behind all three:

- background: `#08111B`
- elevated panel: `#0D1824`
- panel border: `rgba(255,255,255,0.08)`
- primary text: `#EAF3FF`
- muted text: `#92A8C1`

### Typography

Use the Ubuntu family consistently:

- **Titles / headers / nav labels / key stat labels** → `Ubuntu`
- **Body copy / metadata / descriptions / dense operational text** → `Ubuntu Mono`

Recommended stack:

```css
--font-title: 'Ubuntu', 'Segoe UI', sans-serif;
--font-body: 'Ubuntu Mono', 'SFMono-Regular', 'Menlo', monospace;
```

Use Ubuntu Mono for operational density, but do not make paragraph measures too wide. Keep dense information grouped into cards, rows, or logs.

### Neon treatment

Apply a Matrix-style neon effect with discipline:

```css
text-shadow:
  0 0 10px var(--module-glow),
  0 0 22px color-mix(in srgb, var(--module-accent) 45%, transparent);

box-shadow:
  0 0 0 1px color-mix(in srgb, var(--module-accent) 22%, transparent),
  0 0 24px color-mix(in srgb, var(--module-accent) 18%, transparent);
```

Do not apply glow to whole paragraphs or large containers. Prefer tight accents on:

- icon chips
- headings
- selected tabs
- active pills
- focused controls

## Layout and shell rules

### App shell

Make the shell feel like Mission Control:

- stable left dock or rail for primary navigation
- strong section framing
- clear hierarchy between overview, list, and detail regions
- cards that feel operational rather than decorative

Avoid rounded, bubbly SaaS styling. Use cleaner geometry, tighter rhythm, and more deliberate spacing.

### Menu dock hover behavior

Ensure hover/focus outlines stay **inside** the dock container.

Use inset outlines, inner shadows, or contained border-color transitions instead of effects that bleed outside the dock.

Preferred pattern:

```css
.menuDockItem {
  position: relative;
  border: 1px solid transparent;
  box-shadow: inset 0 0 0 1px transparent;
}

.menuDockItem:hover,
.menuDockItem:focus-visible {
  border-color: color-mix(in srgb, var(--module-accent) 40%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--module-accent) 30%, transparent);
}
```

Avoid:

- outer outline offsets that clip outside the dock
- oversized blur halos on hover
- transforms that cause nav items to overflow their rail

## Module-specific guidance

### Ops

Ops should read like execution pressure with control.

Use:

- amber highlights for headings, counts, urgency indicators
- strong state chips for blocked, in progress, review, done
- board/list layouts with rapid scan value
- denser information presentation than Brain or Lab

Ops pages should feel decisive, accountable, and current.

### Brain

Brain should feel clear, reflective, and analytical.

Use:

- sky-blue accents for article titles, summary markers, metadata rails
- more whitespace than Ops
- highly readable markdown or narrative layouts
- calm hierarchy for decision logs, reasoning summaries, and briefs

Brain pages should feel like situational understanding, not execution pressure.

### Lab

Lab should feel experimental but still disciplined.

Use:

- matrix-green accents for prototypes, tests, and speculative concepts
- modular cards that show status, owner, next action, and freshness
- subtle terminal-like cues when helpful, without turning the page into cosplay

Lab pages should feel alive and iterative.

## Session-card system

Mission Control must support expandable session cards.

### Required behavior

- default cards work in a compact overview grid/list
- expanded cards can open to roughly **three-quarters screen width**
- expanded state should prioritize legibility for model details, status, logs, controls, and outputs
- expansion should feel anchored to the original card, not like a completely separate page unless the product explicitly needs a route change

### Recommended structure

Each session card should have:

- session title
- model badge
- owner or initiator
- current state/status
- last activity timestamp
- short summary
- quick actions
- expandable detail region

Expanded view should have space for:

- run summary
- tool/model history
- notes or transcript preview
- operational controls
- linked tasks or outcomes

### Width rule

Target expanded width around `72vw` to `76vw`, capped by viewport and container constraints.

Example:

```css
.sessionCard[data-expanded='true'] {
  width: min(76vw, 1400px);
  max-width: 100%;
}
```

## Multi-model support requirements

Mission Control should visibly support multiple model tracks.

Explicitly support these model labels in the UI:

- `Codex 5.3`
- `Gemini 3 Pro`

Design the model system so more models can be added later without layout changes.

### Model presentation rules

Represent models as structured badges or selectors, not raw strings dumped into copy.

Include room for:

- model name
- status/availability
- active/default indicator
- optional cost or latency metadata later

Prefer a reusable model chip pattern:

```text
[ Codex 5.3 ]   [ Gemini 3 Pro ]
```

When a session or run is model-specific, show the chip near the title or status band.

## Interaction rules

- Keep hover states tight and intentional.
- Keep focus-visible states keyboard-usable and inside containers.
- Keep filters, tabs, and chips operational, not playful.
- Animate with short, low-drama transitions.
- Prefer opacity, border-color, and contained glow shifts over large movement.

## Build standards

When implementing Mission Control UI:

1. Start by identifying which module owns the screen: Ops, Brain, Lab, or shared shell.
2. Apply that module's accent system first.
3. Use Ubuntu for titles and Ubuntu Mono for operational text.
4. Keep hover/focus effects contained within their components.
5. Use expandable card patterns for session-heavy surfaces.
6. Preserve clear seams for future live integrations and model additions.

## Output expectations

When using this skill for implementation work, prefer to produce:

- design tokens or CSS variables for shared theming
- reusable card, dock, badge, and section-header components
- explicit module accent variants
- clear notes showing where model/session integrations plug in later

If asked to restyle existing Mission Control UI, preserve behavior while bringing it into this visual system rather than redesigning the product from scratch.
