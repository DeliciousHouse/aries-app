name: marketing-pipeline
args:
  agent_id:
    default: default
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
steps:
  - id: validate_root_args
    env:
      LOBSTER_ARG_COMPETITOR: "${competitor}"
      LOBSTER_ARG_BRAND_URL: "${brand_url}"
    command: python3 ../bin/validate_args.py competitor brand_url
  - id: requirements
    command: python3 ../bin/check_requirements.py --stage research
  - id: bootstrap
    command: bash ../bin/bootstrap_marketing_workspace.sh

  - id: stage_1_extract
    command: |
      bash -lc '
        set -euo pipefail
        cmd=(./bin/meta-ads-extractor --json --competitor "$1" --research-model "gemini/gemini-2.5-flash")
        if [ -n "$2" ]; then
          cmd+=(--competitor-facebook-url "$2")
        fi
        "${cmd[@]}"
      ' -- "${competitor}" "${competitor_facebook_url}"

  - id: stage_1_analyse
    command: ./bin/meta-ads-analyser --json
    stdin: $stage_1_extract.json

  - id: stage_1_creative
    command: ./bin/ad-creative-analysis --json
    stdin: $stage_1_analyse.json

  - id: stage_1_compile
    command: ./bin/ads-analyst --json --mode compile
    stdin: $stage_1_creative.json

  - id: approve_stage_2
    command: >
      printf '%s\n' '{"prompt":"Stage 1 complete. Continue to Stage 2 and run head-of-marketing for the provided brand_url?"}'
    approval: required

  - id: stage_2_brand_analysis
    command: >
      ./bin/website-brand-analysis --json
      --website-url "${brand_url}"
      --brand-slug "${brand_slug}"
    stdin: $stage_1_compile.json
    when: $approve_stage_2.approved

  - id: stage_2_profile
    command: >
      ./bin/brand-profile-db-contract --json
      --brand-slug "${brand_slug}"
    stdin: $stage_2_brand_analysis.json
    when: $approve_stage_2.approved

  - id: stage_2_plan
    command: >
      ./bin/campaign-planner --json
      --brand-slug "${brand_slug}"
    stdin: $stage_2_profile.json
    when: $approve_stage_2.approved

  - id: stage_2_review_preview
    command: >
      ./bin/strategy-review-preview --json
      --brand-slug "${brand_slug}"
    stdin: $stage_2_plan.json
    when: $approve_stage_2.approved

  - id: stage_2_finalize
    command: >
      ./bin/head-of-marketing --json
      --mode finalize
      --brand-slug "${brand_slug}"
    stdin: $stage_2_plan.json
    when: $approve_stage_2.approved

  - id: approve_stage_3
    command: >
      printf '%s\n' '{"prompt":"Stage 2 complete. Approve the campaign proposal and continue to Stage 3 production?"}'
    approval: required

  - id: stage_3_preflight
    command: >
      ./bin/creative-director --json
      --mode preflight
      --brand-slug "${brand_slug}"
    stdin: $stage_2_finalize.json
    when: $approve_stage_3.approved

  - id: stage_3_page
    command: >
      ./bin/page-designer --json
      --brand-slug "${brand_slug}"
    stdin: $stage_3_preflight.json
    when: $approve_stage_3.approved

  - id: stage_3_script
    command: >
      ./bin/scriptwriter --json
      --brand-slug "${brand_slug}"
    stdin: $stage_3_preflight.json
    when: $approve_stage_3.approved

  - id: stage_3_ad
    command: >
      ./bin/ad-designer --json
      --brand-slug "${brand_slug}"
    stdin: $stage_3_script.json
    when: $approve_stage_3.approved

  - id: stage_3_video
    command: >
      ./bin/veo-video-generator --json
      --brand-slug "${brand_slug}"
    stdin: $stage_3_ad.json
    when: $approve_stage_3.approved

  - id: stage_3_review_preview
    command: >
      ./bin/production-review-preview --json
      --brand-slug "${brand_slug}"
    stdin: $stage_3_video.json
    when: $approve_stage_3.approved

  - id: stage_3_finalize
    command: >
      ./bin/creative-director --json
      --mode finalize
      --brand-slug "${brand_slug}"
    stdin: $stage_3_review_preview.json
    when: $approve_stage_3.approved

  - id: approve_stage_4
    command: >
      printf '%s\n' '{"prompt":"Stage 3 complete. Approve the creative assets and continue to Stage 4 publishing?"}'
    approval: required

  - id: stage_4_preflight
    command: >
      ./bin/performance-marketer --json
      --mode preflight
      --brand-slug "${brand_slug}"
    stdin: $stage_3_finalize.json
    when: $approve_stage_4.approved

  - id: stage_4_launch_review
    command: >
      ./bin/launch-review-preview --json
      --brand-slug "${brand_slug}"
      --launch-approved false
      --notify-chat false
    stdin: $stage_4_preflight.json
    when: $approve_stage_4.approved

  - id: approve_stage_4_publish
    command: >
      printf '%s\n' '{"prompt":"Stage 4 pre-flight complete. Approve creation of the Meta campaigns, ad sets, and ads as PAUSED?"}'
    approval: required
    when: $approve_stage_4.approved

  - id: stage_4_publish_paused
    command: >
      ./bin/stage4-publish-compat --json
      --brand-slug "${brand_slug}"
    stdin: $stage_3_finalize.json
    when: $approve_stage_4_publish.approved
