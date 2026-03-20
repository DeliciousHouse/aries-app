name: marketing-pipeline
args:
  competitor:
    default: ""
  competitor_facebook_url:
    default: ""
  website_url:
    default: ""
  brand_slug:
    default: "client-brand"
steps:
  - id: stage1
    command: >-
      lobster run ./stage-1-research/workflow.lobster
      --args-json '{"competitor":"${competitor}","competitor_facebook_url":"${competitor_facebook_url}","strict_mode":true}'
  - id: stage2
    command: >-
      cat | lobster run ./stage-2-strategy/review-workflow.lobster
      --args-json '{"website_url":"${website_url}","brand_slug":"${brand_slug}","strict_mode":true}'
    stdin: $stage1.stdout
