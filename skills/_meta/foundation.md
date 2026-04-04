# Skills Foundation

## Directory convention

New custom skills should use this path shape:

```text
skills/<category>/<skill-name>/
├── SKILL.md
├── references/   # optional
├── scripts/      # optional
└── assets/       # optional
```

### Naming rules

- Use lowercase letters, digits, and hyphens only.
- Keep category names short and stable.
- Keep skill names deterministic and machine-friendly.
- Prefer verb-led or outcome-led names like `client-outreach`, `proposal-generator`, `client-reporting`.
- Do not add spaces, underscores, or title case.

### Recommended agency-operation categories

- `intake`
- `research`
- `outreach`
- `proposals`
- `delivery`
- `reporting`
- `operations`
- `internal`

### Legacy note

Existing flat skills under `skills/<skill-name>/` can remain in place.
All new custom skills should use the categorized convention above so the library can grow without turning into a flat root.

## Index contract

Register every governed custom skill in `skills/index.json`.

Required fields per skill:

- `name`
- `owner`
- `status`
- `last_updated`

Recommended companion fields:

- `category`
- `path`
- `version`
- `visibility`
- `replaced_by`

### Field rules

- `last_updated` must use `YYYY-MM-DD`.
- `status` must be one of: `draft`, `active`, `deprecated`, `archived`.
- `visibility.scope` defaults to `all`.
- `visibility.agents` stays empty unless access is restricted later.

## Per-agent visibility later

Do not encode agent visibility inside `SKILL.md` frontmatter.
Keep the skill content reusable and manage access from the index layer.

Use this future-ready pattern in `skills/index.json`:

```json
"visibility": {
  "scope": "all",
  "agents": []
}
```

When per-agent visibility is introduced:

- keep shared skills on `scope: all`
- use `scope: allowlist` plus `agents: ["jarvis", "rohan"]` for restricted skills
- prefer one shared skill plus index-based visibility over duplicating the same skill per agent
- only fork a skill per agent when the workflow actually differs

## Governance

### Versioning

Use simple semantic versioning in the index:

- major: breaking change to triggers, expected inputs, or output contract
- minor: backward-compatible capability expansion
- patch: copy edits, QA improvements, examples, or non-breaking guardrail updates

### Lifecycle

Use this status path unless there is a good reason not to:

```text
draft -> active -> deprecated -> archived
```

### Deprecation rules

When deprecating a skill:

1. Set `status` to `deprecated` in `skills/index.json`.
2. Add `replaced_by` when a successor exists.
3. Leave the old skill directory in place until references and callers are updated.
4. Move to `archived` only after the replacement is ready or explicit approval says to retire it.

### Change discipline

- Update `last_updated` on every meaningful edit.
- Bump `version` on every governed edit.
- Keep naming and path stable after activation unless there is a breaking reason to move it.
- If a skill is moved, update the index in the same change.
