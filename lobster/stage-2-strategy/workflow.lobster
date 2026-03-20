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
  strict_mode:
    default: true
steps:
  - id: website_brand_analysis
    command: >-
      ./bin/website-brand-analysis --json --website-url "${website_url}" --brand-slug "${brand_slug}" --research-model "${research_model}" --stage1-summary-base64 "${stage1_summary_base64}" --strict-mode "${strict_mode}"
  - id: campaign_planner
    command: ./bin/campaign-planner --json --brand-slug "${brand_slug}" --research-model "${research_model}"
    stdin: $website_brand_analysis.stdout
  - id: strategy_review_preview
    command: ./bin/strategy-review-preview --json --brand-slug "${brand_slug}" --research-model "${research_model}"
    stdin: $campaign_planner.stdout
