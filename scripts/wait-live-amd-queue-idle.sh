#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "${script_dir}/assert-production-targets.sh"

base_url="${RUKTER_AI_PUBLIC_URL:-https://rukter.ai}"
state_file="${DEPLOYMENT_DRAIN_STATE_FILE:-.ci-artifacts/deployment-drain.env}"
edge_gate_state_file="${DEPLOYMENT_EDGE_GATE_STATE_FILE:-.ci-artifacts/deployment-edge-gate.json}"
edge_gate_required="${DEPLOYMENT_EDGE_GATE_REQUIRED:-false}"
wait_seconds="${DEPLOYMENT_DRAIN_WAIT_SECONDS:-10800}"
poll_seconds="${DEPLOYMENT_DRAIN_POLL_SECONDS:-15}"
stable_seconds="${DEPLOYMENT_DRAIN_STABLE_SECONDS:-30}"
legacy_stable_seconds="${DEPLOYMENT_DRAIN_LEGACY_STABLE_SECONDS:-120}"
renew_seconds="${DEPLOYMENT_DRAIN_RENEW_SECONDS:-300}"
bootstrap_compatibility="${DEPLOYMENT_DRAIN_BOOTSTRAP_COMPATIBILITY:-false}"
legacy_parent_sha="${DEPLOYMENT_DRAIN_LEGACY_PARENT_SHA:-}"
digitalocean_api_url="${DEPLOYMENT_DRAIN_DIGITALOCEAN_API_URL:-${AMD_GPU_DIGITALOCEAN_API_URL:-https://api.digitalocean.com/v2}}"
deployment_digitalocean_token="${DEPLOYMENT_DRAIN_DIGITALOCEAN_TOKEN:-${AMD_GPU_DIGITALOCEAN_TOKEN:-${DIGITALOCEAN_TOKEN:-}}}"
persistent_tag="${AMD_GPU_PERSISTENT_TAG:-rukter-product-story-persistent}"
ssh_key="${AMD_GPU_SSH_PRIVATE_KEY_PATH:-${HOME}/.ssh/rukter_ai_amd_gpu_ed25519}"
deadline=$(( $(date +%s) + wait_seconds ))
stable_since=0
last_renewed_at="$(date +%s)"

read_state_value() {
  local key="$1"
  [[ -r "${state_file}" ]] || return 1
  sed -n "s/^${key}=//p" "${state_file}" | tail -n 1
}

load_edge_gate_header() {
  EDGE_GATE_HEADER_KEY=""
  EDGE_GATE_HEADER_VALUE=""
  if [[ ! -r "${edge_gate_state_file}" ]]; then
    if [[ "${edge_gate_required}" == "true" ]]; then
      echo "Deployment edge gate state is required; refusing an ungated app request." >&2
      return 1
    fi
    return 0
  fi
  EDGE_GATE_HEADER_KEY="$(jq -er '.header_key | select(type == "string" and test("^[A-Za-z0-9-]{1,128}$"))' "${edge_gate_state_file}")" || {
    echo "Deployment edge gate state has an invalid header key; refusing an ungated app request." >&2
    return 1
  }
  EDGE_GATE_HEADER_VALUE="$(jq -er '.header_value | select(type == "string" and test("^[A-Fa-f0-9]{64}$"))' "${edge_gate_state_file}")" || {
    echo "Deployment edge gate state has an invalid header value; refusing an ungated app request." >&2
    return 1
  }
}

request_active_drain_payload() {
  local header_file payload curl_status
  header_file="$(mktemp "${TMPDIR:-/tmp}/rukter-idle-headers.XXXXXX")"
  chmod 600 "${header_file}"
  {
    printf 'Accept: application/json\n'
    printf 'Authorization: Bearer %s\n' "${AMD_GPU_ORCHESTRATOR_TOKEN}"
    if [[ -n "${EDGE_GATE_HEADER_KEY}" ]]; then
      printf '%s: %s\n' "${EDGE_GATE_HEADER_KEY}" "${EDGE_GATE_HEADER_VALUE}"
    fi
  } > "${header_file}"
  if payload="$(curl -fsS --header "@${header_file}" "${base_url%/}/v1/deployment-drain")"; then
    curl_status=0
  else
    curl_status=$?
  fi
  rm -f "${header_file}"
  printf '%s' "${payload:-}"
  return "${curl_status}"
}

