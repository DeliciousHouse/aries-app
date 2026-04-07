name: marketing-stage3-production-review-wrapper
args:
  brand_slug:
    default: client-brand
  strategy_handoff_base64:
    default: ""
  research_model:
    default: gemini/gemini-3-flash-preview
steps:
  - id: production_review
    env:
      BRAND_SLUG: "$LOBSTER_ARG_BRAND_SLUG"
      STRATEGY_HANDOFF_BASE64: "$LOBSTER_ARG_STRATEGY_HANDOFF_BASE64"
      RESEARCH_MODEL: "$LOBSTER_ARG_RESEARCH_MODEL"
    run: |
      python3 ./bin/stage3-review-compat \
        --json \
        --brand-slug "$BRAND_SLUG" \
        --strategy-handoff-base64 "$STRATEGY_HANDOFF_BASE64" \
        --research-model "$RESEARCH_MODEL"
