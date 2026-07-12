# AMD GPU Lease Orchestrator

Rukter.ai's existing App Platform service is the always-on control plane; no second control service or idle GPU is required. Its protected API contract is:

- `POST /v1/leases`: create one `gpu-mi300x1-192gb-devcloud` Droplet from the AMD Developer Cloud PyTorch ROCm image and return a provisioning lease in under 30 seconds.
- `GET /v1/leases/:id`: report Droplet startup, worker bootstrap, ROCm proof, and the ready worker URL.
- `POST /v1/leases/:id/release`: destroy an ephemeral Droplet, or return `retained` for an owner-funded persistent worker.
- Every ephemeral lease has a 50-minute hard TTL. A one-minute reaper destroys expired ephemeral-tagged Droplets even if the web request or worker fails; persistent-tagged workers are excluded.

Required safeguards:

1. `AMD_GPU_PUBLIC_ENABLED=false` by default.
2. One active lease maximum until capacity and budget controls are reviewed.
3. Use `rukter-product-story-ephemeral` only for zero-idle workers. Use the separate `rukter-product-story-persistent` tag for the owner-funded test worker and never combine the tags.
4. Destroy ephemeral workers in the release handler and TTL reaper. Persistent-tagged workers are fail-closed against deletion and remain billable until the owner deletes them in AMD Developer Cloud.
5. Return a ready lease only after `rocminfo` and the worker health endpoint identify an AMD device.
6. Keep the scoped `AMD_GPU_DIGITALOCEAN_TOKEN` and `AMD_GPU_ORCHESTRATOR_TOKEN` in protected, masked GitLab CI variables.

The AMD size and image are configurable because access and regional availability vary:

```text
AMD_GPU_SIZE=gpu-mi300x1-192gb-devcloud
AMD_GPU_IMAGE=amddevelopercloud-pytorch2100rocm724
AMD_GPU_VPC_UUID=<region-matched-vpc-uuid>
AMD_GPU_REGION=atl1
AMD_GPU_LEASE_TTL_SECONDS=3000
AMD_GPU_PERSISTENT_TAG=rukter-product-story-persistent
```

Do not enable the public flag until the worker image, region access, output storage, identity checks, budget alert, and TTL reaper have all been verified with one manual lease.
