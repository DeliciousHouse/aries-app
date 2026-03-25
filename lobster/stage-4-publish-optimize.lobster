name: stage-4-publish-optimize
args:
  agent_id:
    default: main
steps:
  - id: requirements
    run: python3 ./bin/check_requirements.py --stage publish
  - id: bootstrap
    run: ./bin/bootstrap_marketing_workspace.sh
  - id: performance_marketer_preflight
    env:
      AGENT_ID: "$LOBSTER_ARG_AGENT_ID"
    run: |
      python3 ./bin/invoke_skill.py             --agent-id "$AGENT_ID"             --skill "performance-marketer"             --input "Use the approved assets from creative-director and run the pre-flight check now."
  - id: approve_publish_paused
    approval: >
      Stage 4 pre-flight complete. Approve creation of the Meta campaigns, ad sets, and ads as PAUSED?
    stdin: $performance_marketer_preflight.stdout
  - id: performance_marketer_publish
    env:
      AGENT_ID: "$LOBSTER_ARG_AGENT_ID"
    run: |
      python3 ./bin/invoke_skill.py             --agent-id "$AGENT_ID"             --skill "performance-marketer"             --input "Approved. Create the campaigns, ad sets, and ads as PAUSED now. Do not activate them."
    when: $approve_publish_paused.approved
