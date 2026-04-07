name: marketing-stage4-publish-finalize-wrapper
args:
  run_id:
    default: ""
  brand_slug:
    default: client-brand
steps:
  - id: publish_finalize
    env:
      RUN_ID: "$LOBSTER_ARG_RUN_ID"
      BRAND_SLUG: "$LOBSTER_ARG_BRAND_SLUG"
    run: |
      python3 ./bin/stage4-publish-compat \
        --json \
        --run-id "$RUN_ID" \
        --brand-slug "$BRAND_SLUG"
