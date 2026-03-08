# examples.md

## 1) Generate workflow JSON with allowed nodes only

Goal: webhook -> set -> if -> httpRequest -> respondToWebhook

```json
{
  "name": "Local Test Webhook Flow",
  "nodes": [
    {
      "name": "Webhook",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 1,
      "position": [240, 300],
      "parameters": {
        "path": "local-test",
        "httpMethod": "POST",
        "responseMode": "responseNode"
      }
    },
    {
      "name": "Normalize Input",
      "type": "n8n-nodes-base.set",
      "typeVersion": 3,
      "position": [520, 300],
      "parameters": {
        "keepOnlySet": false,
        "values": {
          "string": [
            {
              "name": "source",
              "value": "webhook"
            }
          ]
        }
      }
    },
    {
      "name": "Should Call API",
      "type": "n8n-nodes-base.if",
      "typeVersion": 2,
      "position": [760, 300],
      "parameters": {
        "conditions": {
          "boolean": [
            {
              "value1": "={{$json.triggerApi || false}}",
              "operation": "isTrue"
            }
          ]
        }
      }
    },
    {
      "name": "Call External API",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4,
      "position": [1020, 200],
      "parameters": {
        "url": "https://httpbin.org/post",
        "method": "POST",
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{$json}}"
      }
    },
    {
      "name": "Respond",
      "type": "n8n-nodes-base.respondToWebhook",
      "typeVersion": 1,
      "position": [1260, 300],
      "parameters": {
        "respondWith": "json",
        "responseBody": "={{ { ok: true, data: $json } }}",
        "options": {}
      }
    }
  ],
  "connections": {
    "Webhook": {
      "main": [[{ "node": "Normalize Input", "type": "main", "index": 0 }]]
    },
    "Normalize Input": {
      "main": [[{ "node": "Should Call API", "type": "main", "index": 0 }]]
    },
    "Should Call API": {
      "main": [
        [{ "node": "Call External API", "type": "main", "index": 0 }],
        [{ "node": "Respond", "type": "main", "index": 0 }]
      ]
    },
    "Call External API": {
      "main": [[{ "node": "Respond", "type": "main", "index": 0 }]]
    }
  },
  "settings": {},
  "active": false
}
```

## 2) Publish workflow via n8n API (create, then activate)

```bash
BASE_URL="http://localhost:5678"

# create/import
CREATE_RES=$(curl -sS -w "\n%{http_code}" \
  -H "Content-Type: application/json" \
  -X POST "$BASE_URL/rest/workflows" \
  --data-binary @workflow.json)

CREATE_BODY=$(echo "$CREATE_RES" | sed '$d')
CREATE_CODE=$(echo "$CREATE_RES" | tail -n1)

echo "create status: $CREATE_CODE"
echo "create body: $CREATE_BODY"

WF_ID=$(echo "$CREATE_BODY" | jq -r '.id // empty')

# activate if create succeeded
if [ -n "$WF_ID" ] && [ "$CREATE_CODE" -ge 200 ] && [ "$CREATE_CODE" -lt 300 ]; then
  ACT_RES=$(curl -sS -w "\n%{http_code}" \
    -H "Content-Type: application/json" \
    -X PATCH "$BASE_URL/rest/workflows/$WF_ID" \
    --data '{"active":true}')

  ACT_BODY=$(echo "$ACT_RES" | sed '$d')
  ACT_CODE=$(echo "$ACT_RES" | tail -n1)

  echo "activate status: $ACT_CODE"
  echo "activate body: $ACT_BODY"
fi
```

## 3) Section-only repair loop (max 3 attempts)

Pseudo-flow:

1. Attempt publish/activate.
2. If error references `nodes[2].parameters.conditions`, patch only that node section.
3. Retry.
4. If error references `connections.Should Call API.main[1]`, patch only that connection branch.
5. Retry.
6. Stop after 3 repair attempts and report last error.

Example failure summary format:

```text
Publish failed after 3 repair attempts.
Last stage: activation
Last HTTP status: 400
Last error: Node “Respond” expects responseMode=responseNode on Webhook node.
Patched sections tried:
1) nodes[0].parameters.responseMode
2) nodes[4].parameters.respondWith
3) connections.Call External API.main
```

## 4) executeCommand node safety example

Use project-root anchored commands only:

```json
{
  "name": "Run Local Script",
  "type": "n8n-nodes-base.executeCommand",
  "typeVersion": 1,
  "parameters": {
    "command": "cd $HOME/.openclaw/workspace/aries-platform-bootstrap && npm run test:smoke"
  }
}
```
