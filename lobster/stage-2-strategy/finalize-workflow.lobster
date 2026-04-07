name: marketing-stage2-strategy-finalize-wrapper
args:
  run_id:
    default: ""
  brand_slug:
    default: client-brand
  research_model:
    default: gemini/gemini-3-flash-preview
steps:
  - id: stage2_finalize
    env:
      RUN_ID: "$LOBSTER_ARG_RUN_ID"
      BRAND_SLUG: "$LOBSTER_ARG_BRAND_SLUG"
      RESEARCH_MODEL: "$LOBSTER_ARG_RESEARCH_MODEL"
    run: |
      python3 ./bin/stage2-finalize-bridge \
        --json \
        --run-id "$RUN_ID" \
        --brand-slug "$BRAND_SLUG" \
        --research-model "$RESEARCH_MODEL"
