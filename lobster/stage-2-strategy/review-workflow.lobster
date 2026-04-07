name: marketing-stage2-strategy-review-wrapper
args:
  brand_url:
    default: ""
  brand_slug:
    default: client-brand
  stage1_summary_base64:
    default: ""
  research_model:
    default: gemini/gemini-3-flash-preview
steps:
  - id: brand_kit_bootstrap
    env:
      BRAND_SLUG: "$LOBSTER_ARG_BRAND_SLUG"
      BRAND_URL: "$LOBSTER_ARG_BRAND_URL"
    run: |
      ./node_modules/.bin/tsx ./bin/brand-kit-bootstrap.ts \
        --tenant-id "$BRAND_SLUG" \
        --brand-url "$BRAND_URL"
  - id: website_brand_analysis
    env:
      BRAND_SLUG: "$LOBSTER_ARG_BRAND_SLUG"
      BRAND_URL: "$LOBSTER_ARG_BRAND_URL"
    run: |
      python3 ./bin/website-brand-analysis \
        --json \
        --website-url "$BRAND_URL" \
        --brand-slug "$BRAND_SLUG"
  - id: strategy_review
    env:
      BRAND_URL: "$LOBSTER_ARG_BRAND_URL"
      BRAND_SLUG: "$LOBSTER_ARG_BRAND_SLUG"
      STAGE1_SUMMARY_BASE64: "$LOBSTER_ARG_STAGE1_SUMMARY_BASE64"
      RESEARCH_MODEL: "$LOBSTER_ARG_RESEARCH_MODEL"
    run: |
      python3 ./bin/stage2-review-compat \
        --json \
        --brand-url "$BRAND_URL" \
        --brand-slug "$BRAND_SLUG" \
        --stage1-summary-base64 "$STAGE1_SUMMARY_BASE64" \
        --research-model "$RESEARCH_MODEL"