request_story_queue_payload() {
  local header_file payload curl_status
  header_file="$(mktemp "${TMPDIR:-/tmp}/rukter-idle-headers.XXXXXX")"
  chmod 600 "${header_file}"
  {
    printf 'Accept: application/json\n'
    if [[ -n "${EDGE_GATE_HEADER_KEY}" ]]; then
      printf '%s: %s\n' "${EDGE_GATE_HEADER_KEY}" "${EDGE_GATE_HEADER_VALUE}"
    fi
  } > "${header_file}"
  if payload="$(curl -fsS --header "@${header_file}" "${base_url%/}/api/story-queue")"; then
    curl_status=0
  else
    curl_status=$?
  fi
  rm -f "${header_file}"
  printf '%s' "${payload:-}"
  return "${curl_status}"
}

is_pinned_legacy_rollout() {
  [[ -n "${legacy_parent_sha}" ]] || return 1
  if [[ "${CI_COMMIT_BEFORE_SHA:-}" == "${legacy_parent_sha}" ]]; then
    return 0
  fi
  local commit_parent=""
  if [[ -n "${CI_COMMIT_SHA:-}" ]] && command -v git >/dev/null 2>&1; then
    commit_parent="$(git rev-list --parents -n 1 "${CI_COMMIT_SHA}" 2>/dev/null | awk '{print $2}')"
  fi
  [[ "${commit_parent}" == "${legacy_parent_sha}" ]]
}

probe_legacy_persistent_worker_idle() {
  local expected_droplet_id droplets encoded_tag droplet_count droplet_id droplet_status droplet_ip
  local remote_health remote_status header_file
  : "${deployment_digitalocean_token:?DIGITALOCEAN_TOKEN is required to verify the legacy persistent worker}"
  [[ -r "${ssh_key}" ]] || {
    echo "Persistent AMD SSH key is not readable for the legacy worker proof: ${ssh_key}" >&2
    return 1
  }
  command -v ssh >/dev/null 2>&1 || {
    echo "ssh is required to verify the legacy persistent worker." >&2
    return 1
  }

  expected_droplet_id="$(read_state_value droplet_id || true)"
  [[ "${expected_droplet_id}" =~ ^[0-9]+$ ]] || {
    echo "Deployment drain state does not identify the persistent Droplet for the legacy worker proof." >&2
    return 1
  }
  encoded_tag="$(jq -rn --arg value "${persistent_tag}" '$value | @uri')"
  header_file="$(mktemp "${TMPDIR:-/tmp}/rukter-do-headers.XXXXXX")"
  chmod 600 "${header_file}"
  {
    printf 'Accept: application/json\n'
    printf 'Authorization: Bearer %s\n' "${deployment_digitalocean_token}"
  } > "${header_file}"
  if ! droplets="$(curl -fsS --header "@${header_file}" \
    "${digitalocean_api_url%/}/droplets?tag_name=${encoded_tag}&per_page=200")"; then
    rm -f "${header_file}"
    echo "Could not inspect the persistent AMD Droplet for the legacy worker proof." >&2
    return 1
  fi
  rm -f "${header_file}"
  droplet_count="$(jq -r '[.droplets[]?] | length' <<<"${droplets}" 2>/dev/null || true)"
  [[ "${droplet_count}" == "1" ]] || {
    echo "Expected exactly one persistent AMD Droplet while verifying the legacy drain; found ${droplet_count:-unverifiable}." >&2
    return 1
  }
  droplet_id="$(jq -r '.droplets[0].id | tostring' <<<"${droplets}" 2>/dev/null || true)"
  droplet_status="$(jq -r '.droplets[0].status // empty' <<<"${droplets}" 2>/dev/null || true)"
  droplet_ip="$(jq -r '[.droplets[0].networks.v4[]? | select(.type == "public") | .ip_address][0] // empty' <<<"${droplets}" 2>/dev/null || true)"
  [[ "${droplet_id}" == "${expected_droplet_id}" ]] || {
    echo "The persistent AMD Droplet changed during the legacy drain; refusing to inspect a different worker." >&2
    return 1
  }
  [[ "${droplet_status}" == "active" && "${droplet_ip}" =~ ^[0-9]+([.][0-9]+){3}$ ]] || {
    echo "The persistent AMD Droplet is not active with a verifiable public IPv4 address." >&2
    return 1
  }

  if remote_health="$(ssh \
    -i "${ssh_key}" \
    -o BatchMode=yes \
    -o ConnectTimeout=10 \
    -o ServerAliveInterval=15 \
    -o StrictHostKeyChecking=accept-new \
    "root@${droplet_ip}" bash -s <<'REMOTE_PROBE'
set -euo pipefail

command -v docker >/dev/null 2>&1 || {
  echo "Docker is unavailable on the persistent AMD worker." >&2
  exit 10
}
processes="$(docker top rukter-amd-worker -eo pid,args 2>/dev/null)" || {
  echo "The persistent AMD worker container process list is unavailable." >&2
  exit 11
}
if grep -Eq '[r]un_story_pipeline\.(sh|py)' <<<"${processes}"; then
  echo "The persistent AMD worker still has a Product Story pipeline process." >&2
  exit 3
fi
health="$(curl -fsS --connect-timeout 3 --max-time 25 http://127.0.0.1:8080/health)" || {
  echo "The persistent AMD worker localhost health endpoint is unavailable." >&2
  exit 12
}
printf '%s' "${health}"
REMOTE_PROBE
  )"; then
    :
  else
    remote_status=$?
    if [[ "${remote_status}" == "3" ]]; then
      return 3
    fi
    echo "The persistent AMD worker could not be verified read-only over SSH (status ${remote_status})." >&2
    return 1
  fi

  if ! jq -e 'type == "object"' <<<"${remote_health}" >/dev/null 2>&1; then
    echo "The persistent AMD worker returned malformed localhost health evidence." >&2
    return 1
  fi
  if jq -e '
    .status == "ok"
    and .available == true
    and .acceptingJobs == true
    and (.activeJobPresent? != true)
    and (.pipelineProcessPresent? != true)
    and (.updatePending? != true)
  ' <<<"${remote_health}" >/dev/null; then
    echo "Legacy worker proof: droplet=${droplet_id} accepting=true pipeline_process=false."
    return 0
  fi
  echo "The persistent AMD worker health is verifiable but not idle; waiting without deploying." >&2
  return 3
}

