# marketing activation phase log

- fetched failing + active reference workflows via n8n API
- compared settings/node types/typeVersion/options fields
- suspected unsupported set-node option shape in failing workflows (values.json on set typeVersion 2)

- patched failing workflows: marketing-research, marketing-strategy, marketing-approval-resume
- patch scope: set node parameter option/property values only (values.json -> stringified JSON fields)
- republished and activated all target workflows
- final active states: research=true, strategy=true, approval-resume=true
