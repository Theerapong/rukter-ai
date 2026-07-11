# Hackathon Submission Draft

## Project Title

Rukter.ai Product Story Director

Public repository: [github.com/Theerapong/rukter-ai](https://github.com/Theerapong/rukter-ai)

## Short Description

An AMD-powered director that turns real product photos into identity-safe story videos, exposes every AI and GPU activity, and destroys expensive GPU compute immediately after each job.

## Track

Track 3 - Unicorn (Open Innovation)

## Product Thesis

Generic AI site builders already create attractive pages. Rukter focuses on a harder commerce problem: producing reusable product motion without changing the product, packaging text, or logo. A seller uploads three to eight photos. Fireworks Vision analyzes visible evidence and directs a multi-shot story. Motion Preview animates the exact source photos in the browser for zero GPU cost. AMD Cinematic provisions an ephemeral ROCm worker to generate separate Wan 2.2 clips, reject identity drift, and compose an MP4.

The user can see the entire system: upload, vision analysis, storyboard, GPU provision, motion shots, identity check, composition, and GPU release. The runtime inspector shows the current worker, billing state, output, and `destroy_after_job` policy. Failure never becomes an invisible spinner or a mislabeled browser fallback; it becomes a visible failed activity.

## AMD Differentiation

- Fireworks AI performs product understanding and story direction on AMD-hosted inference.
- The AMD worker verifies `rocminfo`, records device and ROCm version, and runs the cinematic pipeline.
- The GPU workflow combines SAM2 product masks, Wan 2.2 image-to-video motion, and OCR plus visual-embedding identity checks.
- Rukter accepts cinematic output only when `evidence.identityVerified` is true.
- The lease orchestrator creates one AMD MI300X worker per job and destroys it after success, failure, cancellation, or timeout.
- A five-minute background reaper destroys idle leases at a 30-minute hard TTL if the job process disappears.

## Demo Script

1. Open `rukter.ai`; show that the first screen has no sample image and AMD GPU is offline.
2. Upload three to eight views of one real product.
3. Select Motion Preview and start the job.
4. Show all eight activities updating in the workspace.
5. Play the directed 9:16 preview and switch shots from the source timeline.
6. Show the identity guard and inactive GPU billing state.
7. Export the WebM and storyboard JSON.
8. Select AMD Cinematic for the judging run; show AMD MI300X and ROCm evidence, multiple Wan 2.2 shots, MP4 composition, identity verification, then GPU destruction and inactive billing.
9. Open `/product-twin.html` to show the related 3D Product Twin workflow.

## Hard Requirement Gate

- Public repository and anonymously pullable `linux/amd64` container image.
- Main container ready in under 60 seconds.
- Job creation and status API responses under 30 seconds.
- All generated responses in English.
- No hardcoded answers for evaluated inputs.
- Real Fireworks and AMD GPU evidence captured in the repository and demo.
- AMD Notebook or GPU session shut down after evidence capture.
- GPU Droplet destroyed, not merely powered off, after every cinematic job.
- No cinematic result accepted without product identity evidence.
