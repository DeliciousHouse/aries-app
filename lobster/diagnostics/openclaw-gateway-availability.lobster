name: openclaw-lobster-gateway-availability
args:
  marker:
    default: ""
  output_location:
    default: "output/diagnostics/openclaw-lobster-availability.json"
steps:
  - id: write_availability_report
    env:
      SMOKE_MARKER: "${marker}"
      SMOKE_WORKFLOW: "diagnostics/openclaw-gateway-availability.lobster"
      SMOKE_OUTPUT_LOCATION: "${output_location}"
    command: >
      python3 ./bin/openclaw-lobster-availability-smoke.py
      --marker "$SMOKE_MARKER"
      --workflow "$SMOKE_WORKFLOW"
      --output-location "$SMOKE_OUTPUT_LOCATION"
