name: stage-4-publish-finalize
args:
  brand_slug:
    default: "client-brand"
  production_handoff:
    default: {}
  production_handoff_base64:
    default: ""
  production_handoff_path:
    default: ""
  meta_ads_enabled:
    default: true
  instagram_enabled:
    default: true
  x_enabled:
    default: true
  tiktok_enabled:
    default: true
  youtube_enabled:
    default: true
  linkedin_enabled:
    default: true
  reddit_enabled:
    default: true
  meta_ads_live_publish_requested:
    default: false
  instagram_live_publish_requested:
    default: false
  x_live_publish_requested:
    default: false
  linkedin_live_publish_requested:
    default: false
  reddit_live_publish_requested:
    default: false
  tiktok_render_requested:
    default: false
  youtube_render_requested:
    default: false
steps:
  - id: performance_marketer_preflight
    command: ./bin/performance-marketer --json --mode preflight --brand-slug "${brand_slug}" --production-handoff-base64 "${production_handoff_base64}" --production-handoff-path "${production_handoff_path}"
    stdin: $production_handoff
  - id: approved_launch_review
    command: ./bin/launch-review-preview --json --brand-slug "${brand_slug}" --launch-approved true --notify-chat false
    stdin: $performance_marketer_preflight.stdout
  - id: meta_ads_publisher
    command: ./bin/meta-ads-publisher --json --brand-slug "${brand_slug}" --enabled "${meta_ads_enabled}" --live-publish-requested "${meta_ads_live_publish_requested}"
    stdin: $performance_marketer_preflight.stdout
  - id: instagram_publisher
    command: ./bin/instagram-publisher --json --brand-slug "${brand_slug}" --enabled "${instagram_enabled}" --live-publish-requested "${instagram_live_publish_requested}"
    stdin: $performance_marketer_preflight.stdout
  - id: x_publisher
    command: ./bin/x-publisher --json --brand-slug "${brand_slug}" --enabled "${x_enabled}" --live-publish-requested "${x_live_publish_requested}"
    stdin: $performance_marketer_preflight.stdout
  - id: tiktok_publisher
    command: ./bin/tiktok-publisher --json --brand-slug "${brand_slug}" --enabled "${tiktok_enabled}" --render-requested "${tiktok_render_requested}"
    stdin: $performance_marketer_preflight.stdout
  - id: youtube_publisher
    command: ./bin/youtube-publisher --json --brand-slug "${brand_slug}" --enabled "${youtube_enabled}" --render-requested "${youtube_render_requested}"
    stdin: $performance_marketer_preflight.stdout
  - id: linkedin_publisher
    command: ./bin/linkedin-publisher --json --brand-slug "${brand_slug}" --enabled "${linkedin_enabled}" --live-publish-requested "${linkedin_live_publish_requested}"
    stdin: $performance_marketer_preflight.stdout
  - id: reddit_publisher
    command: ./bin/reddit-publisher --json --brand-slug "${brand_slug}" --enabled "${reddit_enabled}" --live-publish-requested "${reddit_live_publish_requested}"
    stdin: $performance_marketer_preflight.stdout
  - id: optimize_summary
    command: ./bin/performance-marketer --json --mode summarize --brand-slug "${brand_slug}"
    stdin: $approved_launch_review.stdout
