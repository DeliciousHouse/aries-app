# Provider-neutral video render examples

## Submit through the Hermes execution seam

```json
{
  "job_id": "2c3f3c1f-3bea-4ba3-9ec7-33bd7f194901",
  "correlation_id": "99af8034-f8ab-49e0-bb3e-a4bca9cdbd75",
  "tenant_id": "tenant-example",
  "execution_provider": "hermes",
  "created_at": "2026-07-27T10:00:00Z",
  "priority": "normal",
  "idempotency_key": "video-render:tenant-example:weekly-42:reel-1",
  "render_request": {
    "prompt": "A vertical product story with natural motion, warm light, and no embedded text.",
    "video": {
      "duration_seconds": 8,
      "aspect_ratio": "9:16",
      "width_px": 1080,
      "height_px": 1920
    }
  },
  "callback": {
    "url": "https://aries.example.com/api/internal/hermes/runs",
    "auth_mode": "internal_secret"
  }
}
```

The request intentionally contains no downstream media provider, model, credentials, endpoint, or operation identifier.

## Record Hermes acceptance

```json
{
  "accepted": true,
  "job_id": "2c3f3c1f-3bea-4ba3-9ec7-33bd7f194901",
  "hermes_run_id": "run_01JZEXAMPLE",
  "runtime_state_ref": "generated/draft/video-runs/2c3f3c1f-3bea-4ba3-9ec7-33bd7f194901.json",
  "accepted_at": "2026-07-27T10:00:01Z"
}
```

## Normalize a completed artifact

```json
{
  "uri": "hermes-video-cache://weekly-42-reel-1.mp4",
  "mime_type": "video/mp4",
  "duration_seconds": 8,
  "width_px": 1080,
  "height_px": 1920,
  "bytes": 4213376,
  "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

Aries ingests the localized bytes into durable storage before exposing or publishing the video.
