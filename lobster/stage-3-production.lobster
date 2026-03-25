name: stage-3-production
args:
  agent_id:
    default: main
steps:
  - id: requirements
    run: python3 ./bin/check_requirements.py --stage production
  - id: bootstrap
    run: ./bin/bootstrap_marketing_workspace.sh
  - id: creative_director
    env:
      AGENT_ID: "$LOBSTER_ARG_AGENT_ID"
    run: |
      python3 ./bin/invoke_skill.py             --agent-id "$AGENT_ID"             --skill "creative-director"             --input "Use the approved campaign proposal and current brand bible in this session to build the campaign assets now."
