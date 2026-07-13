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

## Current Live Flow

The production app at `https://rukter.ai` currently opens directly into Product Story Director.

1. Drop or choose 1-8 product photos (`JPG`, `PNG`, `WebP`, or `AVIF`).
2. Pick the story path:
   - `Motion Preview`: source-photo animation composed in the browser. It is fast, has no GPU billing, and is not AMD compute evidence.
   - `AMD Cinematic`: Fireworks plans the Product DNA and directed shots first. The owner reviews the plan, then explicitly approves the AMD render.
3. Choose creative controls: `Cinematic Product Film`, `Social Commerce`, `Luxury Editorial`, or `Technical Demo`; aspect ratio; 8/12/15/20 second length; Fast/Standard/Detail resolution; campaign goal; scene policy; and people policy.
4. Fireworks Vision/Director produces the product evidence, Product DNA, shot plan, and identity locks.
5. For AMD Cinematic, the approved job enters a single-concurrency FIFO queue.
6. The current production AMD path uses an owner-funded persistent MI300X worker tagged `rukter-product-story-persistent`. The worker is retained online between jobs by policy, so credits continue while it is active.
7. Wan 2.2 clips render on ROCm, CLIP/OCR checks verify product identity, and the final accepted result is composed as an MP4.
8. The UI exposes capacity checks, queue state, approval state, worker/GPU state, logs, identity evidence, and export actions.

