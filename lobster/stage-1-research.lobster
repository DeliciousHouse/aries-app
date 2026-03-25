name: stage-1-research
args:
  agent_id:
    default: main
  competitor:
    default: ""
  research_mode:
    default: top 5
steps:
  - id: validate_args
    run: python3 ./bin/validate_args.py competitor
  - id: requirements
    run: python3 ./bin/check_requirements.py --stage research
  - id: bootstrap
    run: ./bin/bootstrap_marketing_workspace.sh
  - id: ads_analyst
    env:
      AGENT_ID: "$LOBSTER_ARG_AGENT_ID"
      COMPETITOR: "$LOBSTER_ARG_COMPETITOR"
      RESEARCH_MODE: "$LOBSTER_ARG_RESEARCH_MODE"
    run: |
      python3 ./bin/invoke_skill.py             --agent-id "$AGENT_ID"             --skill "ads-analyst"             --input "${COMPETITOR}${RESEARCH_MODE:+ ${RESEARCH_MODE}}"
