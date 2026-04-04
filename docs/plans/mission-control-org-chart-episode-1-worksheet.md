# Mission Control Org Chart — Episode 1 Worksheet

## Purpose

Use this worksheet to decide the minimum operating structure for Aries AI and `aries-app` inside OpenClaw Mission Control.

This is **not** an agency org chart.
This is **not** a client-service staffing exercise.
This is an internal operating map for:

- shipping `aries-app`
- running OpenClaw Mission Control truthfully
- balancing orchestration with direct execution
- deciding which recurring work deserves dedicated agents later

---

## Current known structure

### Decision-maker
- **Brendan** — Head of Software Engineering
- Final decision-maker for priority, scope, approvals, and high-risk calls

### Core operating layer
- **Jarvis** — Mission Control + execution layer
- Must support both:
  - orchestration / delegation
  - direct implementation work

### Known execution owners
- **Rohan** — Frontend owner
- **Roy** — Backend owner
- **Somwya** — Human-required / manual / non-coding execution

### Episode 1 starter departments
- Engineering Delivery
- Runtime & Automation
- Operations & Knowledge

---

## Section 1 — What needs daily attention?

List the functions that need somebody watching or pushing almost every day.

### Engineering Delivery
- [ ] Frontend implementation
- [ ] Backend implementation
- [ ] Integration verification
- [ ] Release readiness
- [ ] Bug triage
- [ ] Scope / dependency coordination
- [ ] Other:

Notes:

### Runtime & Automation
- [ ] Session visibility
- [ ] Task / agent run visibility
- [ ] Cron / scheduler visibility
- [ ] Lobster / flow monitoring
- [ ] Model usage visibility
- [ ] Health / failure follow-through
- [ ] Other:

Notes:

### Operations & Knowledge
- [ ] Manual verification
- [ ] Account / dashboard checks
- [ ] Briefing compression
- [ ] Handoff hygiene
- [ ] Approval follow-through
- [ ] QA checklists
- [ ] Other:

Notes:

---

## Section 2 — What should Jarvis execute directly?

Use this section to force a boundary between work Jarvis should own directly and work that should be routed out.

### Jarvis should execute directly when:
- [ ] the work is bounded and implementation-heavy
- [ ] routing would slow down shipping
- [ ] the work is cross-owner cleanup or integration glue
- [ ] the work is planning / decomposition / blocker synthesis
- [ ] the work is runtime truth verification
- [ ] other:

Examples / notes:

### Jarvis should delegate when:
- [ ] the work clearly belongs to frontend
- [ ] the work clearly belongs to backend
- [ ] the work requires human-only access or manual verification
- [ ] the work is large enough to benefit from a dedicated owner lane
- [ ] other:

Examples / notes:

### Decisions to make
- Where is Jarvis overloaded today?
- Which work keeps bouncing back because ownership is unclear?
- Which tasks are small enough that Jarvis should just do them?
- Which tasks are large enough that Jarvis should only frame and route them?

Answers:

---

## Section 3 — Repetitive work that may deserve dedicated agents

List tasks that happen often enough to justify a specialist agent later.

| Repetitive task | Current owner | Frequency | Pain caused today | Candidate future agent? |
|---|---|---:|---|---|
| Example: cron failure scan | Jarvis | Daily | Easy to miss failures | Cron monitor |
|  |  |  |  |  |
|  |  |  |  |  |
|  |  |  |  |  |
|  |  |  |  |  |

Questions:
- Which tasks are mostly pattern recognition?
- Which tasks require memory compression more than creativity?
- Which tasks need strict truthfulness about missing data?
- Which tasks are currently small but guaranteed to grow?

Notes:

---

## Section 4 — Minimum org needed to ship `aries-app` cleanly

Define the smallest org that still gives enough coverage to ship without ownership drift.

### Must-have roles now
- [ ] Jarvis / Mission Control
- [ ] Jarvis / Direct Implementation
- [ ] Rohan / Frontend
- [ ] Roy / Backend
- [ ] Somwya / Human Ops / Manual Execution
- [ ] Other must-have role:
- [ ] Other must-have role:

### Can stay TBD in Episode 1
- [ ] Runtime & Automation lead
- [ ] Integration / QA support
- [ ] Briefs / knowledge steward
- [ ] Approval / handoff follow-through
- [ ] Other TBD role:

### Cannot be left ownerless
- [ ] Integration verification
- [ ] Runtime visibility truthfulness
- [ ] Cron failure follow-through
- [ ] Manual approvals / external dependencies
- [ ] Release checklist execution
- [ ] Other:

Notes:

---

## Section 5 — Future specialist agents to pressure-test

Think ahead to Episode 2 / Episode 3. These are not commitments yet.

### Runtime visibility
Potential specialist:
- Name:
- Purpose:
- What inputs would it watch daily?
- What decisions could it make safely?
- What still requires human review?

### Cron monitoring
Potential specialist:
- Name:
- Purpose:
- What failures should trigger escalation?
- What automatic repair is safe?
- What should remain visible rather than hidden?

### Lobster / flow monitoring
Potential specialist:
- Name:
- Purpose:
- What counts as healthy?
- What drift patterns matter?
- What repair loops are safe vs unsafe?

### Model usage / cost / defaults
Potential specialist:
- Name:
- Purpose:
- What should it surface daily or weekly?
- What thresholds matter?
- What would it never change automatically?

### Briefs / planning / memory compression
Potential specialist:
- Name:
- Purpose:
- Which docs should it compress?
- What output format reduces management load?
- What should never be summarized without evidence?

### QA / verification
Potential specialist:
- Name:
- Purpose:
- What validation is repeatable?
- What still needs a human?
- What evidence counts as real completion?

---

## Section 6 — What must stay human?

Mark the areas where human ownership should remain explicit even if agents help around the edges.

- [ ] Final approvals
- [ ] Scope changes with material product impact
- [ ] High-risk production actions
- [ ] Manual account/dashboard checks
- [ ] Final QA signoff
- [ ] External publishing
- [ ] Other:

Notes:

---

## Section 7 — Gaps in the current operating model

Use this section to capture anything that still feels structurally weak.

Prompt ideas:
- Where is ownership drifting?
- What work is getting done but not being verified?
- Which dependencies are manual but easy to forget?
- Where is runtime truth still missing?
- Which responsibilities are overloaded onto Jarvis by default?

Notes:

---

## Section 8 — Episode 2 candidates

Once Episode 1 feels right, what is the next layer to add?

- [ ] richer org chart editing
- [ ] role-to-agent mapping
- [ ] link org nodes to Command tasks
- [ ] link org nodes to Runtime surfaces
- [ ] ownership overlays for blocked work
- [ ] human vs AI lane filter
- [ ] role capacity / load view
- [ ] other:

Notes:

---

## Final checkpoint

Before expanding the org chart, answer these directly:

1. What is the minimum org that can actually ship `aries-app` cleanly?
2. What should Jarvis keep doing directly instead of routing outward?
3. Which repetitive tasks deserve specialist agents first?
4. Which parts of Mission Control need ownership before the dashboard grows further?
5. What should remain human-owned even after Episode 2?

Answers:
