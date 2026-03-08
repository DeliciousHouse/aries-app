# n8n auth diagnosis phase log

- env base url present: true
- env api key present: true
- api key length: 267
- header exact X-N8N-API-KEY: true
- preflight /rest status: 401
- preflight /api/v1 status: 200
- root cause: wrong_endpoint_path_previously_used_rest_instead_of_api_v1
