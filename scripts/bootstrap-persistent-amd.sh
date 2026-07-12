#!/usr/bin/env bash
set -euo pipefail

: "${AMD_GPU_DIGITALOCEAN_TOKEN:?AMD_GPU_DIGITALOCEAN_TOKEN is required}"
: "${AMD_GPU_ORCHESTRATOR_TOKEN:?AMD_GPU_ORCHESTRATOR_TOKEN is required}"

persistent_tag="${AMD_GPU_PERSISTENT_TAG:-rukter-product-story-persistent}"
public_url="${RUKTER_AI_PUBLIC_URL:-https://rukter.ai}"
source_base="${AMD_GPU_WORKER_SOURCE_BASE_URL:-${public_url%/}/amd-worker}"
worker_version="${CI_COMMIT_SHA:-manual}"
ssh_key="${AMD_GPU_SSH_PRIVATE_KEY_PATH:-${HOME}/.ssh/rukter_ai_amd_gpu_ed25519}"
api_url="https://api.digitalocean.com/v2"

if [[ ! -r "${ssh_key}" ]]; then
  echo "Persistent AMD SSH key is not readable: ${ssh_key}" >&2
  exit 1
fi

do_api() {
  curl -fsS \
    -H "Accept: application/json" \
    -H "Authorization: Bearer ${AMD_GPU_DIGITALOCEAN_TOKEN}" \
    "${api_url}$1"
}

droplet_id=""
droplet_ip=""
for _ in $(seq 1 60); do
  droplets="$(do_api "/droplets?tag_name=${persistent_tag}&per_page=200")"
  count="$(jq '[.droplets[]?] | length' <<<"${droplets}")"
  if [[ "${count}" -ne 1 ]]; then
    echo "Expected exactly one persistent AMD Droplet tagged ${persistent_tag}; found ${count}." >&2
    exit 1
  fi
  droplet_id="$(jq -r '.droplets[0].id | tostring' <<<"${droplets}")"
  status="$(jq -r '.droplets[0].status // ""' <<<"${droplets}")"
  droplet_ip="$(jq -r '.droplets[0].networks.v4[]? | select(.type == "public") | .ip_address' <<<"${droplets}" | head -n 1)"
  if [[ "${status}" == "active" && -n "${droplet_ip}" ]]; then
    break
  fi
  sleep 10
done

if [[ -z "${droplet_id}" || -z "${droplet_ip}" ]]; then
  echo "Persistent AMD Droplet did not become reachable before the bootstrap timeout." >&2
  exit 1
fi

ssh_options=(
  -i "${ssh_key}"
  -o BatchMode=yes
  -o ConnectTimeout=10
  -o ServerAliveInterval=15
  -o StrictHostKeyChecking=accept-new
)

for _ in $(seq 1 60); do
  if ssh "${ssh_options[@]}" "root@${droplet_ip}" true 2>/dev/null; then
    break
  fi
  sleep 10
done
ssh "${ssh_options[@]}" "root@${droplet_ip}" true

umask 077
environment_file="$(mktemp)"
trap 'rm -f "${environment_file}"' EXIT
{
  printf 'WORKER_TOKEN=%s\n' "${AMD_GPU_ORCHESTRATOR_TOKEN}"
  printf 'OUTPUT_UPLOAD_URL=%s/api/amd-story-assets\n' "${public_url%/}"
  printf 'RUKTER_WORKER_SOURCE_BASE=%s\n' "${source_base%/}"
  printf 'WORKER_VERSION=%s\n' "${worker_version}"
  printf 'STORY_PIPELINE_COMMAND=/opt/rukter/run_story_pipeline.sh\n'
  printf 'MAX_JOB_HISTORY=100\n'
  printf 'RUKTER_OUTPUT_ROOT=/var/lib/rukter-outputs\n'
  printf 'OUTPUT_RETENTION_MAX_JOBS=4\n'
  printf 'OUTPUT_RETENTION_MAX_AGE_SECONDS=21600\n'
  printf 'WAN_MODEL_ID=Wan-AI/Wan2.2-TI2V-5B-Diffusers\n'
  printf 'WAN_IDENTITY_THRESHOLD=0.42\n'
  printf 'WAN_IDENTITY_CLIP_FALLBACK_THRESHOLD=0.90\n'
  printf 'WAN_OCR_RETENTION_MIN_TOKENS=2\n'
  printf 'WAN_FPS=16\n'
  printf 'WAN_NUM_FRAMES=81\n'
  printf 'WAN_INFERENCE_STEPS=16\n'
  printf 'ROCM_WORKER_IMAGE=rocm/pytorch:latest\n'
  printf 'PORT=8080\n'
} >"${environment_file}"

scp "${ssh_options[@]}" "${environment_file}" "root@${droplet_ip}:/tmp/rukter-amd-worker.env"
ssh "${ssh_options[@]}" "root@${droplet_ip}" bash -s -- "${source_base%/}" "${worker_version}" <<'REMOTE'
set -euo pipefail
source_base="$1"
worker_version="$2"
install -m 0600 /tmp/rukter-amd-worker.env /etc/rukter-amd-worker.env
rm -f /tmp/rukter-amd-worker.env
install -d -m 0755 /opt/rukter
curl -fsSL "${source_base}/bootstrap.sh?v=${worker_version}" -o /opt/rukter/bootstrap.sh
chmod 0700 /opt/rukter/bootstrap.sh
/opt/rukter/bootstrap.sh
REMOTE

for _ in $(seq 1 120); do
  health="$(curl -fsS --connect-timeout 5 "http://${droplet_ip}:8080/health" 2>/dev/null || true)"
  if jq -e --arg version "${worker_version}" '.status == "ok" and .available == true and .acceptingJobs == true and .workerVersion == $version' <<<"${health}" >/dev/null 2>&1; then
    jq '{status,service,workerVersion,available,acceptingJobs,device,rocmVersion}' <<<"${health}"
    printf 'Persistent AMD Droplet %s is ready at %s and will remain online.\n' "${droplet_id}" "${droplet_ip}"
    exit 0
  fi
  sleep 10
done

echo "Persistent AMD worker did not become healthy before the verification timeout." >&2
exit 1
