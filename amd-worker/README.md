# AMD Product Story Worker

This image is the GPU-side contract for Rukter Product Story. It refuses jobs unless `rocminfo` reports a real AMD device, and it refuses output unless the pipeline returns an identity-verified public video.

## Pipeline contract

The cloud-init bootstrap installs `run_story_pipeline.sh`, which accepts:

```text
run_story_pipeline.sh /tmp/input.json /tmp/output.json
```

The input follows `rukter.product_story.v1` and contains three to eight public source image URLs. The output must contain:

```json
{
  "videoUrl": "https://.../story.mp4",
  "format": "video/mp4",
  "width": 1080,
  "height": 1920,
  "durationSeconds": 15,
  "evidence": {
    "identityVerified": true,
    "shotCount": 5,
    "method": "SAM2 mask plus OCR and visual-embedding thresholds",
    "shots": [
      { "id": "shot-1", "identityVerified": true, "clipUrl": "https://.../shot-1.mp4" }
    ]
  }
}
```

The AMD pipeline is not a slideshow. It generates one 3-5 second Wan 2.2 TI2V clip per directed shot, verifies sampled frames with CLIP similarity and OCR retention, and composes accepted clips with FFmpeg into one color-graded MP4. A failed clip or missing shot fails the Cinematic job. It is never silently replaced with Motion Preview.

The worker is bootstrapped from this public repository on the official `rocm/pytorch` image. The repository's main judging container remains publicly available as Linux AMD64:

```bash
docker buildx imagetools inspect ghcr.io/theerapong/rukter-ai:latest
```

The worker is not an idle service. The lifecycle orchestrator creates an AMD MI300X Droplet for a job and destroys the Droplet in a `finally` path.
