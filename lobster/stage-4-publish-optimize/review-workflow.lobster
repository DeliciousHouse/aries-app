name: marketing-stage4-publish-review-wrapper
args:
  brand_slug:
    default: client-brand
  production_handoff_base64:
    default: ""
steps:
  - id: publish_review
    env:
      BRAND_SLUG: "$LOBSTER_ARG_BRAND_SLUG"
      PRODUCTION_HANDOFF_BASE64: "$LOBSTER_ARG_PRODUCTION_HANDOFF_BASE64"
    run: |
      python3 ./bin/stage4-review-compat \
        --json \
        --brand-slug "$BRAND_SLUG" \
        --production-handoff-base64 "$PRODUCTION_HANDOFF_BASE64"
