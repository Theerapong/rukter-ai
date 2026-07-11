# Rukter.ai Launch Agent DigitalOcean Deploy

This Terraform environment creates the Rukter.ai Launch Agent deployment on DigitalOcean App Platform for the AMD Developer Cloud cutover path.

GitLab CI builds the root `Dockerfile` as a `linux/amd64` image, pushes it to DigitalOcean Container Registry, and passes the exact image tag into Terraform.

Terraform state and locking use the private GitLab-managed HTTP backend. The first plan imports the existing `rukter-ai-launch-agent` App Platform app when that state is empty, preventing a duplicate production app during the backend migration.

## Secrets

CI reads these masked GitLab CI/CD variables:

- `DIGITALOCEAN_TOKEN`: required by the DigitalOcean Terraform provider.
- `FIREWORKS_API_KEY`: optional; mounted into App Platform as a secret runtime env var.
- `RUKTER_MCP_ACCESS_TOKEN`: optional; mounted into App Platform as a secret runtime env var.

DigitalOcean App Platform secret environment values are managed inside the app spec. Supply every secret through protected, masked GitLab CI/CD variables and never commit runtime values.

## Cost Control

The default service size is `basic-xxs` with one instance. GitLab CI creates a Terraform plan automatically on `main`, but the apply job is manual.

The CI job creates or reuses a DigitalOcean Container Registry before pushing the image. The default registry tier is `starter`.

## Outputs

After apply, Terraform returns:

- `app_id`
- `app_live_url`
- `app_default_ingress`
