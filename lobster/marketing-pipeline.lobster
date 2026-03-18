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
  launch_approved:
    default: false
  notify_chat:
    default: true
steps:
  - id: stage1
    command: >-
      lobster run ./stage-1-research/workflow.lobster
      --args-json '{"competitor":"${competitor}","competitor_facebook_url":"${competitor_facebook_url}"}'
  - id: stage2
    command: >-
      cat | lobster run ./stage-2-strategy/workflow.lobster
      --args-json '{"website_url":"${website_url}","brand_slug":"${brand_slug}"}'
    stdin: $stage1.stdout
  - id: stage3
    command: >-
      ./bin/stage3-production-bridge --json --brand-slug "${brand_slug}"
    stdin: $stage2.stdout
  - id: stage4
    command: >-
      ./bin/stage4-publish-bridge --json --brand-slug "${brand_slug}" --launch-approved "${launch_approved}" --notify-chat "${notify_chat}"
    stdin: $stage3.stdout
