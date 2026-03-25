name: stage-3-production
args:
  agent_id:
    default: main
  jobs_file:
    default: ./output/marketing-pipeline/jobs/images/pending/image_jobs.jsonl
  image_output_dir:
    default: ./output/marketing-pipeline/ad-images
steps:
  - id: requirements
    run: python3 ./bin/check_requirements.py --stage production

  - id: bootstrap
    run: ./bin/bootstrap_marketing_workspace.sh

  - id: prepare_directories
    env:
      JOBS_FILE: "$LOBSTER_ARG_JOBS_FILE"
      IMAGE_OUTPUT_DIR: "$LOBSTER_ARG_IMAGE_OUTPUT_DIR"
    run: |
      mkdir -p \
        "$(dirname "$JOBS_FILE")" \
        "$(dirname "$JOBS_FILE")/completed" \
        "$(dirname "$JOBS_FILE")/failed" \
        "$(dirname "$JOBS_FILE")/logs" \
        "$IMAGE_OUTPUT_DIR"

  - id: creative_director_plan_and_non_image_assets
    env:
      AGENT_ID: "$LOBSTER_ARG_AGENT_ID"
      JOBS_FILE: "$LOBSTER_ARG_JOBS_FILE"
      IMAGE_OUTPUT_DIR: "$LOBSTER_ARG_IMAGE_OUTPUT_DIR"
    run: |
      python3 ./bin/invoke_skill.py \
        --agent-id "$AGENT_ID" \
        --skill "creative-director" \
        --input "Use the approved campaign proposal and current brand bible in this session to build production assets in a rate-limit-safe order. First create landing pages and video scripts only. Then create a compact one-image-per-line JSONL queue at $JOBS_FILE for every required image ad. Each JSON line must contain exactly these keys: asset_id, funnel_stage, platform, aspect_ratio, objective, landing_page, headline, body_copy, visual_concept, style_notes, brand_constraints, negative_constraints, exact_text. Keep every field compact. Do not call /ad_designer in this step. Do not batch image generation. Use the image output directory $IMAGE_OUTPUT_DIR when describing output targets. Print the queue file path on the final line."

  - id: verify_jobs_file
    env:
      JOBS_FILE: "$LOBSTER_ARG_JOBS_FILE"
    run: |
      python3 ./bin/verify_image_jobs.py --jobs-file "$JOBS_FILE"

  - id: render_images_sequentially
    env:
      AGENT_ID: "$LOBSTER_ARG_AGENT_ID"
      JOBS_FILE: "$LOBSTER_ARG_JOBS_FILE"
      IMAGE_OUTPUT_DIR: "$LOBSTER_ARG_IMAGE_OUTPUT_DIR"
    run: |
      python3 ./bin/render_image_queue.py \
        --agent-id "$AGENT_ID" \
        --jobs-file "$JOBS_FILE" \
        --image-output-dir "$IMAGE_OUTPUT_DIR" \
        --completed-dir "$(dirname "$JOBS_FILE")/completed" \
        --failed-dir "$(dirname "$JOBS_FILE")/failed" \
        --log-dir "$(dirname "$JOBS_FILE")/logs" \
        --delay-seconds 12 \
        --max-retries 5

  - id: creative_director_final_review
    env:
      AGENT_ID: "$LOBSTER_ARG_AGENT_ID"
      JOBS_FILE: "$LOBSTER_ARG_JOBS_FILE"
      IMAGE_OUTPUT_DIR: "$LOBSTER_ARG_IMAGE_OUTPUT_DIR"
    run: |
      python3 ./bin/invoke_skill.py \
        --agent-id "$AGENT_ID" \
        --skill "creative-director" \
        --input "Review the completed landing pages, scripts, and rendered image assets now. The queue source is $JOBS_FILE and rendered image targets are in $IMAGE_OUTPUT_DIR. Package the final deliverables for user review. Do not regenerate images unless a specific queue item failed."
