# AMD Product Story Worker

This image is the GPU-side contract for Rukter Product Story. It refuses jobs unless `rocminfo` reports a real AMD device, and it refuses output unless the pipeline returns an identity-verified public video.

## Pipeline contract

The cloud-init bootstrap installs `run_story_pipeline.sh`, which accepts:

```text
run_story_pipeline.sh /tmp/input.json /tmp/output.json
```

The input follows `rukter.product_story.v1` and contains one to eight public source image URLs. The output must contain:

```json
{
  "videoUrl": "https://.../story.mp4",
  "format": "video/mp4",
  "width": 384,
  "height": 672,
  "durationSeconds": 8,
  "evidence": {
    "identityVerified": true,
    "shotCount": 5,
    "method": "SAM2 mask plus OCR and visual-embedding thresholds",
    "shots": [
      { "id": "shot-1", "identityVerified": true, "clipUrl": "https://.../shot-1.mp4" }
    ],
    "failureCodes": [],
    "observedFailureCodes": ["ocr_retention_below_threshold"],
    "attemptHistory": [{ "shotId": "shot-1", "attempts": [] }]
  }
}
```

The AMD pipeline is not a slideshow. It generates one 2-5 second Wan 2.2 TI2V clip per directed shot at the story plan's requested output dimensions, verifies five evenly spaced frames with CLIP similarity and product-surface OCR retention, and composes accepted clips with FFmpeg into one color-graded MP4. Multi-shot jobs divide a bounded inference-step budget across shots on each generation pass so the requested story can finish on the persistent worker; an evidence-driven retry receives a second bounded pass, and the worker timeout covers both. OCR from editorial overlays, arrows, captions, or infographic labels is treated as annotation evidence instead of required product identity. A failed clip or missing shot fails the Cinematic job. It is never silently replaced with Motion Preview.

Each shot may provide product-specific `identityLocks` and an `allowPeople` policy. `allowPeople` permits non-occluding background context only; hands, bodies, clothing, or people touching or overlapping the product still fail the shot. Retry instructions are derived from those locks and typed local failure codes; no product category or component name is built into the worker. Source images are fetched without redirects only from the origin configured by `RUKTER_SOURCE_ORIGIN` (or derived from `OUTPUT_UPLOAD_URL`), with MIME, byte, decoded-pixel, and dimension limits. OCR uses English and Thai language data when available so original-script packaging evidence is not discarded. `WORKER_TOKEN` is required by default; local-only unsecured operation requires the explicit `RUKTER_ALLOW_INSECURE_WORKER=true` opt-out.

The worker is bootstrapped from this public repository on the official `rocm/pytorch` image. The repository's main judging container remains publicly available as Linux AMD64:

```bash
docker buildx imagetools inspect ghcr.io/theerapong/rukter-ai:latest
```

The production worker uses the persistent AMD MI300X lease selected by the orchestrator. `retain_after_job` keeps that Droplet and its model cache online between jobs; worker safety changes must not stop or destroy it automatically.
