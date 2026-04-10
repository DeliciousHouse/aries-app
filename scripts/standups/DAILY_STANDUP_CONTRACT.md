# Daily Standup Contract

Canonical routing path for chief standups:
- produce the standup in structured JSON
- post it immediately to Mission Control routing ingestion
- transcript parsing is fallback only

## Required flow

1. Create a structured chief report JSON file.
2. Post it with:

```bash
node scripts/standups/post-chief-routing-report.mjs /home/node/.openclaw/projects/shared/team/standups/YYYY-MM-DD/report.json
```

Default endpoint:
- `http://127.0.0.1:4174/api/routing-requests/from-chief-report`

Override with:
- `MISSION_CONTROL_ROUTING_ENDPOINT`

## Minimum JSON shape

```json
{
  "sourceType": "standup",
  "chiefId": "forge",
  "chiefAgentId": "delivery-chief",
  "reportStatus": "complete",
  "boardPath": "/app/mission-control/server/data/execution-tasks.json",
  "activeTaskId": "task-id",
  "currentStatus": "ready",
  "humanDependencies": [
    {
      "target": "brendan",
      "summary": "Decision needed",
      "requestedAction": "Confirm dependency",
      "nextAction": "Await Brendan decision"
    }
  ],
  "needsJarvisRouting": [
    {
      "summary": "Routing help needed",
      "requestedAction": "Escalate blocker handling to Jarvis",
      "nextAction": "Jarvis routes blocker after approval"
    }
  ],
  "reassignmentProposals": [
    {
      "assigneeId": "rohan",
      "requestedAction": "Reassign task to Rohan",
      "reason": "Frontend owner should pick up the next slice"
    }
  ],
  "priorityBumps": [
    {
      "priority": "P1",
      "requestedAction": "Raise priority to P1",
      "reason": "Blocking current delivery"
    }
  ]
}
```

## Approval policy

Approval required:
- reassignment to a human
- status changes with material downstream effect
- blocker escalation
- Brendan dependency requests
- Jarvis routing requests
- force actions

Auto-apply allowed only for low-risk non-human-confirmation updates.

## Fallback

If structured post fails, save the transcript as normal under `/home/node/.openclaw/projects/shared/team/meetings`. Mission Control can still parse transcript sections as fallback, but that is not the primary path.
