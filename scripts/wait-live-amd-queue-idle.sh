#!/usr/bin/env bash
set -euo pipefail

base_url="${RUKTER_AI_PUBLIC_URL:-https://rukter.ai}"
state_file="${DEPLOYMENT_DRAIN_STATE_FILE:-.ci-artifacts/deployment-drain.env}"
wait_seconds="${DEPLOYMENT_DRAIN_WAIT_SECONDS:-10800}"
poll_seconds="${DEPLOYMENT_DRAIN_POLL_SECONDS:-15}"
stable_seconds="${DEPLOYMENT_DRAIN_STABLE_SECONDS:-30}"
legacy_stable_seconds="${DEPLOYMENT_DRAIN_LEGACY_STABLE_SECONDS:-120}"
renew_seconds="${DEPLOYMENT_DRAIN_RENEW_SECONDS:-300}"
bootstrap_compatibility="${DEPLOYMENT_DRAIN_BOOTSTRAP_COMPATIBILITY:-false}"
legacy_parent_sha="${DEPLOYMENT_DRAIN_LEGACY_PARENT_SHA:-}"
deadline=$(( $(date +%s) + wait_seconds ))
stable_since=0
last_renewed_at="$(date +%s)"

read_state_value() {
  local key="$1"
  [[ -r "${state_file}" ]] || return 1
  sed -n "s/^${key}=//p" "${state_file}" | tail -n 1
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

mode="$(read_state_value mode || true)"
drain_id="$(read_state_value drain_id || true)"
[[ -n "${mode}" && -n "${drain_id}" ]] || {
  echo "Deployment drain state is missing; acquire the admission fence before waiting for idle." >&2
  exit 1
}

echo "Waiting for all admitted work to drain before production deploy: ${base_url} (mode=${mode})"
while true; do
  now="$(date +%s)"
  if [[ "${mode}" == "active" ]]; then
    : "${AMD_GPU_ORCHESTRATOR_TOKEN:?AMD_GPU_ORCHESTRATOR_TOKEN is required}"
    if (( now - last_renewed_at >= renew_seconds )); then
      bash "$(dirname "$0")/deployment-drain.sh" renew
      last_renewed_at="${now}"
    fi
    payload="$(curl -fsS \
      -H "Accept: application/json" \
      -H "Authorization: Bearer ${AMD_GPU_ORCHESTRATOR_TOKEN}" \
      "${base_url%/}/v1/deployment-drain")"
    supported="$(jq -r '.supported // false' <<<"${payload}")"
    drain_active="$(jq -r '.active // false' <<<"${payload}")"
    admission_locked="$(jq -r '.admissionLocked // false' <<<"${payload}")"
    owned="$(jq -r --arg id "${drain_id}" '((.drainIds // []) | index($id)) != null or .drainId == $id' <<<"${payload}")"
    admitted="$(jq -r '.activeAdmittedRequests // -1' <<<"${payload}")"
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
    echo "Drain snapshot at ${checked_at}: owned=${owned} locked=${admission_locked} admitted=${admitted} active=${active} queued=${queued} ready=${ready} preparing=${preparing} in_progress=${in_progress} planning=${planning} awaiting_approval=${awaiting_approval} quiet=${quiet_for}s worker_reachable=${worker_reachable} worker_verifiable=${worker_verifiable} worker_idle=${worker_idle} ready=${ready_for_deploy}"

    if [[ "${supported}" != "true" || "${drain_active}" != "true" || "${admission_locked}" != "true" || "${owned}" != "true" ]]; then
      echo "The durable deployment admission fence is missing or no longer owned by this pipeline; refusing to deploy." >&2
      exit 1
    fi
    snapshot_idle="false"
    if [[ "${ready_for_deploy}" == "true" && "${admitted}" == "0" && "${active}" != "true" && "${queued}" == "0" && "${ready}" == "0" && "${preparing}" == "0" && "${in_progress}" == "0" && "${planning}" == "0" && "${awaiting_approval}" == "0" ]]; then
      snapshot_idle="true"
    elif [[ "${bootstrap_compatibility}" == "true" ]] && is_pinned_legacy_rollout && [[ "${admitted}" == "0" && "${active}" != "true" && "${queued}" == "0" && "${ready}" == "0" && "${preparing}" == "0" && "${in_progress}" == "0" && "${planning}" == "0" && "${awaiting_approval}" == "0" && "${worker_reachable}" == "true" && "${worker_verifiable}" == "false" && "${worker_accepting}" == "true" && "${quiet_for}" -ge "${quiet_window}" ]]; then
      echo "Using the one-time post-app-deploy compatibility gate for the pre-activity-evidence worker. The worker must be upgraded before release."
      snapshot_idle="true"
    fi
    required_stable_seconds="${stable_seconds}"
  elif [[ "${mode}" == "legacy" ]]; then
    payload="$(curl -fsS "${base_url%/}/api/story-queue")"
    active="$(jq -r '.activeJobPresent // false' <<<"${payload}")"
    queued="$(jq -r '.queuedJobs // -1' <<<"${payload}")"
    ready="$(jq -r '.readyJobs // -1' <<<"${payload}")"
    preparing="$(jq -r '.preparingJobs // -1' <<<"${payload}")"
    in_progress="$(jq -r '.inProgressJobs // -1' <<<"${payload}")"
    planning="$(jq -r '.planningJobs // -1' <<<"${payload}")"
    awaiting_approval="$(jq -r '.awaitingApprovalJobs // -1' <<<"${payload}")"
    checked_at="$(jq -r '.checkedAt // "unknown"' <<<"${payload}")"
    echo "Pre-drain bootstrap snapshot at ${checked_at}: active=${active} queued=${queued} ready=${ready} preparing=${preparing} in_progress=${in_progress} planning=${planning} awaiting_approval=${awaiting_approval}"
    snapshot_idle="false"
    if [[ "${active}" != "true" && "${queued}" == "0" && "${ready}" == "0" && "${preparing}" == "0" && "${in_progress}" == "0" && "${planning}" == "0" && "${awaiting_approval}" == "0" ]]; then
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
