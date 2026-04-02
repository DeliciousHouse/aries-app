name: parity-calendar-sync
args:
  tenant_id:
    default: ""
  window_start:
    default: ""
  window_end:
    default: ""
steps:
  - id: sync_calendar_snapshot
    command: >
      node ./bin/calendar-sync.mjs
      --tenant-id "${tenant_id}"
      --window-start "${window_start}"
      --window-end "${window_end}"
