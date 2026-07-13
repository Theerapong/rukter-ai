# Hackathon Submission Draft

## Project Title

Rukter.ai Product Story Director

Public repository: [github.com/Theerapong/rukter-ai](https://github.com/Theerapong/rukter-ai)

## Short Description

An AMD-powered director that turns real product photos into identity-safe story videos, exposes every AI and GPU activity, and renders approved cinematic jobs on a visible persistent MI300X ROCm worker.

## Track

Track 3 - Unicorn (Open Innovation)

## Product Thesis

Generic AI site builders already create attractive pages. Rukter focuses on a harder commerce problem: producing reusable product motion without changing the product, packaging text, or logo. A seller uploads one to eight photos. Fireworks Vision analyzes visible evidence and directs a source-grounded story. Motion Preview animates the exact source photos in the browser for zero GPU cost. AMD Cinematic uses an always-on MI300X ROCm worker to generate separate Wan 2.2 clips, reject identity drift, and compose an MP4.

The user can see the entire system: upload, vision analysis, Product DNA, owner render approval, queue state, GPU worker state, motion shots, identity check, composition, and persistent GPU retention. The runtime inspector shows the current worker, billing state, output, and always-on persistent policy. Failure never becomes an invisible spinner or a mislabeled browser fallback; it becomes a visible failed activity.

## AMD Differentiation

- Fireworks AI performs product understanding and story direction on AMD-hosted inference.
- The AMD worker verifies `rocminfo`, records device and ROCm version, and runs the cinematic pipeline.
- The GPU workflow combines SAM2 product masks, Wan 2.2 image-to-video motion, and OCR plus visual-embedding identity checks.
- Rukter accepts cinematic output only when `evidence.identityVerified` is true.
- Current production uses one owner-funded persistent AMD MI300X worker tagged `rukter-product-story-persistent`.
- The persistent worker is retained between jobs with `retain_after_job`; credits continue while the Droplet is active.
- Ephemeral lease support remains for zero-idle/fallback operation only. Ephemeral workers are destroyed after success, failure, cancellation, or TTL expiry, and persistent-tagged workers are excluded from the reaper.

## Demo Script

1. Open `rukter.ai`; show that the first screen has no sample image and starts on Product Story Director.
2. Upload one to eight views of one real product.
3. Select Motion Preview and start the job.
4. Show source upload, Fireworks vision/story direction, and browser Motion Preview activities updating in the workspace.
5. Play the directed preview and switch shots from the source timeline.
6. Show that Motion Preview has no AMD render billing and is not labeled as AMD Cinematic.
7. Export the WebM and storyboard JSON.
8. Check AMD capacity; show the persistent MI300X worker, `retain_after_job` release policy, and persistent billing state.
9. Select AMD Cinematic for the judging run; show Product DNA and directed-shot owner review before approval.
10. Approve the render; show FIFO queue state, MI300X/ROCm evidence, multiple Wan 2.2 shots, MP4 composition, identity verification, and persistent worker retention after completion.
11. Open `/product-twin.html` to show the related 3D Product Twin workflow.

## Hard Requirement Gate

- Public repository and anonymously pullable `linux/amd64` container image.
- Main container ready in under 60 seconds.
- Job creation and status API responses under 30 seconds.
- All generated responses in English.
- No hardcoded answers for evaluated inputs.
- Real Fireworks and AMD GPU evidence captured in the repository and demo.
- Any temporary AMD Notebook session shut down after evidence capture.
- Production uses exactly one persistent tagged MI300X worker for AMD Cinematic; duplicate persistent workers fail CI/operator checks because they waste credits.
- Ephemeral fallback workers, when used, are destroyed rather than powered off.
- No cinematic result accepted without product identity evidence.
