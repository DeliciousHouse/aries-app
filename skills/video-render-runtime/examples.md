# Video render runtime examples

## Safe input brief

```json
{
  "prompt": "Create a six-second vertical teaser for the approved weekly post.",
  "aspect_ratio": "9:16",
  "duration_seconds": 6,
  "input_assets": [
    {
      "type": "https_url",
      "url": "https://cdn.example.com/approved-assets/product-hero.png",
      "mime_type": "image/png",
      "role": "reference_image"
    }
  ]
}
```

Local paths, private hosts, loopback URLs, credentials, and traversal forms are invalid source locators.

## Completed callback

```json
{
  "event_id": "evt-video-render-123e4567",
  "aries_run_id": "arun_123e4567-e89b-42d3-a456-426614174001",
  "hermes_run_id": "hermes-video-render-123e4567",
  "status": "completed",
  "stage": "video_render",
  "output": [
    {
      "artifacts": [
        {
          "id": "clip-primary",
          "path": "/home/node/.hermes/cache/videos/video_render_123e4567.mp4",
          "mime_type": "video/mp4",
          "bytes": 1843200,
          "platform_slug": "instagram_reels",
          "family_id": "weekly_primary",
          "width": 1080,
          "height": 1920,
          "duration_seconds": 6
        }
      ]
    }
  ]
}
```

## Retryable failure with preserved partial output

```json
{
  "event_id": "evt-video-render-rate-limit-123e4567",
  "aries_run_id": "arun_123e4567-e89b-42d3-a456-426614174001",
  "hermes_run_id": "hermes-video-render-123e4567",
  "status": "failed",
  "stage": "video_render",
  "output": [
    {
      "artifacts": [
        {
          "id": "clip-primary",
          "path": "/home/node/.hermes/cache/videos/video_render_123e4567.mp4",
          "mime_type": "video/mp4",
          "bytes": 1843200,
          "platform_slug": "instagram_reels",
          "family_id": "weekly_primary"
        }
      ]
    }
  ],
  "error": {
    "code": "rate_limited",
    "message": "One requested variant did not finish before the upstream rate limit.",
    "retryable": true
  }
}
```

The completed clip remains in `output`; Aries ingests it durably before surfacing the failure.
