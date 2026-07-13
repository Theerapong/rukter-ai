# Rukter.ai Launch Agent DigitalOcean Deploy

This Terraform environment creates the Rukter.ai Launch Agent deployment on DigitalOcean App Platform for the AMD Developer Cloud cutover path.

GitLab CI builds the root `Dockerfile` as a `linux/amd64` image, pushes it to DigitalOcean Container Registry, and passes the exact image tag into Terraform.

Terraform state and locking use the private GitLab-managed HTTP backend. The first plan imports the existing `rukter-ai-launch-agent` App Platform app when that state is empty, preventing a duplicate production app during the backend migration.

## Secrets

CI reads these masked GitLab CI/CD variables:

- `DIGITALOCEAN_TOKEN`: required by the DigitalOcean Terraform provider.
- `FIREWORKS_API_KEY`: optional; mounted into App Platform as a secret runtime env var.
- `RUKTER_MCP_ACCESS_TOKEN`: optional; mounted into App Platform as a secret runtime env var.
- `AMD_GPU_DIGITALOCEAN_TOKEN`: scoped token used by the Rukter.ai control plane to inspect, create, retain, and destroy AMD Developer Cloud Droplets.
- `AMD_GPU_ORCHESTRATOR_TOKEN`: bearer token shared by the control plane and AMD worker for protected lease control and MP4 uploads.
- `AMD_GPU_SSH_KEY_FINGERPRINT` or `AMD_GPU_SSH_KEY_NAME`: registered DigitalOcean SSH key used when the persistent MI300X worker must be recreated.
- `AMD_GPU_SSH_PRIVATE_KEY_PATH`: runner/operator path to the private key used by `bootstrap:amd-persistent`; do not store the key in the repo.
- `AMD_3D_WORKER_TOKEN`: optional bearer token for the separate Product Twin reconstruction worker when `AMD_3D_WORKER_URL` is configured.

DigitalOcean App Platform secret environment values are managed inside the app spec. Supply every secret through protected, masked GitLab CI/CD variables and never commit runtime values.

## Runtime Environment

The production app is deployed with these plain environment values from GitLab CI/Terraform:

- `AMD_GPU_PUBLIC_ENABLED`: enables or disables public AMD Cinematic approval and queueing.
- `AMD_GPU_ALWAYS_ON`: current production is `true`; the owner-funded persistent MI300X worker remains online between jobs and credits continue while active.
- `AMD_GPU_REGION`, `AMD_GPU_SIZE`, `AMD_GPU_IMAGE`, `AMD_GPU_VPC_UUID`: AMD Developer Cloud placement and image settings.
- `AMD_GPU_PERSISTENT_TAG`: persistent worker tag, currently `rukter-product-story-persistent`.
- `AMD_GPU_WORKER_SOURCE_BASE_URL`: public `/amd-worker` source used by cloud-init/bootstrap.
- `AMD_GPU_QUEUE_MAX_SIZE`, `AMD_GPU_CAPACITY_POLL_MS`, `AMD_GPU_LEASE_TTL_SECONDS`: queue, capacity, and ephemeral-lease controls. The TTL applies to ephemeral fallback workers, not the persistent worker.
- `AMD_GPU_CAPACITY_STATE` and `AMD_GPU_AVAILABILITY_REASON`: public UI status copy used before a live capacity check refreshes the state.
- `RUKTER_MCP_ACCESS_TOKEN`, `RUKTER_MCP_URL`, OAuth URLs, and `RUKTER_DASHBOARD_URL`: optional Rukter draft handoff configuration.

## Cost Control

The default service size is `basic-xxs` with one instance. GitLab CI creates a Terraform plan automatically on `main`, but the apply job is manual.

The CI job creates or reuses a DigitalOcean Container Registry before pushing the image. The default registry tier is `starter`.

AMD Cinematic cost is controlled by keeping exactly one persistent tagged MI300X worker online for the current demo path. CI/operator bootstrap refuses duplicate persistent-tagged Droplets. Ephemeral fallback workers are destroyed by release handling or TTL reaping.

## Outputs

After apply, Terraform returns:

- `app_id`
- `app_live_url`
- `app_default_ingress`
