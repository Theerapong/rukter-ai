#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "${script_dir}/assert-production-targets.sh"

: "${CI_COMMIT_SHA:?CI_COMMIT_SHA is required}"

base_url="${RUKTER_AI_PUBLIC_URL:-https://rukter.ai}"
wait_seconds="${DEPLOYMENT_VERIFY_WAIT_SECONDS:-1200}"
poll_seconds="${DEPLOYMENT_VERIFY_POLL_SECONDS:-10}"
edge_gate_state_file="${DEPLOYMENT_EDGE_GATE_STATE_FILE:-.ci-artifacts/deployment-edge-gate.json}"
edge_gate_required="${DEPLOYMENT_EDGE_GATE_REQUIRED:-false}"
deadline=$(( $(date +%s) + wait_seconds ))

edge_header_key=""
edge_header_value=""
if [[ "${edge_gate_required}" == "true" && ! -r "${edge_gate_state_file}" ]]; then
  echo "Deployment edge gate state is required; refusing an ungated app request." >&2
  exit 1
fi
if [[ -r "${edge_gate_state_file}" ]]; then
  edge_header_key="$(jq -er '.header_key | select(type == "string" and test("^[A-Za-z0-9-]{1,128}$"))' "${edge_gate_state_file}")" || {
    echo "Deployment edge gate state has an invalid header key; refusing an ungated app request." >&2
    exit 1
  }
  edge_header_value="$(jq -er '.header_value | select(type == "string" and test("^[A-Fa-f0-9]{64}$"))' "${edge_gate_state_file}")" || {
    echo "Deployment edge gate state has an invalid header value; refusing an ungated app request." >&2
    exit 1
  }
fi

edge_header_file="$(mktemp "${TMPDIR:-/tmp}/rukter-verify-headers.XXXXXX")"
chmod 600 "${edge_header_file}"
trap 'rm -f "${edge_header_file}"' EXIT
{
  printf 'Accept: application/json\n'
  if [[ -n "${edge_header_key}" ]]; then
    printf '%s: %s\n' "${edge_header_key}" "${edge_header_value}"
  fi
} > "${edge_header_file}"
edge_gate_args=(--header "@${edge_header_file}")

echo "Waiting for ${base_url} to serve commit ${CI_COMMIT_SHA}."
while (( $(date +%s) < deadline )); do
  health="$(curl -fsS "${edge_gate_args[@]}" "${base_url%/}/health" 2>/dev/null || true)"
  config="$(curl -fsS "${edge_gate_args[@]}" "${base_url%/}/api/config" 2>/dev/null || true)"
  queue="$(curl -fsS "${edge_gate_args[@]}" "${base_url%/}/api/story-queue" 2>/dev/null || true)"
  live_sha="$(jq -r '.commitSha // .appCommitSha // .deployment.commitSha // empty' <<<"${health}" 2>/dev/null || true)"
  config_ready="$(jq -r '(.amdGpuAutoShutdown == false and .amdGpuAlwaysOn == true)' <<<"${config}" 2>/dev/null || true)"
  queue_ready="$(jq -r '(
    .activeJobPresent == false
    and .queuedJobs == 0
    and .readyJobs == 0
    and .preparingJobs == 0
    and .inProgressJobs == 0
    and .planningJobs == 0
    and .awaitingApprovalJobs == 0
  )' <<<"${queue}" 2>/dev/null || true)"
  if [[ "${live_sha}" == "${CI_COMMIT_SHA}" && "${config_ready}" == "true" && "${queue_ready}" == "true" ]]; then
    echo "Live deployment, always-on AMD configuration, and idle Product Story queue verified: ${live_sha}"
    exit 0
  fi
  if [[ -n "${live_sha}" ]]; then
    echo "Live verification pending: commit=${live_sha} expected=${CI_COMMIT_SHA} amd_config=${config_ready:-false} queue_idle=${queue_ready:-false}."
  else
    echo "Live health is reachable but does not yet expose the expected deployment SHA."
  fi
  sleep "${poll_seconds}"
done

echo "Timed out waiting for the live app, always-on AMD configuration, and idle queue verification for ${CI_COMMIT_SHA}; keeping both deployment fences locked until their TTLs expire." >&2
exit 1
