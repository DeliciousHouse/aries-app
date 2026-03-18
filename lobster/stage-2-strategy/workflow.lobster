name: stage-2-strategy
args:
  website_url:
    default: ""
  brand_slug:
    default: "client-brand"
  research_model:
    default: "gemini/gemini-3-flash-preview"
  stage1_summary:
    default: {}
  stage1_summary_base64:
    default: ""
steps:
  - id: website_brand_analysis
    command: >-
      ./bin/website-brand-analysis --json --website-url "${website_url}" --brand-slug "${brand_slug}" --research-model "${research_model}" --stage1-summary-base64 "${stage1_summary_base64}"
  - id: persist_brand_profile
    command: ./bin/brand-profile-db-contract --json --brand-slug "${brand_slug}" --research-model "${research_model}"
    stdin: $website_brand_analysis.stdout
  - id: campaign_planner
    command: ./bin/campaign-planner --json --brand-slug "${brand_slug}" --research-model "${research_model}"
    stdin: $persist_brand_profile.stdout
  - id: finalize_strategy
    command: ./bin/head-of-marketing --json --mode finalize --brand-slug "${brand_slug}" --research-model "${research_model}"
    stdin: $campaign_planner.stdout
