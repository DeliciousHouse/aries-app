# marketing workflow publish phase log

## marketing-research.workflow.json @ 2026-03-08T20:14:18.542Z
- create/update: true
- activate: false
- active: false
- hard_failure: true
- failure_message: Could not find property option
## marketing-strategy.workflow.json @ 2026-03-08T20:14:19.038Z
- create/update: true
- activate: false
- active: false
- hard_failure: true
- failure_message: Could not find property option
## marketing-production.workflow.json @ 2026-03-08T20:14:19.273Z
- create/update: true
- activate: true
- active: true
- hard_failure: false
## marketing-publish.workflow.json @ 2026-03-08T20:14:19.576Z
- create/update: true
- activate: true
- active: true
- hard_failure: false
## marketing-repair.workflow.json @ 2026-03-08T20:14:19.837Z
- create/update: true
- activate: true
- active: true
- hard_failure: false
## marketing-approval-resume.workflow.json @ 2026-03-08T20:14:20.125Z
- create/update: true
- activate: false
- active: false
- hard_failure: true
- failure_message: Could not find property option
- verify marketing-research: exists=true active=false
- verify marketing-strategy: exists=true active=false
- verify marketing-production: exists=true active=true
- verify marketing-publish: exists=true active=true
- verify marketing-repair: exists=true active=true
- verify marketing-approval-resume: exists=true active=false
