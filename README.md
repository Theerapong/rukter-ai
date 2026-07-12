# Rukter.ai Product Story Director

Rukter.ai Launch Agent is a Track 3 Unicorn submission concept for **AMD Developer Hackathon: ACT II**.

Public source: [github.com/Theerapong/rukter-ai](https://github.com/Theerapong/rukter-ai)

## Repository boundary and secrets

This public repository contains only the standalone `rukter.ai` hackathon application and its deployment definitions. The private `rukter.com` platform implementation is not included; `rukter.com` appears here only as a published HTTPS integration endpoint.

Never commit API keys, cloud tokens, SSH private keys, Terraform state, or runtime `.env` files. Production credentials are supplied only through protected, masked GitLab CI/CD variables and secret runtime environment values. `.env.example` contains names and non-secret placeholders only.

It turns three to eight real product photos into a directed story. Fireworks Vision identifies the product and writes evidence-aware story copy. Motion Preview animates source photos in the browser and exports a portable WebM without GPU cost. AMD Cinematic creates multiple 3-5 second Wan 2.2 image-to-video shots on ROCm, verifies product identity per shot, and composes the accepted clips into a cinematic MP4.

The default screen has no sample product. The primary flow is deliberately short: **upload views -> choose direction -> direct story -> export**. The workspace exposes all eight job activities, current progress, source-photo timeline, identity guard, worker state, GPU billing state, and release status.

## Zero-idle AMD GPU lifecycle

AMD Cinematic uses an ephemeral lease instead of an always-on GPU:

1. Rukter creates a story plan before requesting compute.
2. The lease orchestrator creates one AMD MI300X worker only for that job.
3. The worker must report a real ROCm device and pass product identity checks.
4. The orchestrator destroys the GPU Droplet after success, failure, timeout, or cancellation.
5. A five-minute background reaper destroys idle leases at a 30-minute hard TTL if the job process disappears.

Powering off a GPU Droplet does not stop billing. The required release policy is `destroy_after_job`. Public AMD jobs remain disabled until the worker, destroy path, TTL reaper, regional access, and budget alerts have been verified manually.

Motion Preview is always available and starts no GPU lease. AMD Cinematic is disabled until a verified worker is online. A provisioning, generation, or identity-check failure fails the cinematic job visibly; Rukter never substitutes Motion Preview and labels it cinematic.

## Product Twin

The earlier 3D Product Twin remains available at `/product-twin.html`. It turns one to six product photos or one orbit video into an interactive, evidence-backed Product Twin. Orbit videos are decoded in the browser and reduced to six evenly spaced keyframes, so the original video never crosses the API boundary. Fireworks Vision identifies the product and visible packaging evidence. The server turns the detected region into a feathered transparent WebP asset, while Three.js provides a tactile preview and portable viewer.

The isolation pipeline keeps the largest detected foreground component, closes small mask gaps, erodes the contaminated edge, feathers the alpha channel, and removes background color spill. Each product asset reports `matteQuality`, `foregroundCoverage`, `componentCount`, and `edgeDecontaminated` evidence.

The Product Twin interface has one primary action: **Choose photos or video**. There is no sample product or default preview on its first screen. Optional notes, channel, and market settings stay behind the product-context control.

The geometry labels are intentionally strict:

- one source photo: `single_photo_2_5d` / **2.5D Product Twin Preview**
- multiple source photos without a reconstructed model: `multi_view_capture` / **Multi-view Capture Preview**
- multiple source photos plus a verified model URL from the AMD worker: `verified_multi_view_3d` / **Verified Multi-view 3D**

Multiple photos alone never qualify as verified 3D. When a real reconstruction worker is not configured, the UI explicitly states that depth and unseen surfaces are not verified.

## Orbit Video Reconstruction

On macOS, a recorded orbit video can be converted to a textured USDZ mesh with RealityKit Object Capture:

```bash
chmod +x scripts/reconstruct-orbit-video.sh
scripts/reconstruct-orbit-video.sh /path/to/product.MOV /path/to/product.usdz medium
```

The command extracts sequential frames with `ffmpeg`, compiles the RealityKit reconstruction helper, creates the asset, and validates it with `usdchecker`. This local path is useful for asset testing and Apple Quick Look. It is not labeled as AMD evidence; hackathon submission evidence must come from the configured AMD GPU worker or Fireworks inference path.

The web viewer accepts either GLB or USDZ model URLs. A reconstructed asset can be inspected without altering the upload workflow:

```text
http://localhost:3017/product-twin.html?model=/assets/product.usdz&name=Product&frames=46
```

The Product Twin can be saved to Rukter or exported as a standalone ZIP containing:

- `viewer.html`
- `viewer.css`
- `viewer.js`
- `product-twin.json`
- `images/product-*.webp`
- `models/product.glb` or `models/product.usdz` when a model is present
- `vendor/three.module.min.js`
- `vendor/three.core.min.js`
- portable GLTF and USD loaders when a model is present

The generated build also includes:

- AI product identification and editable description
- source-view manifest and reconstruction status
- observed visual evidence and explicit `not_verifiable` items
- portable interactive 2.5D viewer or verified model reference
- seller-verified claim guard that removes unsupported sales, review, health, and certification claims
- Rukter draft payload

The main Rukter product stays on `rukter.com`. This app is the AI doorway for `rukter.ai`.

## Why This Fits Track 3

Track 3 asks for an original AI application with practical product/startup potential and meaningful AMD platform usage. This project routes live product vision through Fireworks AI models hosted on AMD hardware. A separate AMD GPU reconstruction worker can be attached for verified multi-view GLB output. The generated evidence and product asset can also flow into Rukter as an unpublished editable draft.

The `amdEvidence` object is intentionally strict: only a completed Fireworks inference is marked `amdComputeVerified: true`. Deterministic local fallback output is useful for development, but is explicitly marked ineligible as hackathon evidence.

## Run Locally

```bash
cp .env.example .env
node server.mjs
```

Open:

```text
http://localhost:3017
```

The app works without API keys in deterministic demo mode. To use Fireworks inference, set:

```bash
export FIREWORKS_API_KEY="..."
export FIREWORKS_BASE_URL="https://api.fireworks.ai/inference/v1"
export FIREWORKS_MODEL="accounts/fireworks/models/deepseek-v4-flash"
export FIREWORKS_VISION_MODEL="accounts/fireworks/models/kimi-k2p6"
node server.mjs
```

`accounts/fireworks/models/deepseek-v4-flash` handles text-only requests. Image requests use the serverless multimodal `accounts/fireworks/models/kimi-k2p6` path because it is accessible to the current Fireworks account. Gemma remains configurable through `FIREWORKS_VISION_MODEL` or `GEMMA_VISION_MODEL` once a Gemma vision deployment is available.

By default the server tries `deepseek-v4-flash` first, then `gpt-oss-20b` only when enough of the shared request budget remains. Override the fallback list with a comma-separated `FIREWORKS_MODEL_FALLBACKS` value.

The production-safe defaults keep the request under the gateway budget while giving Fireworks enough room to return structured JSON:

```bash
export FIREWORKS_REQUEST_TIMEOUT_MS="24000"
export FIREWORKS_TOTAL_TIMEOUT_MS="27000"
export FIREWORKS_MAX_TOKENS="2048"
```

To enable verified multi-view reconstruction, deploy an AMD GPU worker that implements `rukter.product_twin_reconstruction_request.v1`, then configure:

```bash
export AMD_3D_WORKER_URL="https://your-amd-worker.example/api/product-twin"
export AMD_3D_WORKER_TOKEN="..."
```

The worker must return `status: "verified"`, an HTTPS `modelUrl`, and a model format such as `glb`. Worker failure or missing evidence falls back to the truthful multi-view preview mode.

To create a real unpublished Rukter dashboard draft through MCP, connect Rukter OAuth or provide a server-side token:

```bash
export RUKTER_MCP_URL="https://rukter.com/mcp"
export RUKTER_MCP_ACCESS_TOKEN="rkcg_access_v1..."
export RUKTER_AI_PUBLIC_URL="https://rukter.ai"
```

For production deploys, set `RUKTER_MCP_ACCESS_TOKEN` as a masked GitLab CI/CD variable. Terraform mounts it into the DigitalOcean App Platform runtime as a secret. If the variable is absent, the app still works through the browser OAuth connect flow.

The browser normalizes WebP, AVIF, or GIF uploads to a vision-compatible JPEG, then uploads the selected product views to `rukter.ai`. The primary image is sent to Fireworks as an inline data URL and the remaining public view URLs are supplied in the same multimodal request. Fireworks Vision returns `productAnalysis`, visible evidence, storefront copy, and SEO. Product Story jobs also expose a sanitized AI trace with the actual model ID, observations, seller verification items, and the generated video prompts. The UI never labels a run as Gemma unless the model that answered has a Gemma model ID.

Each isolated WebP is also exposed through a generated `/uploads/*.webp` URL. The MCP draft handoff prefers that clean product asset over the original background photo, so the editable Rukter draft starts from the same visual used by the embedded preview and exported ZIP.

Before the result reaches the storefront, a deterministic claim guard rewrites unsupported numeric claims, social proof, scarcity, health claims, and certifications unless those facts were supplied in the seller notes. The `amdEvidence.claimSafetyRewrites` field records how many generated strings were changed.

If the seller needs to connect Rukter OAuth, the browser stores the current launch kit in session storage before redirecting. When OAuth returns with `?mcp=connected`, the app restores the launch kit and automatically attempts the draft save when a write token is available.

## Docker

Build an AMD64 image for hackathon-compatible deployment:

```bash
docker buildx build --platform linux/amd64 -t rukter-ai:latest .
```

Run:

```bash
docker run --rm -p 3017:3017 \
  -e FIREWORKS_API_KEY="$FIREWORKS_API_KEY" \
  -e FIREWORKS_BASE_URL="https://api.fireworks.ai/inference/v1" \
  -e FIREWORKS_MODEL="accounts/fireworks/models/deepseek-v4-flash" \
  -e RUKTER_MCP_URL="https://rukter.com/mcp" \
  -e RUKTER_AI_PUBLIC_URL="https://rukter.ai" \
  rukter-ai:latest
```

The public submission image is published by GitHub Actions:

```text
ghcr.io/theerapong/rukter-ai:latest
```

The image workflow always publishes a `linux/amd64` manifest. GitHub Container Registry creates a new package as private, so its visibility must be changed to **Public** once after the first push; anonymous pull must then be verified before submission.

## Hackathon Runtime Contract

- server ready in under 60 seconds
- every launch-kit response completes in under 30 seconds
- generated strings are English, including when the source brief uses another script
- distinct unseen inputs must produce distinct output
- only successful Fireworks calls are presented as AMD compute evidence
- submission image includes a `linux/amd64` manifest and is anonymously pullable

Run the local contract check with:

```bash
npm run hackathon:contract
```

## DigitalOcean / AMD Developer Cloud

The repo includes Terraform at `infra/terraform/environments/digitalocean` for the current DigitalOcean App Platform deployment. GitLab CI builds a `linux/amd64` image, plans the service, and deploys it through the manual apply job. Cloudflare routes `https://rukter.ai` to this service.

## API

`POST /api/story-jobs`

Starts an asynchronous Product Story job from three to eight uploaded image URLs. `GET /api/story-jobs/:id` returns the eight-step activity log, model provenance, image observations, directed Wan prompts, GPU lease state, billing state, identity policy, and output. `POST /api/story-jobs/:id/cancel` cancels work. `POST /api/story-jobs/:id/release-gpu` explicitly destroys an active lease.

The browser polls this job API, so a cinematic generation can take longer than the synchronous request limit without hiding progress or timing out the page. Job creation and status responses remain well under 30 seconds.

The production service contains the lease controller described in `infra/amd-gpu-orchestrator/README.md`. Configure its scoped DigitalOcean token and worker token before enabling AMD Cinematic:

```bash
export AMD_GPU_ORCHESTRATOR_URL="http://127.0.0.1:3017"
export AMD_GPU_ORCHESTRATOR_TOKEN="..."
export AMD_GPU_DIGITALOCEAN_TOKEN="..."
export AMD_GPU_REGION="atl1"
export AMD_GPU_SIZE="gpu-mi300x1-192gb-devcloud"
export AMD_GPU_IMAGE="amddevelopercloud-pytorch2100rocm724"
export AMD_GPU_VPC_UUID="<region-matched-vpc-uuid>"
export AMD_GPU_PUBLIC_ENABLED="true"
```

Keep `AMD_GPU_PUBLIC_ENABLED=false` until one complete create, render, identity-check, and destroy cycle has been observed.

The current AMD worker runs Wan2.2 TI2V 5B directly through Diffusers on ROCm. This is text-guided image-to-video: each Fireworks-directed prompt is conditioned on a real product view, then sampled frames are checked with CLIP similarity and OCR retention. AMD also documents an equivalent headless ComfyUI HTTP workflow for Wan2.2 5B on MI300X. That service-oriented ComfyUI path is compatible with this job contract, but the UI reports `Diffusers` until the worker backend is actually switched and verified; it does not claim ComfyUI based only on documentation.

`POST /api/launch-kit`

```json
{
  "brief": "",
  "channel": "TikTok Shop",
  "market": "Thailand and Southeast Asia",
  "productImage": {
    "name": "serum.jpg",
    "type": "image/jpeg",
    "size": 281392,
    "url": "https://rukter.ai/uploads/example.jpg"
  },
  "sourceImages": [
    { "id": "front", "label": "Front", "url": "https://rukter.ai/uploads/front.jpg" },
    { "id": "back", "label": "Back", "url": "https://rukter.ai/uploads/back.jpg" }
  ]
}
```

The API returns:

- `kit`: generated product analysis and launch kit
- `productAssets`: up to four transparent WebP product images derived from Fireworks bounding boxes and edge-connected alpha matting
- `productTwin`: truthful mode, source views, preview/model references, reconstruction evidence, and visual evidence
- `exportManifest`: the portable viewer/JSON/image/runtime file list
- `draftPayload`: draft-safe payload for Rukter
- `amdEvidence`: model, provider, timing budget, architecture, and verified Fireworks/AMD usage metadata
- `mode`: `fireworks_inference` or `demo_fallback`

`POST /api/export`

Accepts `exportKind: "product-twin"`, `kit`, `productAssets`, and `productTwin`. It returns a static portable Product Twin ZIP with its own Three.js viewer and evidence manifest. It does not emit a fake `.glb`; a model URL is included only after verified AMD reconstruction.

`POST /api/rukter-draft`

Accepts the launch-kit API response fields and calls `https://rukter.com/mcp`:

```json
{
  "input": { "brief": "Seller brief", "channel": "DTC", "market": "Global" },
  "kit": { "...": "generated launch kit" },
  "draftPayload": { "...": "draft-safe payload" }
}
```

The endpoint calls MCP tool `create_home_page_draft`, keeps `draftOnly` semantics, and returns the dashboard URL for manual review.

The MCP arguments include:

- `qualityMode: "awwwards"`
- `requiredCapabilities: ["image", "commerce", "media_slots", "freeform", "motion"]`
- `creativePage.schema: "rukter.freeform_creative_page.v4"`
- a sandboxed document with editable text selectors and media slots

## Rukter Integration Contract

This app does not publish anything automatically. It prepares a draft payload that can be passed into Rukter's existing draft workflow. The publish step remains a separate seller-controlled action inside the Rukter dashboard.

That is the core product principle:

```text
AI creates the draft. The seller reviews and publishes.
```

## Hackathon Submission Assets

See [SUBMISSION.md](./SUBMISSION.md) for the title, short description, long description, slide outline, and demo script.
