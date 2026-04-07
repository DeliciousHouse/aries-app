name: marketing-stage1-research-wrapper
args:
  competitor_url:
    default: ""
  competitor:
    default: ""
  competitor_brand:
    default: ""
  facebook_page_url:
    default: ""
  competitor_facebook_url:
    default: ""
  ad_library_url:
    default: ""
  meta_page_id:
    default: ""
  research_model:
    default: gemini/gemini-3-flash-preview
steps:
  - id: stage1_research
    env:
      COMPETITOR_URL: "$LOBSTER_ARG_COMPETITOR_URL"
      COMPETITOR: "$LOBSTER_ARG_COMPETITOR"
      COMPETITOR_BRAND: "$LOBSTER_ARG_COMPETITOR_BRAND"
      FACEBOOK_PAGE_URL: "$LOBSTER_ARG_FACEBOOK_PAGE_URL"
      COMPETITOR_FACEBOOK_URL: "$LOBSTER_ARG_COMPETITOR_FACEBOOK_URL"
      AD_LIBRARY_URL: "$LOBSTER_ARG_AD_LIBRARY_URL"
      META_PAGE_ID: "$LOBSTER_ARG_META_PAGE_ID"
      RESEARCH_MODEL: "$LOBSTER_ARG_RESEARCH_MODEL"
    run: |
      python3 ./bin/stage1-research-compat \
        --json \
        --competitor-url "$COMPETITOR_URL" \
        --competitor "$COMPETITOR" \
        --competitor-brand "$COMPETITOR_BRAND" \
        --facebook-page-url "$FACEBOOK_PAGE_URL" \
        --competitor-facebook-url "$COMPETITOR_FACEBOOK_URL" \
        --ad-library-url "$AD_LIBRARY_URL" \
        --meta-page-id "$META_PAGE_ID" \
        --research-model "$RESEARCH_MODEL"
