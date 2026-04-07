name: marketing-stage3-production-finalize-wrapper
args:
  run_id:
    default: ""
  brand_slug:
    default: client-brand
  research_model:
    default: gemini/gemini-3-flash-preview
steps:
  - id: stage3_finalize
    env:
      RUN_ID: "$LOBSTER_ARG_RUN_ID"
      BRAND_SLUG: "$LOBSTER_ARG_BRAND_SLUG"
      RESEARCH_MODEL: "$LOBSTER_ARG_RESEARCH_MODEL"
    run: |
      python3 ./bin/stage3-finalize-bridge \
        --json \
        --run-id "$RUN_ID" \
        --brand-slug "$BRAND_SLUG" \
        --research-model "$RESEARCH_MODEL"
