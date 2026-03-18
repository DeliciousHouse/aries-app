name: stage-3-production
args:
  brand_slug:
    default: "client-brand"
  strategy_handoff:
    default: {}
  strategy_handoff_base64:
    default: ""
steps:
  - id: creative_director_preflight
    command: ./bin/creative-director --json --mode preflight --brand-slug "${brand_slug}" --strategy-handoff-base64 "${strategy_handoff_base64}"
  - id: page_designer
    command: ./bin/page-designer --json --brand-slug "${brand_slug}"
    stdin: $creative_director_preflight.stdout
  - id: scriptwriter
    command: ./bin/scriptwriter --json --brand-slug "${brand_slug}"
    stdin: $creative_director_preflight.stdout
  - id: ad_designer
    command: ./bin/ad-designer --json --brand-slug "${brand_slug}"
    stdin: $scriptwriter.stdout
  - id: veo_video_generator
    command: ./bin/veo-video-generator --json --brand-slug "${brand_slug}" --video-model "veo-3.0-generate-001"
    stdin: $scriptwriter.stdout
  - id: production_review
    command: ./bin/production-review-preview --json --brand-slug "${brand_slug}"
    stdin: $veo_video_generator.stdout
  - id: finalize_production
    command: ./bin/creative-director --json --mode finalize --brand-slug "${brand_slug}"
    stdin: $production_review.stdout
