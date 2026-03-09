# examples.md

## 1) Submit a text-to-video Veo generation request

```bash
PROJECT_ID="my-gcp-project"
LOCATION="us-central1"
MODEL="veo-2.0-generate-001"
TOKEN="$(gcloud auth print-access-token)"

cat > request.json <<'JSON'
{
  "instances": [
    {
      "prompt": "A cinematic drone shot over a foggy pine forest at sunrise, slow forward motion, natural lighting"
    }
  ],
  "parameters": {
    "sampleCount": 1,
    "durationSeconds": 8,
    "aspectRatio": "16:9"
  }
}
JSON

curl -sS -X POST \
  "https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateVideos" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary @request.json
```

Expected response includes long-running `name`:

```json
{ "name": "projects/.../locations/us-central1/operations/1234567890" }
```

## 2) Poll long-running operation until done

```bash
OP_NAME="projects/.../locations/us-central1/operations/1234567890"
LOCATION="us-central1"
TOKEN="$(gcloud auth print-access-token)"

attempt=0
sleep_s=5
max_sleep=30

while true; do
  attempt=$((attempt + 1))
  res=$(curl -sS -w "\n%{http_code}" \
    -H "Authorization: Bearer ${TOKEN}" \
    "https://${LOCATION}-aiplatform.googleapis.com/v1/${OP_NAME}")

  body=$(echo "$res" | sed '$d')
  code=$(echo "$res" | tail -n1)

  done_flag=$(echo "$body" | jq -r '.done // false')
  err_msg=$(echo "$body" | jq -r '.error.message // empty')

  echo "attempt=$attempt status=$code done=$done_flag"

  if [ "$done_flag" = "true" ]; then
    if [ -n "$err_msg" ]; then
      echo "operation failed: $err_msg"
      exit 1
    fi
    echo "$body" > operation-final.json
    break
  fi

  sleep "$sleep_s"
  sleep_s=$((sleep_s * 2))
  if [ "$sleep_s" -gt "$max_sleep" ]; then
    sleep_s=$max_sleep
  fi
done
```

## 3) Normalize artifact metadata from final operation payload

Target normalized shape:

```json
{
  "provider": "vertex-ai",
  "model": "veo-2.0-generate-001",
  "operationName": "projects/.../operations/1234567890",
  "prompt": {
    "text": "A cinematic drone shot over a foggy pine forest at sunrise, slow forward motion, natural lighting"
  },
  "artifacts": [
    {
      "id": "video-1",
      "mimeType": "video/mp4",
      "uri": "gs://bucket/path/output0.mp4",
      "durationSeconds": 8,
      "width": 1920,
      "height": 1080,
      "sha256": null,
      "sourceIndex": 0,
      "providerMetadata": {}
    }
  ],
  "createdAt": "2026-03-09T08:05:04Z",
  "rawOperation": {}
}
```

## 4) Bounded repair examples (section-only)

- `401/403`: refresh bearer token and retry submit (auth section only).
- `404` on model path: patch model id/location in endpoint only.
- Poll timeout: patch polling interval/timeout values only.
- Missing artifact uri mapping: patch normalization mapping only.

Stop after 3 repair attempts and report last stage + status + error payload.
