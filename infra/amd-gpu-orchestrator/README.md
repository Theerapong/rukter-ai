# AMD GPU Lease Orchestrator

Rukter.ai's existing App Platform service is the always-on control plane; no second control service or idle GPU is required. Its protected API contract is:

- `POST /v1/leases`: create one `gpu-mi300x1-192gb-devcloud` Droplet from the `gpu-amd-base` image and return a provisioning lease in under 30 seconds.
- `GET /v1/leases/:id`: report Droplet startup, worker bootstrap, ROCm proof, and the ready worker URL.
- `POST /v1/leases/:id/release`: destroy the Droplet. Powering it off is not sufficient to stop billing.
- Every lease has a 50-minute hard TTL. A one-minute reaper destroys expired tagged Droplets even if the web request or worker fails.

Required safeguards:

1. `AMD_GPU_PUBLIC_ENABLED=false` by default.
2. One active lease maximum until capacity and budget controls are reviewed.
3. A DigitalOcean project tag such as `rukter-product-story-ephemeral` on every Droplet.
4. Destroy in the orchestrator release handler and in a scheduled TTL reaper.
5. Return a ready lease only after `rocminfo` and the worker health endpoint identify an AMD device.
6. Keep the scoped `AMD_GPU_DIGITALOCEAN_TOKEN` and `AMD_GPU_ORCHESTRATOR_TOKEN` in protected, masked GitLab CI variables.

The AMD size and image are configurable because access and regional availability vary:

```text
AMD_GPU_SIZE=gpu-mi300x1-192gb-devcloud
AMD_GPU_IMAGE=gpu-amd-base
AMD_GPU_REGION=atl1
AMD_GPU_LEASE_TTL_SECONDS=3000
```

Do not enable the public flag until the worker image, region access, output storage, identity checks, budget alert, and TTL reaper have all been verified with one manual lease.
