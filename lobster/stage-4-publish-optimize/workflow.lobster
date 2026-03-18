name: stage-4-publish-optimize
args:
  brand_slug:
    default: "client-brand"
  production_handoff:
    default: {}
  production_handoff_base64:
    default: ""
  production_handoff_path:
    default: ""
steps:
  - id: performance_marketer_preflight
    command: ./bin/performance-marketer --json --mode preflight --brand-slug "${brand_slug}" --production-handoff-base64 "${production_handoff_base64}" --production-handoff-path "${production_handoff_path}"
    stdin: $production_handoff
  - id: launch_review
    command: ./bin/launch-review-preview --json --brand-slug "${brand_slug}" --launch-approved true --notify-chat false
    stdin: $performance_marketer_preflight.stdout
  - id: meta_ads_publisher
    command: ./bin/meta-ads-publisher --json --brand-slug "${brand_slug}"
    stdin: $performance_marketer_preflight.stdout
  - id: instagram_publisher
    command: ./bin/instagram-publisher --json --brand-slug "${brand_slug}"
    stdin: $performance_marketer_preflight.stdout
  - id: x_publisher
    command: ./bin/x-publisher --json --brand-slug "${brand_slug}"
    stdin: $performance_marketer_preflight.stdout
  - id: tiktok_publisher
    command: ./bin/tiktok-publisher --json --brand-slug "${brand_slug}"
    stdin: $performance_marketer_preflight.stdout
  - id: youtube_publisher
    command: ./bin/youtube-publisher --json --brand-slug "${brand_slug}"
    stdin: $performance_marketer_preflight.stdout
  - id: linkedin_publisher
    command: ./bin/linkedin-publisher --json --brand-slug "${brand_slug}"
    stdin: $performance_marketer_preflight.stdout
  - id: reddit_publisher
    command: ./bin/reddit-publisher --json --brand-slug "${brand_slug}"
    stdin: $performance_marketer_preflight.stdout
  - id: optimize_summary
    command: ./bin/performance-marketer --json --mode summarize --brand-slug "${brand_slug}"
    stdin: $reddit_publisher.stdout
