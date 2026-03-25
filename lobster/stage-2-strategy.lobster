name: stage-2-strategy
args:
  agent_id:
    default: main
  brand_url:
    default: ""
steps:
  - id: validate_args
    run: python3 ./bin/validate_args.py brand_url
  - id: requirements
    run: python3 ./bin/check_requirements.py --stage strategy
  - id: bootstrap
    run: ./bin/bootstrap_marketing_workspace.sh
  - id: head_of_marketing
    env:
      AGENT_ID: "$LOBSTER_ARG_AGENT_ID"
      BRAND_URL: "$LOBSTER_ARG_BRAND_URL"
    run: |
      python3 ./bin/invoke_skill.py             --agent-id "$AGENT_ID"             --skill "head-of-marketing"             --input "$BRAND_URL"
