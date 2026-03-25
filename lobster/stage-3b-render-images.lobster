name: stage-3b-render-images
args:
  agent_id:
    default: main
  jobs_file:
    default: ./output/marketing-pipeline/jobs/images/pending/image_jobs.jsonl
  image_output_dir:
    default: ./output/marketing-pipeline/ad-images
steps:
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
