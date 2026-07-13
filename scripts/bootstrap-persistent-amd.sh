#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "${script_dir}/assert-production-targets.sh"

: "${AMD_GPU_DIGITALOCEAN_TOKEN:?AMD_GPU_DIGITALOCEAN_TOKEN is required}"
: "${AMD_GPU_ORCHESTRATOR_TOKEN:?AMD_GPU_ORCHESTRATOR_TOKEN is required}"

persistent_tag="${AMD_GPU_PERSISTENT_TAG:-rukter-product-story-persistent}"
public_url="${RUKTER_AI_PUBLIC_URL:-https://rukter.ai}"
source_base="${AMD_GPU_WORKER_SOURCE_BASE_URL:-${public_url%/}/amd-worker}"
worker_version="${CI_COMMIT_SHA:-manual}"
ssh_key="${AMD_GPU_SSH_PRIVATE_KEY_PATH:-${HOME}/.ssh/rukter_ai_amd_gpu_ed25519}"
region="${AMD_GPU_REGION:-atl1}"
size="${AMD_GPU_SIZE:-gpu-mi300x1-192gb-devcloud}"
image="${AMD_GPU_IMAGE:-amddevelopercloud-pytorch2100rocm724}"
vpc_uuid="${AMD_GPU_VPC_UUID:-}"
ssh_key_fingerprint="${AMD_GPU_SSH_KEY_FINGERPRINT:-}"
ssh_key_name="${AMD_GPU_SSH_KEY_NAME:-}"
api_url="https://api.digitalocean.com/v2"

if [[ ! -r "${ssh_key}" ]]; then
  echo "Persistent AMD SSH key is not readable: ${ssh_key}" >&2
  exit 1
fi

do_api() {
  local path="$1"
  local method="${2:-GET}"
  local body="${3:-}"
  local header_file curl_status
  header_file="$(mktemp "${TMPDIR:-/tmp}/rukter-do-headers.XXXXXX")"
  chmod 600 "${header_file}"
  {
    printf 'Accept: application/json\n'
    printf 'Authorization: Bearer %s\n' "${AMD_GPU_DIGITALOCEAN_TOKEN}"
    if [[ -n "${body}" ]]; then
      printf 'Content-Type: application/json\n'
    fi
  } > "${header_file}"
  local args=(
    -fsS
    --header "@${header_file}"
  )
  if [[ "${method}" != "GET" ]]; then
    args+=(-X "${method}")
  fi
  if [[ -n "${body}" ]]; then
    if printf '%s' "${body}" | curl "${args[@]}" --data-binary @- "${api_url}${path}"; then
      curl_status=0
    else
      curl_status=$?
    fi
  elif curl "${args[@]}" "${api_url}${path}"; then
    curl_status=0
  else
    curl_status=$?
  fi
  rm -f "${header_file}"
  return "${curl_status}"
}

resolve_ssh_key_ref() {
  if [[ -n "${ssh_key_fingerprint}" ]]; then
    printf '%s\n' "${ssh_key_fingerprint}"
    return
  fi
  if [[ -z "${ssh_key_name}" ]]; then
    echo "Set AMD_GPU_SSH_KEY_FINGERPRINT or AMD_GPU_SSH_KEY_NAME so the persistent AMD Droplet can be recreated." >&2
    exit 1
  fi
  local keys key_ref
  keys="$(do_api "/account/keys?per_page=200")"
  key_ref="$(jq -r --arg name "${ssh_key_name}" '.ssh_keys[]? | select(.name == $name) | (.fingerprint // (.id | tostring))' <<<"${keys}" | head -n 1)"
  if [[ -z "${key_ref}" || "${key_ref}" == "null" ]]; then
    echo "The configured AMD GPU SSH key name was not found in DigitalOcean: ${ssh_key_name}" >&2
    exit 1
  fi
  printf '%s\n' "${key_ref}"
}

create_persistent_droplet() {
  local ssh_key_ref payload
  ssh_key_ref="$(resolve_ssh_key_ref)"
  payload="$(jq -n \
    --arg name "rukter-product-story-persistent" \
    --arg region "${region}" \
    --arg size "${size}" \
    --arg image "${image}" \
    --arg tag "${persistent_tag}" \
    --arg ssh_key_ref "${ssh_key_ref}" \
    --arg vpc_uuid "${vpc_uuid}" \
    '{
      name: $name,
      region: $region,
      size: $size,
      image: $image,
      ssh_keys: [$ssh_key_ref],
      backups: false,
      ipv6: false,
      monitoring: true,
      tags: [$tag]
    } + (if $vpc_uuid == "" then {} else {vpc_uuid: $vpc_uuid} end)')"
  echo "No persistent AMD Droplet is active; creating ${size} in ${region} with tag ${persistent_tag}."
  do_api "/droplets" "POST" "${payload}" >/dev/null
}

droplet_id=""
droplet_ip=""
created_persistent="0"
for _ in $(seq 1 90); do
  droplets="$(do_api "/droplets?tag_name=${persistent_tag}&per_page=200")"
  count="$(jq '[.droplets[]?] | length' <<<"${droplets}")"
  if [[ "${count}" -eq 0 ]]; then
    if [[ "${created_persistent}" == "0" ]]; then
      create_persistent_droplet
      created_persistent="1"
    fi
    sleep 10
    continue
  fi
  if [[ "${count}" -gt 1 ]]; then
    echo "Expected exactly one persistent AMD Droplet tagged ${persistent_tag}; found ${count}. Refusing to keep duplicate always-on GPUs." >&2
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

