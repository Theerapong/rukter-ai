# AMD GPU Lease Orchestrator

Rukter.ai's existing App Platform service is the always-on control plane. For public AMD Cinematic jobs, the owner-funded persistent MI300X Droplet is also kept Active and ready so users do not wait for a cold GPU boot. Its protected API contract is:

- `POST /v1/leases`: adopt the always-on persistent `gpu-mi300x1-192gb-devcloud` Droplet, or recreate that persistent Droplet if it is missing.
- `GET /v1/leases/:id`: report Droplet startup, worker bootstrap, ROCm proof, and the ready worker URL.
- `POST /v1/leases/:id/release`: destroy an ephemeral Droplet, or return `retained` for an owner-funded persistent worker.
- Every ephemeral lease has a 50-minute hard TTL. A one-minute reaper destroys expired ephemeral-tagged Droplets even if the web request or worker fails; persistent-tagged workers are excluded.

Required safeguards:

1. `AMD_GPU_PUBLIC_ENABLED=false` by default.
2. One active lease maximum until capacity and budget controls are reviewed.
3. Use `rukter-product-story-ephemeral` only for zero-idle workers. Use the separate `rukter-product-story-persistent` tag for the owner-funded always-on worker and never combine the tags.
4. Destroy ephemeral workers in the release handler and TTL reaper. Persistent-tagged workers are fail-closed against deletion and remain billable until the owner deletes them in AMD Developer Cloud.
5. Return a ready lease only after `rocminfo` and the worker health endpoint identify an AMD device.
6. Keep the scoped `AMD_GPU_DIGITALOCEAN_TOKEN` and `AMD_GPU_ORCHESTRATOR_TOKEN` in protected, masked GitLab CI variables.
7. Keep exactly one persistent-tagged Droplet. CI fails if duplicates exist because duplicate always-on MI300X workers waste credits.

The AMD size and image are configurable because access and regional availability vary:

```text
AMD_GPU_SIZE=gpu-mi300x1-192gb-devcloud
AMD_GPU_IMAGE=amddevelopercloud-pytorch2100rocm724
AMD_GPU_VPC_UUID=<region-matched-vpc-uuid>
AMD_GPU_REGION=atl1
AMD_GPU_LEASE_TTL_SECONDS=3000
AMD_GPU_PERSISTENT_TAG=rukter-product-story-persistent
AMD_GPU_ALWAYS_ON=true
```

Do not enable the public flag until the worker image, region access, output storage, identity checks, budget alert, and TTL reaper have all been verified with one manual lease.