The header also links to a read-only [GPU Status monitor](https://rukter.ai/gpu-status.html). It polls the persistent MI300X worker every 10 seconds and shows ROCm utilization, VRAM, temperature, power, queue depth, anonymous active sessions, and active GPU jobs. It never starts, stops, releases, or reconfigures the worker.

## AMD Compute Usage

AMD Cinematic is the required compute-evidence path for judging.

- AMD Developer Cloud GPU Droplet with AMD Instinct MI300X VF.
- ROCm worker bootstrapped from this repository.
- Wan 2.2 TI2V 5B generation through Diffusers on ROCm.
- `rocminfo`/worker health checks before accepting jobs.
- GPU telemetry and worker logs exposed in the app during generation.
- FIFO queue keeps render lifecycle predictable.
- Current production uses the always-on persistent tagged worker: `rukter-product-story-persistent`.
- The persistent MI300X Droplet is owner-funded and kept Active/ready between Product Story jobs.
- `POST /api/story-jobs/:id/release-gpu` does not destroy the persistent worker; it records that the worker is retained.
- Ephemeral worker support remains for zero-idle/fallback operation only. Ephemeral workers are destroyed by release/TTL policy, while persistent tagged workers are excluded from deletion.

The app is intentionally honest about evidence. Motion Preview is useful for fast previews, but it is never labeled as AMD Cinematic output.

## Demo Checklist

For a Track 3 demo, show these pieces:

- `https://rukter.ai` accepting a new, unseen product photo set.
- `Check AMD capacity` returning a persistent MI300X worker with `retain_after_job` policy.
- Fireworks vision evidence and directed prompts.
- AMD Cinematic selected, not Motion Preview.
- Owner review of Product DNA and directed shots before approving the AMD render.
- Worker status showing MI300X/ROCm readiness and persistent billing state.
- Live progress, GPU telemetry, and console logs while clips generate.
- CLIP/OCR identity check results before the final MP4.
- GitLab CI proving a public `linux/amd64` container image.

If `notebooks.amd.com/hackathon` is used for extra AMD evidence, shut it down after capture. The notebook is not required to keep the app running.

## Run Locally

Requires Node.js 20 or newer.

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
export RUKTER_AI_PUBLIC_URL="https://your-public-app.example"
export AMD_GPU_REGION="atl1"
export AMD_GPU_SIZE="gpu-mi300x1-192gb-devcloud"
export AMD_GPU_IMAGE="amddevelopercloud-pytorch2100rocm724"
export AMD_GPU_SSH_KEY_FINGERPRINT="..."
# or: export AMD_GPU_SSH_KEY_NAME="rukter-ai-amd-gpu-ci-20260712"
export AMD_GPU_WORKER_SOURCE_BASE_URL="https://your-public-app.example/amd-worker"
export AMD_GPU_PERSISTENT_TAG="rukter-product-story-persistent"
export AMD_GPU_ALWAYS_ON="true"
npm start
```

The AMD worker must be reachable from the public internet because it downloads source images from the app and uploads MP4 output back to `/api/amd-story-assets`. Local-only AMD Cinematic is useful for control-plane testing, but a real render needs a public app URL, a scoped DigitalOcean/AMD Developer Cloud token, a registered SSH key, and the protected worker/orchestrator bearer token.

Production CI pins `AMD_GPU_WORKER_SOURCE_BASE_URL=https://rukter.ai/amd-worker` so the persistent worker executes only code served by this deployment, and pins `AMD_GPU_ORCHESTRATOR_URL=http://127.0.0.1:3017` to the in-process control plane. Production mode refuses either override; alternate URLs remain available only for explicit non-production development.

To bootstrap or refresh the persistent production worker from CI or an operator machine:

```bash
export AMD_GPU_DIGITALOCEAN_TOKEN="..."
export AMD_GPU_ORCHESTRATOR_TOKEN="..."
export AMD_GPU_SSH_PRIVATE_KEY_PATH="$HOME/.ssh/rukter_ai_amd_gpu_ed25519"
export AMD_GPU_SSH_KEY_FINGERPRINT="..."
bash scripts/bootstrap-persistent-amd.sh
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
- `terraform:apply:digitalocean`: waits for zero visible user sessions, admitted requests, queued jobs, and AMD worker processes; holds an auto-expiring Cloudflare admission gate through App Platform apply, persistent AMD bootstrap, and final health/config/queue verification; then releases the edge gate before the durable app fence.
- `bootstrap:amd-persistent`: creates the persistent AMD Droplet if missing, bootstraps it, and verifies that the worker remains ready.
- `verify:public-image`: anonymously pulls `ghcr.io/theerapong/rukter-ai:latest` as `linux/amd64`.

The one-time migration from a release that predates visible-session tracking is deliberately manual: close active `rukter.ai` tabs, then run that exact commit with `DEPLOYMENT_DRAIN_BOOTSTRAP_APPROVED_SHA=<CI_COMMIT_SHA>`. This exact-SHA value is a manual owner attestation, not complete technical proof of zero users: the legacy app has no presence heartbeat, and DigitalOcean App Platform's default origin ingress is not mutated by this bridge. The Cloudflare gate, continuous queue checks, and read-only worker probes reduce the migration risk, but the first rollout must not be described as proving zero-user state. Later releases derive no-user readiness from the live presence heartbeat and do not use this override.

## Code Map

- `server.mjs` - main Node HTTP server, API routes, Fireworks calls, Product Story job lifecycle, AMD queue/orchestrator integration, Rukter MCP/OAuth handoff, upload/export handling.
- `public/index.html`, `public/app.js`, `public/styles.css` - Product Story Director UI shown at `https://rukter.ai`.
- `lib/product-story.mjs` - Product Story schema, limits, activity model, shot planning normalization, and Motion Preview output model.
- `lib/digitalocean-gpu-orchestrator.mjs` - AMD Developer Cloud/DigitalOcean persistent and ephemeral worker orchestration.
- `lib/amd-story-orchestrator.mjs` - server-to-worker Product Story render API client.
- `amd-worker/app.py` - FastAPI worker that accepts protected render jobs and exposes worker health/status.
- `amd-worker/run_story_pipeline.py` - ROCm Wan 2.2 render pipeline, CLIP/OCR identity checks, and MP4 composition.
- `scripts/bootstrap-persistent-amd.sh` - operator/CI bootstrap for the persistent MI300X worker.
- `infra/terraform/environments/digitalocean` - production App Platform deployment.

## External Services

- Fireworks AI: product vision, Product DNA, directed-shot planning, and optional visual critique. Configure with `FIREWORKS_API_KEY`, `FIREWORKS_BASE_URL`, `FIREWORKS_MODEL`, `FIREWORKS_MODEL_FALLBACKS`, `FIREWORKS_VISION_MODEL`, and `FIREWORKS_VISION_MODEL_FALLBACKS`.
- AMD Developer Cloud on DigitalOcean Droplets: MI300X ROCm worker used by AMD Cinematic. Configure with `AMD_GPU_DIGITALOCEAN_TOKEN`, `AMD_GPU_ORCHESTRATOR_TOKEN`, `AMD_GPU_REGION`, `AMD_GPU_SIZE`, `AMD_GPU_IMAGE`, `AMD_GPU_VPC_UUID`, `AMD_GPU_SSH_KEY_FINGERPRINT` or `AMD_GPU_SSH_KEY_NAME`, `AMD_GPU_PERSISTENT_TAG`, and `AMD_GPU_ALWAYS_ON`.
- DigitalOcean App Platform and Container Registry: production hosting for `https://rukter.ai` and deploy image storage. Managed through GitLab CI and `infra/terraform/environments/digitalocean`.
- Cloudflare WAF: an external, TTL-bound production admission gate that prevents new browser/API work from racing an App Platform deployment. Configure the protected, masked `RUKTER_AI_CLOUDFLARE_API_TOKEN` with Zone Read and Zone WAF Edit access restricted to the `rukter.ai` zone and GitLab environment scope `production/rukter-ai`. The gate stays active through persistent AMD bootstrap and final live verification. Its narrow continuity exceptions are GET/HEAD for one-segment UUID-shaped `/uploads` image/video asset paths, GET/HEAD for the seven exact `/amd-worker` bootstrap source files, protected `POST /api/amd-story-assets`, and cookie-protected `POST /api/story-presence`; raw and normalized paths must agree so traversal and encoded separators remain blocked. CI releases Cloudflare first and the durable app fence second only after all verification passes.
- GitLab CI: smoke tests, Docker `linux/amd64` build, DigitalOcean deploy, persistent worker bootstrap, and public-image verification. Production apply requires the dedicated `rukter-ai-production` runner tag on a protected runner restricted to protected refs. Merge-request and branch validation must use a separate unprotected validation runner and must never share the production runner's OS user or process namespace.
- Rukter MCP/OAuth: optional draft handoff from the generated launch kit to an editable Rukter dashboard draft. Configure with `RUKTER_MCP_ACCESS_TOKEN` or OAuth variables (`RUKTER_MCP_URL`, `RUKTER_MCP_CLIENT_ID`, `RUKTER_MCP_RESOURCE`, `RUKTER_OAUTH_AUTHORIZE_URL`, `RUKTER_OAUTH_TOKEN_URL`) plus `RUKTER_DASHBOARD_URL`.
- GHCR public image: `ghcr.io/theerapong/rukter-ai:latest` for anonymous `linux/amd64` pull verification.
- Optional Product Twin AMD worker: `AMD_3D_WORKER_URL` and `AMD_3D_WORKER_TOKEN`; current production can run truthful Product Twin previews without this worker.

## API Surface

- `GET /health` - readiness check.
- `GET /api/config` - runtime configuration and anonymous HttpOnly Product Story session.
- `GET /api/gpu-capacity?refresh=1` - AMD worker and capacity status.
- `GET /api/gpu-status` - sanitized live worker telemetry, queue, lifecycle, and anonymous usage counts for the GPU Status page.
- `GET /metrics` - read-only Prometheus gauges for a protected Grafana/Prometheus deployment.
- `GET /api/story-queue` - FIFO queue snapshot.
- `POST /api/product-image` - validate and store a session-owned source image.
- `POST /api/story-jobs` - run Fireworks Product DNA and directed-shot planning; AMD is not queued yet.
- `GET /api/story-jobs/:id` - poll job progress, logs, GPU state, and output.
- `POST /api/story-jobs/:id/approve` - approve the current plan and enter the AMD render queue.
- `POST /api/story-jobs/:id/cancel` - cancel a waiting or active job.
- `POST /api/story-jobs/:id/release-gpu` - legacy lifecycle endpoint; the persistent worker is retained and is never auto-shutdown.
- `POST /api/launch-kit` - legacy launch-kit generation endpoint.
- `POST /api/design-critique` - Fireworks visual critique for generated first-viewport previews.
- `POST /api/rukter-draft` - optional Rukter MCP handoff that creates an editable dashboard draft.
- `POST /api/export` - export generated assets.
- `GET /oauth/start` and `GET /oauth/callback` - OAuth connection flow for Rukter MCP access.
- `POST /api/amd-story-assets` - protected AMD worker MP4 upload endpoint.
- `POST /v1/leases`, `GET /v1/leases/:id`, `POST /v1/leases/:id/release` - protected AMD GPU lease-control endpoints used by the server/worker path.

## Product Twin

`/product-twin.html` is a related secondary tool. It creates an interactive Product Twin preview from product photos or an orbit video. It is useful for commerce asset exploration, but the main Track 3 compute proof is Product Story Director's AMD Cinematic flow.

## Security Boundary

This public repository contains only the standalone `rukter.ai` app, deployment definitions, and AMD worker bootstrap files. Product Story jobs are owner-scoped to an anonymous HttpOnly session, source URLs must reference validated same-origin uploads, and session/network/global limits bound Fireworks planning, uploads, and active work. Uploaded images are decoded under byte/pixel/dimension limits and removed after the configured retention window. Do not commit API keys, cloud tokens, SSH private keys, Terraform state, or `.env` files. Production credentials belong in protected GitLab CI/CD variables and runtime secrets.