assert_remote_worker_idle_for_update() {
  ssh "${ssh_options[@]}" "root@${droplet_ip}" bash -s <<'REMOTE_CHECK'
set -euo pipefail

if command -v docker >/dev/null 2>&1 \
  && docker top rukter-amd-worker -eo pid,args 2>/dev/null \
    | grep -Eq '[r]un_story_pipeline\.(sh|py)'; then
  echo "Refusing to bootstrap the persistent AMD worker: a Product Story pipeline process is still running." >&2
  exit 1
fi

health="$(curl -fsS --connect-timeout 3 --max-time 25 http://127.0.0.1:8080/health 2>/dev/null || true)"
if [[ -n "${health}" ]]; then
  if grep -Eq '"activeJobPresent"[[:space:]]*:[[:space:]]*true|"pipelineProcessPresent"[[:space:]]*:[[:space:]]*true' <<<"${health}"; then
    echo "Refusing to bootstrap the persistent AMD worker: /health reports an active job or pipeline process." >&2
    exit 1
  fi
  if grep -Eq '"activeJobPresent"[[:space:]]*:[[:space:]]*false' <<<"${health}" \
    && grep -Eq '"pipelineProcessPresent"[[:space:]]*:[[:space:]]*false' <<<"${health}"; then
    exit 0
  fi
  if grep -Eq '"acceptingJobs"[[:space:]]*:[[:space:]]*true' <<<"${health}"; then
    exit 0
  fi
  echo "Refusing to bootstrap the persistent AMD worker: its activity state could not be proven idle." >&2
  exit 1
fi

if systemctl is-active --quiet rukter-amd-worker.service 2>/dev/null \
  || [[ "$(docker inspect -f '{{.State.Running}}' rukter-amd-worker 2>/dev/null || true)" == "true" ]]; then
  echo "Refusing to bootstrap the persistent AMD worker: the running worker did not return a verifiable /health state." >&2
  exit 1
fi
REMOTE_CHECK
}

# Do not even replace the persistent worker environment while a user render is
# active. The downloaded worker bootstrap repeats this probe immediately before
# its guarded service restart.
assert_remote_worker_idle_for_update

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
  printf 'WAN_HUMAN_CONTAMINATION_THRESHOLD=0.225\n'
  printf 'WAN_HUMAN_CONTAMINATION_MARGIN=0.012\n'
  printf 'WAN_HUMAN_CONTAMINATION_SOURCE_DELTA=0.015\n'
  printf 'WAN_COLOR_DISTRIBUTION_THRESHOLD=0.48\n'
  printf 'WAN_EDGE_INTRUSION_THRESHOLD=0.0025\n'
  printf 'WAN_OCR_RETENTION_MIN_TOKENS=2\n'
  printf 'WAN_OCR_LANGUAGES=eng+tha\n'
  printf 'WAN_FPS=16\n'
  printf 'WAN_NUM_FRAMES=81\n'
  printf 'WAN_INFERENCE_STEPS=32\n'
  printf 'WAN_STORY_INFERENCE_STEP_BUDGET_PER_PASS=120\n'
  printf 'WAN_GUIDANCE_SCALE=4.5\n'
  printf 'WAN_IDENTITY_RETRY_GUIDANCE_SCALE=3.5\n'
  printf 'WAN_BACKGROUND_TRIM_TOLERANCE=18\n'
  printf 'WAN_BACKGROUND_TRIM_PADDING_RATIO=0.06\n'
  printf 'STORY_PIPELINE_TIMEOUT_SECONDS=6600\n'
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
  if jq -e --arg version "${worker_version}" '.status == "ok" and .available == true and .acceptingJobs == true and .activeJobPresent == false and .pipelineProcessPresent == false and .workerVersion == $version' <<<"${health}" >/dev/null 2>&1; then
    metrics_status="$(ssh "${ssh_options[@]}" "root@${droplet_ip}" "systemctl is-active do-agent 2>/dev/null || true")"
    if [[ "${metrics_status}" != "active" ]]; then
      ssh "${ssh_options[@]}" "root@${droplet_ip}" "systemctl status do-agent --no-pager 2>/dev/null || true" >&2
      echo "DigitalOcean metrics agent is not active on persistent AMD Droplet ${droplet_id}; Insights may show No Data." >&2
      exit 1
    fi
    jq '{status,service,workerVersion,available,acceptingJobs,activeJobPresent,pipelineProcessPresent,pipelineProcessPid,device,rocmVersion}' <<<"${health}"
    printf 'DigitalOcean metrics agent is active on persistent AMD Droplet %s.\n' "${droplet_id}"
    printf 'Persistent AMD Droplet %s is ready at %s and will remain online.\n' "${droplet_id}" "${droplet_ip}"
    exit 0
  fi
  sleep 10
done

echo "Persistent AMD worker did not become healthy before the verification timeout." >&2
exit 1
