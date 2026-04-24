name: marketing-pipeline
args:
  agent_id:
    default: default
  competitor_url:
    default: ""
  competitor_brand:
    default: ""
  facebook_page_url:
    default: ""
  ad_library_url:
    default: ""
  meta_page_id:
    default: ""
  competitor:
    default: ""
  competitor_facebook_url:
    default: ""
  research_mode:
    default: top 5
  brand_url:
    default: ""
  brand_slug:
    default: client-brand
  job_id:
    default: ""
cwd: lobster
steps:
  - id: validate_root_args
    env:
      BRAND_URL: "${brand_url}"
    command: |
      python3 - <<'PY'
      import os
      import sys
      import urllib.parse

      value = (os.environ.get("BRAND_URL") or "").strip()
      if not value:
          raise SystemExit("brand_url is required")
      parsed = urllib.parse.urlparse(value)
      if parsed.scheme not in {"http", "https"} or not parsed.netloc:
          raise SystemExit("brand_url must be a valid http(s) URL")
      sys.stdout.write(value + "\n")
      PY
  - id: requirements
    command: |
      bash -lc '
        set -euo pipefail
        command -v python3 >/dev/null
        command -v bash >/dev/null
      '
  - id: bootstrap
    command: |
      bash -lc '
        set -euo pipefail
        mkdir -p ./output
      '

  - id: stage_1_extract
    command: |
      bash -lc '
        set -euo pipefail
        cmd=(python3 ./bin/meta-ads-extractor --json --research-model "gemini/gemini-3-pro-image-preview" --strict-mode true)
        if [ -n "$1" ]; then
          cmd+=(--competitor-url "$1")
        fi
        if [ -n "$2" ]; then
          cmd+=(--competitor "$2")
        fi
        if [ -n "$3" ]; then
          cmd+=(--competitor-brand "$3")
        fi
        if [ -n "$4" ]; then
          cmd+=(--facebook-page-url "$4")
        fi
        if [ -n "$5" ]; then
          cmd+=(--ad-library-url "$5")
        fi
        if [ -n "$6" ]; then
          cmd+=(--meta-page-id "$6")
        fi
        if [ -n "$7" ]; then
          cmd+=(--competitor-facebook-url "$7")
        fi
        "${cmd[@]}"
      ' -- "${competitor_url}" "${competitor}" "${competitor_brand}" "${facebook_page_url}" "${ad_library_url}" "${meta_page_id}" "${competitor_facebook_url}"

  - id: stage_1_analyse
    command: python3 ./bin/meta-ads-analyser --json
    stdin: $stage_1_extract.json

  - id: stage_1_creative
    command: python3 ./bin/ad-creative-analysis --json
    stdin: $stage_1_analyse.json

  - id: stage_1_compile
    command: python3 ./bin/ads-analyst --json --mode compile
    stdin: $stage_1_creative.json

  - id: approve_stage_2
    command: >
      python3 ./bin/_approval_bridge
      --prompt "Stage 1 complete. Continue to Stage 2 and run head-of-marketing for the provided brand_url?"
      --stage stage-1
      --action-label "Approve research"
    stdin: $stage_1_compile.json
    approval: required

  - id: stage_2_brand_kit
    command: >
      ../node_modules/.bin/tsx ./bin/brand-kit-bootstrap.ts
      --tenant-id "${brand_slug}"
      --brand-url "${brand_url}"
    when: $approve_stage_2.approved

  - id: stage_2_brand_analysis
    command: >
      python3 ./bin/website-brand-analysis --json
      --website-url "${brand_url}"
      --brand-slug "${brand_slug}"
    stdin: $stage_1_compile.json
    when: $approve_stage_2.approved

  - id: stage_2_profile
    command: >
      python3 ./bin/brand-profile-db-contract --json
      --brand-slug "${brand_slug}"
    stdin: $stage_2_brand_analysis.json
    when: $approve_stage_2.approved

  - id: stage_2_plan
    command: >
      python3 ./bin/campaign-planner --json
      --brand-slug "${brand_slug}"
    stdin: $stage_2_profile.json
    when: $approve_stage_2.approved

  - id: stage_2_review_preview
    command: >
      python3 ./bin/strategy-review-preview --json
      --brand-slug "${brand_slug}"
    stdin: $stage_2_plan.json
    when: $approve_stage_2.approved

  - id: stage_2_finalize
    command: >
      python3 ./bin/head-of-marketing --json
      --mode finalize
      --brand-slug "${brand_slug}"
    stdin: $stage_2_plan.json
    when: $approve_stage_2.approved

  - id: approve_stage_3
    command: >
      python3 ./bin/_approval_bridge
      --prompt "Stage 2 complete. Approve the campaign proposal and continue to Stage 3 production?"
      --stage stage-2
      --action-label "Approve strategy"
    stdin: $stage_2_finalize.json
    approval: required

  - id: stage_3_preflight
    command: >
      python3 ./bin/creative-director --json
      --mode preflight
      --brand-slug "${brand_slug}"
    stdin: $stage_2_finalize.json
    when: $approve_stage_3.approved

  - id: stage_3_page
    command: >
      python3 ./bin/page-designer --json
      --brand-slug "${brand_slug}"
    stdin: $stage_3_preflight.json
    when: $approve_stage_3.approved

  - id: stage_3_script
    command: >
      python3 ./bin/scriptwriter --json
      --brand-slug "${brand_slug}"
    stdin: $stage_3_preflight.json
    when: $approve_stage_3.approved

  - id: stage_3_ad
    command: >
      python3 ./bin/ad-designer --json
      --brand-slug "${brand_slug}"
    stdin: $stage_3_script.json
    when: $approve_stage_3.approved

  - id: stage_3_video
    command: >
      python3 ./bin/veo-video-generator --json
      --brand-slug "${brand_slug}"
      --job-id "${job_id}"
    stdin: $stage_3_ad.json
    when: $approve_stage_3.approved

  - id: stage_3_review_preview
    command: >
      python3 ./bin/production-review-preview --json
      --brand-slug "${brand_slug}"
    stdin: $stage_3_video.json
    when: $approve_stage_3.approved

  - id: stage_3_finalize
    command: >
      python3 ./bin/creative-director --json
      --mode finalize
      --brand-slug "${brand_slug}"
    stdin: $stage_3_review_preview.json
    when: $approve_stage_3.approved

  # Stage 4 preflight + launch review now run BEFORE the approve_stage_4 gate so the
  # user sees real platform previews and the 30-day funnel-weighted content calendar
  # at the approval surface. Without this reorder, the gate asks for approval on a
  # creative package the UI cannot yet display (launch-review-preview hasn't run).
  - id: stage_4_preflight
    command: >
      python3 ./bin/performance-marketer --json
      --mode preflight
      --brand-slug "${brand_slug}"
    stdin: $stage_3_finalize.json
    when: $approve_stage_3.approved

  - id: stage_4_launch_review
    command: >
      python3 ./bin/launch-review-preview --json
      --brand-slug "${brand_slug}"
      --launch-approved false
      --notify-chat false
    stdin: $stage_4_preflight.json
    when: $approve_stage_3.approved

  - id: approve_stage_4
    command: >
      python3 ./bin/_approval_bridge
      --prompt "Stage 3 creative and the 30-day launch calendar are ready. Approve the package to continue to publish?"
      --stage stage-4-launch-review
      --action-label "Approve production"
    stdin: $stage_4_launch_review.json
    approval: required

  - id: approve_stage_4_publish
    command: >
      python3 ./bin/_approval_bridge
      --prompt "Approve creation of the Meta campaigns, ad sets, and ads as PAUSED?"
      --stage stage-4-launch-review
      --action-label "Approve launch"
    stdin: $stage_4_launch_review.json
    approval: required
    when: $approve_stage_4.approved

  - id: stage_4_publish_paused
    command: >
      python3 ./bin/stage4-publish-compat --json
      --brand-slug "${brand_slug}"
    stdin: $stage_3_finalize.json
    when: $approve_stage_4_publish.approved
