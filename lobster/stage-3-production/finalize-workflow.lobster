name: stage-3-production-finalize
args:
  brand_slug:
    default: "client-brand"
  research_model:
    default: "gemini/gemini-3-flash-preview"
  run_id:
    default: ""
steps:
  - id: finalize_production
    command: >-
      ./bin/stage3-finalize-bridge --json --brand-slug "${brand_slug}" --research-model "${research_model}" --run-id "${run_id}"
