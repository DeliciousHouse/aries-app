name: stage-2-strategy-finalize
args:
  brand_slug:
    default: "client-brand"
  research_model:
    default: "gemini/gemini-3-flash-preview"
  run_id:
    default: ""
steps:
  - id: finalize_strategy
    command: >-
      ./bin/stage2-finalize-bridge --json --brand-slug "${brand_slug}" --research-model "${research_model}" --run-id "${run_id}"
