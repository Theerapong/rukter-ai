# Rukter.ai Product Story Director

Rukter.ai turns real product photos into short, identity-safe video ads. A seller uploads 1-8 product views, Fireworks AI reads the product evidence and writes a story plan, and the AMD Cinematic path renders the video on an AMD MI300X ROCm worker with product-identity checks before export.

- Live app: [rukter.ai](https://rukter.ai)
- Public source: [github.com/Theerapong/rukter-ai](https://github.com/Theerapong/rukter-ai)
- Public container: `ghcr.io/theerapong/rukter-ai:latest`
- Hackathon track: Track 3 - Unicorn (Open Innovation)

## What It Does

1. Upload 1-8 product photos.
2. Fireworks AI identifies the product and visible evidence.
3. Rukter directs a product story with source-grounded prompts.
4. Choose an output mode:
   - `Motion Preview`: browser-composited preview, no GPU billing, not AMD compute evidence.
   - `AMD Cinematic`: Wan 2.2 image-to-video clips on AMD ROCm, then final MP4 composition.
5. CLIP and OCR identity checks reject generated clips that change the product, logo, or packaging evidence.
6. The UI shows live job status, GPU state, queue state, worker logs, identity checks, and export actions.

## AMD Compute Usage

AMD Cinematic is the required compute-evidence path for judging.

- AMD Developer Cloud GPU Droplet with AMD Instinct MI300X VF.
- ROCm worker bootstrapped from this repository.
- Wan 2.2 TI2V 5B generation through Diffusers on ROCm.
- `rocminfo`/worker health checks before accepting jobs.
- GPU telemetry and worker logs exposed in the app during generation.
- FIFO queue keeps render lifecycle predictable.
- Always-on persistent tagged worker support: `rukter-product-story-persistent`.
- The persistent MI300X Droplet is owner-funded and kept Active/ready between Product Story jobs.
- Ephemeral workers are still destroyed after a job; persistent tagged workers are retained by policy.

The app is intentionally honest about evidence. Motion Preview is useful for fast previews, but it is never labeled as AMD Cinematic output.

## Demo Checklist

For a Track 3 demo, show these pieces:

- `https://rukter.ai` accepting a new, unseen product photo set.
- Fireworks vision evidence and directed prompts.
- AMD Cinematic selected, not Motion Preview.
- Worker status showing MI300X/ROCm readiness.
- Live progress, GPU telemetry, and console logs while clips generate.
- CLIP/OCR identity check results before the final MP4.
- GitLab CI proving a public `linux/amd64` container image.

If `notebooks.amd.com/hackathon` is used for extra AMD evidence, shut it down after capture. The notebook is not required to keep the app running.

## Run Locally

```bash
npm ci
npm start
```

Open:

```text
http://localhost:3017
```

The app starts in deterministic demo mode without secrets. To use real Fireworks inference:

```bash
export FIREWORKS_API_KEY="..."
export FIREWORKS_BASE_URL="https://api.fireworks.ai/inference/v1"
export FIREWORKS_MODEL="accounts/fireworks/models/deepseek-v4-flash"
export FIREWORKS_VISION_MODEL="accounts/fireworks/models/kimi-k2p6"
npm start
```

To enable AMD Cinematic:

```bash
export AMD_GPU_PUBLIC_ENABLED="true"
export AMD_GPU_ORCHESTRATOR_TOKEN="..."
export AMD_GPU_DIGITALOCEAN_TOKEN="..."
export AMD_GPU_REGION="atl1"
export AMD_GPU_SIZE="gpu-mi300x1-192gb-devcloud"
export AMD_GPU_IMAGE="amddevelopercloud-pytorch2100rocm724"
export AMD_GPU_PERSISTENT_TAG="rukter-product-story-persistent"
export AMD_GPU_ALWAYS_ON="true"
npm start
```

Useful checks:

```bash
npm test
npm run smoke
curl -fsS http://localhost:3017/health
curl -fsS "http://localhost:3017/api/gpu-capacity?refresh=1"
```

## Container

The judging VM pulls `linux/amd64`, so builds must publish an amd64 manifest:

```bash
docker buildx build --platform linux/amd64 -t rukter-ai:latest .
docker run --rm -p 3017:3017 rukter-ai:latest
```

Anonymous public image check:

```bash
docker pull --platform linux/amd64 ghcr.io/theerapong/rukter-ai:latest
docker image inspect ghcr.io/theerapong/rukter-ai:latest --format '{{.Architecture}}/{{.Os}}'
```

Expected result:

```text
amd64/linux
```

## CI And Deployment

GitLab CI runs the submission gates:

- `node:smoke`: syntax checks, Python worker checks, shell checks, tests, health readiness, and smoke test.
- `docker:amd64-build`: builds and verifies a `linux/amd64` image.
- `build:docr:digitalocean`: pushes the deploy image.
- `terraform:apply:digitalocean`: deploys to DigitalOcean App Platform with `-auto-approve`.
- `bootstrap:amd-persistent`: creates the persistent AMD Droplet if missing, bootstraps it, and verifies that the worker remains ready.
- `verify:public-image`: anonymously pulls `ghcr.io/theerapong/rukter-ai:latest` as `linux/amd64`.

## API Surface

- `GET /health` - readiness check.
- `GET /api/config` - runtime configuration visible to the UI.
- `GET /api/gpu-capacity?refresh=1` - AMD worker and capacity status.
- `GET /api/story-queue` - FIFO queue snapshot.
- `POST /api/story-jobs` - start an asynchronous Product Story job.
- `GET /api/story-jobs/:id` - poll job progress, logs, GPU state, and output.
- `POST /api/story-jobs/:id/cancel` - cancel a waiting or active job.
- `POST /api/story-jobs/:id/release-gpu` - release an active GPU lease.
- `POST /api/launch-kit` - legacy launch-kit generation endpoint.
- `POST /api/export` - export generated assets.

## Product Twin

`/product-twin.html` is a related secondary tool. It creates an interactive Product Twin preview from product photos or an orbit video. It is useful for commerce asset exploration, but the main Track 3 compute proof is Product Story Director's AMD Cinematic flow.

## Security Boundary

This public repository contains only the standalone `rukter.ai` app, deployment definitions, and AMD worker bootstrap files. Do not commit API keys, cloud tokens, SSH private keys, Terraform state, or `.env` files. Production credentials belong in protected GitLab CI/CD variables and runtime secrets.
