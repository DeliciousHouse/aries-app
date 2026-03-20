name: stage-4-publish-optimize
args:
  brand_slug:
    default: "client-brand"
  production_handoff:
    default: {}
  production_handoff_base64:
    default: ""
  production_handoff_path:
    default: ""
steps:
  - id: performance_marketer_preflight
    command: ./bin/performance-marketer --json --mode preflight --brand-slug "${brand_slug}" --production-handoff-base64 "${production_handoff_base64}" --production-handoff-path "${production_handoff_path}"
    stdin: $production_handoff
  - id: launch_review
    command: ./bin/launch-review-preview --json --brand-slug "${brand_slug}" --launch-approved false --notify-chat false
    stdin: $performance_marketer_preflight.stdout