mode="$(read_state_value mode || true)"
drain_id="$(read_state_value drain_id || true)"
[[ -n "${mode}" && -n "${drain_id}" ]] || {
  echo "Deployment drain state is missing; acquire the admission fence before waiting for idle." >&2
  exit 1
}

echo "Waiting for all admitted work to drain before production deploy: ${base_url} (mode=${mode})"
while true; do
  now="$(date +%s)"
  load_edge_gate_header
  if [[ "${mode}" == "active" ]]; then
    : "${AMD_GPU_ORCHESTRATOR_TOKEN:?AMD_GPU_ORCHESTRATOR_TOKEN is required}"
    if (( now - last_renewed_at >= renew_seconds )); then
      bash "$(dirname "$0")/deployment-drain.sh" renew
      last_renewed_at="${now}"
    fi
    payload="$(request_active_drain_payload)"
    supported="$(jq -r '.supported // false' <<<"${payload}")"
    drain_active="$(jq -r '.active // false' <<<"${payload}")"
    admission_locked="$(jq -r '.admissionLocked // false' <<<"${payload}")"
    owned="$(jq -r --arg id "${drain_id}" '
      if (.drainIds | type) == "array"
      then ((.drainIds | length) == 1 and .drainIds[0] == $id)
      else .drainId == $id
      end
    ' <<<"${payload}")"
    admitted="$(jq -r '.activeAdmittedRequests // -1' <<<"${payload}")"
    active_user_sessions="$(jq -r '.activeUserSessions // -1' <<<"${payload}")"
    queue="$(jq -c '.queue // {}' <<<"${payload}")"
    active="$(jq -r '.activeJobPresent // false' <<<"${queue}")"
    queued="$(jq -r '.queuedJobs // -1' <<<"${queue}")"
    ready="$(jq -r '.readyJobs // -1' <<<"${queue}")"
    preparing="$(jq -r '.preparingJobs // -1' <<<"${queue}")"
    in_progress="$(jq -r '.inProgressJobs // -1' <<<"${queue}")"
    planning="$(jq -r '.planningJobs // -1' <<<"${queue}")"
    awaiting_approval="$(jq -r '.awaitingApprovalJobs // -1' <<<"${queue}")"
    ready_for_deploy="$(jq -r '.readyForDeploy // false' <<<"${payload}")"
    quiet_for="$(jq -r '.quietForSeconds // 0' <<<"${payload}")"
    quiet_window="$(jq -r '.quietWindowSeconds // 30' <<<"${payload}")"
    worker_reachable="$(jq -r '.workerActivity.reachable // false' <<<"${payload}")"
    worker_verifiable="$(jq -r '.workerActivity.verifiable // false' <<<"${payload}")"
    worker_idle="$(jq -r '.workerActivity.idle // false' <<<"${payload}")"
    worker_accepting="$(jq -r '.workerActivity.acceptingJobs // false' <<<"${payload}")"
    checked_at="$(jq -r '.checkedAt // "unknown"' <<<"${payload}")"
    echo "Drain snapshot at ${checked_at}: owned=${owned} locked=${admission_locked} admitted=${admitted} active_users=${active_user_sessions} active=${active} queued=${queued} ready=${ready} preparing=${preparing} in_progress=${in_progress} planning=${planning} awaiting_approval=${awaiting_approval} quiet=${quiet_for}s worker_reachable=${worker_reachable} worker_verifiable=${worker_verifiable} worker_idle=${worker_idle} ready=${ready_for_deploy}"

    if [[ "${supported}" != "true" || "${drain_active}" != "true" || "${admission_locked}" != "true" || "${owned}" != "true" ]]; then
      echo "The durable deployment admission fence is missing or no longer owned by this pipeline; refusing to deploy." >&2
      exit 1
    fi
    snapshot_idle="false"
    if [[ "${ready_for_deploy}" == "true" && "${admitted}" == "0" && "${active_user_sessions}" == "0" && "${active}" != "true" && "${queued}" == "0" && "${ready}" == "0" && "${preparing}" == "0" && "${in_progress}" == "0" && "${planning}" == "0" && "${awaiting_approval}" == "0" && "${worker_reachable}" == "true" && "${worker_verifiable}" == "true" && "${worker_idle}" == "true" ]]; then
      snapshot_idle="true"
    elif [[ "${bootstrap_compatibility}" == "true" ]] && is_pinned_legacy_rollout && [[ "${admitted}" == "0" && "${active_user_sessions}" == "0" && "${active}" != "true" && "${queued}" == "0" && "${ready}" == "0" && "${preparing}" == "0" && "${in_progress}" == "0" && "${planning}" == "0" && "${awaiting_approval}" == "0" && "${worker_reachable}" == "true" && "${worker_verifiable}" == "false" && "${worker_accepting}" == "true" && "${quiet_for}" -ge "${quiet_window}" ]]; then
      echo "Using the one-time post-app-deploy compatibility gate for the pre-activity-evidence worker. The worker must be upgraded before release."
      snapshot_idle="true"
    fi
    required_stable_seconds="${stable_seconds}"
  elif [[ "${mode}" == "legacy" ]]; then
    payload="$(request_story_queue_payload)"
    active="$(jq -r '.activeJobPresent // false' <<<"${payload}")"
    queued="$(jq -r '.queuedJobs // -1' <<<"${payload}")"
    ready="$(jq -r '.readyJobs // -1' <<<"${payload}")"
    preparing="$(jq -r '.preparingJobs // -1' <<<"${payload}")"
    in_progress="$(jq -r '.inProgressJobs // -1' <<<"${payload}")"
    planning="$(jq -r '.planningJobs // -1' <<<"${payload}")"
    awaiting_approval="$(jq -r '.awaitingApprovalJobs // -1' <<<"${payload}")"
    checked_at="$(jq -r '.checkedAt // "unknown"' <<<"${payload}")"
    legacy_worker_idle="true"
    if [[ "${edge_gate_required}" == "true" ]]; then
      if probe_legacy_persistent_worker_idle; then
        legacy_worker_idle="true"
      else
        legacy_worker_probe_status=$?
        if [[ "${legacy_worker_probe_status}" == "3" ]]; then
          legacy_worker_idle="false"
        else
          echo "The gated legacy worker activity could not be proven; refusing to deploy." >&2
          exit 1
        fi
      fi
    fi
    echo "Pre-drain bootstrap snapshot at ${checked_at}: active=${active} queued=${queued} ready=${ready} preparing=${preparing} in_progress=${in_progress} planning=${planning} awaiting_approval=${awaiting_approval} worker_idle=${legacy_worker_idle}"
    snapshot_idle="false"
    if [[ "${active}" != "true" && "${queued}" == "0" && "${ready}" == "0" && "${preparing}" == "0" && "${in_progress}" == "0" && "${planning}" == "0" && "${awaiting_approval}" == "0" && "${legacy_worker_idle}" == "true" ]]; then
      snapshot_idle="true"
    fi
    required_stable_seconds="${legacy_stable_seconds}"
  else
    echo "Unknown deployment drain mode: ${mode}" >&2
    exit 1
  fi

  if [[ "${snapshot_idle}" == "true" ]]; then
    if (( stable_since == 0 )); then
      stable_since="${now}"
    fi
    stable_for=$(( now - stable_since ))
    if (( stable_for >= required_stable_seconds )); then
      echo "All admitted work stayed idle for ${stable_for}s while the deployment fence was held; deploy may continue."
      exit 0
    fi
    echo "Idle is stable for ${stable_for}s; requiring ${required_stable_seconds}s continuously."
  else
    stable_since=0
  fi

  if (( now >= deadline )); then
    echo "Timed out waiting for admitted work and the Product Story queue to drain; no deployment was started." >&2
    exit 1
  fi
  sleep "${poll_seconds}"
done
