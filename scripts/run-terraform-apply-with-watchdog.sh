#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script_path="${script_dir}/$(basename "${BASH_SOURCE[0]}")"
bash "${script_dir}/assert-production-targets.sh"

run_owned_apply() {
  local owner_nonce="$1"
  shift
  local awake_pid=""
  local awake_status=0

  [[ "${owner_nonce}" =~ ^rukterapply_[0-9]+_[0-9]+_[0-9]+_[0-9]+$ ]] || {
    echo "Terraform apply watchdog received an invalid process owner nonce." >&2
    return 2
  }
  (( $# > 0 )) || {
    echo "Terraform apply watchdog requires an apply command." >&2
    return 2
  }

  forward_signal() {
    local signal_name="$1"
    local exit_code="$2"
    if [[ "${awake_pid}" =~ ^[0-9]+$ ]] && kill -0 "${awake_pid}" 2>/dev/null; then
      kill -"${signal_name}" "${awake_pid}" 2>/dev/null || true
      wait "${awake_pid}" 2>/dev/null || true
    fi
    exit "${exit_code}"
  }

  trap 'forward_signal TERM 143' TERM
  trap 'forward_signal INT 130' INT
  trap 'forward_signal HUP 129' HUP

  if command -v caffeinate >/dev/null 2>&1; then
    # The production runner is macOS. Keep display, disk, idle-system, and
    # system-sleep assertions alive for exactly the owned apply process.
    caffeinate -dims env -u RUKTER_AI_CLOUDFLARE_API_TOKEN "$@" &
  elif command -v systemd-inhibit >/dev/null 2>&1; then
    systemd-inhibit \
      --what=sleep:idle \
      --who=rukter-terraform-apply \
      --why='Rukter production Terraform apply is in progress' \
      --mode=block \
      env -u RUKTER_AI_CLOUDFLARE_API_TOKEN "$@" &
  else
    echo "No supported sleep inhibitor is available; refusing an unattended Terraform apply." >&2
    return 2
  fi
  awake_pid=$!

  set +e
  wait "${awake_pid}"
  awake_status=$?
  set -e
  return "${awake_status}"
}

if [[ "${1:-}" == "__run_owned_apply" ]]; then
  (( $# >= 3 )) || {
    echo "Terraform apply watchdog internal runner is missing arguments." >&2
    exit 2
  }
  owner_nonce="$2"
  shift 2
  run_owned_apply "${owner_nonce}" "$@"
  exit $?
fi

apply_deadline_seconds="${DEPLOYMENT_APPLY_DEADLINE_SECONDS:-12600}"
renew_interval_seconds="${DEPLOYMENT_APPLY_RENEW_INTERVAL_SECONDS:-300}"
readiness_interval_seconds="${DEPLOYMENT_APPLY_READINESS_INTERVAL_SECONDS:-15}"
poll_seconds="${DEPLOYMENT_APPLY_POLL_SECONDS:-2}"
termination_grace_seconds="${DEPLOYMENT_APPLY_TERMINATION_GRACE_SECONDS:-15}"
drain_ttl_seconds="${DEPLOYMENT_DRAIN_TTL_SECONDS:-21600}"
edge_ttl_seconds="${DEPLOYMENT_EDGE_GATE_TTL_SECONDS:-21600}"
drain_state_file="${DEPLOYMENT_DRAIN_STATE_FILE:-.ci-artifacts/deployment-drain.env}"
phase_file="${DEPLOYMENT_PHASE_FILE:-.ci-artifacts/deployment-phase}"

# These ceilings are intentionally not configurable. The 3h30 local deadline
# leaves 30 minutes before the 4h GitLab job timeout and 2h30 before either 6h
# admission fence expires. Runtime TTL overrides must preserve a 2h margin.
maximum_apply_deadline_seconds=12600
minimum_fence_margin_seconds=7200
maximum_renew_interval_seconds=900
maximum_readiness_interval_seconds=60

usage() {
  echo "Usage: $0 terraform [apply arguments...]" >&2
  exit 2
}

require_positive_integer() {
  local name="$1"
  local value="$2"
  [[ "${value}" =~ ^[0-9]+$ ]] && (( value >= 1 )) || {
    echo "${name} must be a positive integer number of seconds." >&2
    exit 2
  }
}

(( $# > 0 )) || usage
require_positive_integer "DEPLOYMENT_APPLY_DEADLINE_SECONDS" "${apply_deadline_seconds}"
require_positive_integer "DEPLOYMENT_APPLY_RENEW_INTERVAL_SECONDS" "${renew_interval_seconds}"
require_positive_integer "DEPLOYMENT_APPLY_READINESS_INTERVAL_SECONDS" "${readiness_interval_seconds}"
require_positive_integer "DEPLOYMENT_APPLY_POLL_SECONDS" "${poll_seconds}"
require_positive_integer "DEPLOYMENT_APPLY_TERMINATION_GRACE_SECONDS" "${termination_grace_seconds}"
require_positive_integer "DEPLOYMENT_DRAIN_TTL_SECONDS" "${drain_ttl_seconds}"
require_positive_integer "DEPLOYMENT_EDGE_GATE_TTL_SECONDS" "${edge_ttl_seconds}"

(( apply_deadline_seconds <= maximum_apply_deadline_seconds )) || {
  echo "Terraform apply deadline exceeds the immutable 12600-second safety ceiling." >&2
  exit 2
}
(( renew_interval_seconds <= maximum_renew_interval_seconds && renew_interval_seconds < apply_deadline_seconds )) || {
  echo "Terraform apply fence renewal interval must be below both 900 seconds and the local deadline." >&2
  exit 2
}
(( readiness_interval_seconds <= maximum_readiness_interval_seconds && readiness_interval_seconds < apply_deadline_seconds )) || {
  echo "Terraform apply readiness interval must be below both 60 seconds and the local deadline." >&2
  exit 2
}
(( poll_seconds <= 30 )) || {
  echo "Terraform apply watchdog poll interval must not exceed 30 seconds." >&2
  exit 2
}
(( termination_grace_seconds <= 60 )) || {
  echo "Terraform apply termination grace must not exceed 60 seconds." >&2
  exit 2
}
(( apply_deadline_seconds + minimum_fence_margin_seconds <= drain_ttl_seconds )) || {
  echo "Terraform apply deadline must leave at least two hours on the durable drain TTL." >&2
  exit 2
}
(( apply_deadline_seconds + minimum_fence_margin_seconds <= edge_ttl_seconds )) || {
  echo "Terraform apply deadline must leave at least two hours on the Cloudflare edge TTL." >&2
  exit 2
}

drain_state_permissions() {
  if stat -f '%Lp' "${drain_state_file}" >/dev/null 2>&1; then
    stat -f '%Lp' "${drain_state_file}"
  else
    stat -c '%a' "${drain_state_file}"
  fi
}

phase_file_permissions() {
  if stat -f '%Lp' "${phase_file}" >/dev/null 2>&1; then
    stat -f '%Lp' "${phase_file}"
  else
    stat -c '%a' "${phase_file}"
  fi
}

validate_pre_apply_phase() {
  local phase line_count
  [[ -f "${phase_file}" && ! -L "${phase_file}" && -r "${phase_file}" ]] || {
    echo "Deployment phase state must be a readable regular non-symlink file before apply." >&2
    return 1
  }
  [[ "$(phase_file_permissions)" == "600" ]] || {
    echo "Deployment phase state permissions must be 600 before apply." >&2
    return 1
  }
  phase="$(sed -n '1p' "${phase_file}")"
  line_count="$(wc -l < "${phase_file}" | tr -d '[:space:]')"
  [[ "${phase}" == "pre_apply" && "${line_count}" == "1" ]] || {
    echo "Deployment phase state must contain exactly pre_apply before the watchdog starts." >&2
    return 1
  }
}

mark_apply_started() {
  local phase_tmp
  validate_pre_apply_phase || return 1
  phase_tmp="$(mktemp "${phase_file}.tmp.XXXXXX")"
  if ! chmod 600 "${phase_tmp}" || ! printf 'apply_started\n' > "${phase_tmp}"; then
    rm -f "${phase_tmp}"
    echo "Could not prepare the atomic apply_started phase state." >&2
    return 1
  fi
  # Re-check after preparing the temporary file so a swapped path cannot turn
  # this transition into a write through a symlink or non-regular target.
  if ! validate_pre_apply_phase; then
    rm -f "${phase_tmp}"
    return 1
  fi
  if ! mv -f "${phase_tmp}" "${phase_file}"; then
    rm -f "${phase_tmp}"
    echo "Could not atomically publish the apply_started phase state." >&2
    return 1
  fi
  chmod 600 "${phase_file}"
}

read_drain_mode() {
  local mode mode_count
  [[ -f "${drain_state_file}" && ! -L "${drain_state_file}" && -r "${drain_state_file}" ]] || {
    echo "Deployment drain state is unavailable; refusing an unowned apply watchdog operation." >&2
    return 1
  }
  [[ "$(drain_state_permissions)" == "600" ]] || {
    echo "Deployment drain state permissions must be 600 for the apply watchdog." >&2
    return 1
  }
  mode_count="$(sed -n '/^mode=/p' "${drain_state_file}" | wc -l | tr -d '[:space:]')"
  mode="$(sed -n 's/^mode=//p' "${drain_state_file}")"
  [[ "${mode_count}" == "1" && ( "${mode}" == "legacy" || "${mode}" == "active" ) ]] || {
    echo "Deployment drain state has an invalid or ambiguous mode." >&2
    return 1
  }
  printf '%s' "${mode}"
}

maintain_fences() {
  local drain_mode
  drain_mode="$(read_drain_mode)" || return 1
  echo "Renewing and verifying both production deployment fences."
  DEPLOYMENT_EDGE_GATE_REQUIRED=true bash "${script_dir}/deployment-drain.sh" renew || return 1
  if [[ "${drain_mode}" == "active" ]]; then
    DEPLOYMENT_EDGE_GATE_REQUIRED=true bash "${script_dir}/deployment-drain.sh" status || return 1
  else
    echo "Legacy drain mode: durable DigitalOcean ownership was renewed; the old app has no drain status endpoint."
  fi
  DEPLOYMENT_EDGE_GATE_PRODUCTION=true bash "${script_dir}/deployment-edge-gate.sh" renew \
    && DEPLOYMENT_EDGE_GATE_PRODUCTION=true bash "${script_dir}/deployment-edge-gate.sh" status
}

assert_apply_readiness() {
  local drain_mode
  drain_mode="$(read_drain_mode)" || return 1
  if [[ "${drain_mode}" == "legacy" ]]; then
    # The one-time manual migration release has no protected drain endpoint.
    # CI repeats its gated queue + direct-worker stable window after plan, and
    # TTL maintenance continues here without inventing unsupported evidence.
    return 0
  fi
  DEPLOYMENT_EDGE_GATE_REQUIRED=true bash "${script_dir}/deployment-drain.sh" assert-ready
}

# Verify phase ownership and both fences immediately before starting Terraform.
# A failed preflight leaves pre_apply intact so after_script can release fences.
validate_pre_apply_phase || exit 1
maintain_fences || {
  echo "Deployment fence preflight failed; Terraform apply was not started." >&2
  exit 1
}
assert_apply_readiness || {
  echo "Deployment readiness changed after the gated idle window; Terraform apply was not started." >&2
  exit 1
}

watchdog_parent_pid="$$"
owner_nonce="rukterapply_${watchdog_parent_pid}_${RANDOM}_${RANDOM}_$(date +%s)"
apply_pid=""
apply_pgid=""
apply_active=false
deadline_guard_pid=""
deadline_marker="$(mktemp "${TMPDIR:-/tmp}/rukter-terraform-apply-deadline.XXXXXX")"
rm -f "${deadline_marker}"

owned_apply_leader_matches() {
  local current_pgid current_ppid command_line
  [[ "${apply_pid}" =~ ^[0-9]+$ && "${apply_pgid}" =~ ^[0-9]+$ ]] || return 1
  current_pgid="$(ps -o pgid= -p "${apply_pid}" 2>/dev/null | tr -d '[:space:]')"
  current_ppid="$(ps -o ppid= -p "${apply_pid}" 2>/dev/null | tr -d '[:space:]')"
  command_line="$(ps -ww -o command= -p "${apply_pid}" 2>/dev/null || true)"
  [[ "${current_pgid}" == "${apply_pgid}" \
    && "${current_ppid}" == "${watchdog_parent_pid}" \
    && "${command_line}" == *"__run_owned_apply"* \
    && "${command_line}" == *"${owner_nonce}"* ]]
}

apply_group_alive() {
  [[ "${apply_pgid}" =~ ^[0-9]+$ ]] || return 1
  kill -0 -- "-${apply_pgid}" 2>/dev/null
}

terminate_owned_apply() {
  local reason="$1"
  local force_at
  if ! owned_apply_leader_matches; then
    echo "Apply process ownership could not be verified; refusing a process-group kill." >&2
    # The leader is our unreaped direct child. Signalling only that exact PID
    # is safe, and its internal trap forwards the signal to its owned child.
    if [[ "${apply_pid}" =~ ^[0-9]+$ ]] && kill -0 "${apply_pid}" 2>/dev/null; then
      kill -TERM "${apply_pid}" 2>/dev/null || true
    fi
    return 1
  fi

  echo "${reason}; terminating owned Terraform apply process group ${apply_pgid}." >&2
  kill -TERM -- "-${apply_pgid}" 2>/dev/null || true
  force_at=$(( $(date +%s) + termination_grace_seconds ))
  while apply_group_alive && (( $(date +%s) < force_at )); do
    sleep 1
  done
  if apply_group_alive; then
    echo "Terraform apply did not terminate within ${termination_grace_seconds}s; killing its owned process group." >&2
    kill -KILL -- "-${apply_pgid}" 2>/dev/null || true
  fi
}

cancel_deadline_guard() {
  if [[ "${deadline_guard_pid}" =~ ^[0-9]+$ ]] && kill -0 "${deadline_guard_pid}" 2>/dev/null; then
    kill -TERM "${deadline_guard_pid}" 2>/dev/null || true
  fi
  if [[ "${deadline_guard_pid}" =~ ^[0-9]+$ ]]; then
    wait "${deadline_guard_pid}" 2>/dev/null || true
  fi
  deadline_guard_pid=""
}

cleanup() {
  local exit_status=$?
  trap - EXIT INT TERM HUP
  cancel_deadline_guard
  if [[ "${apply_active}" == "true" ]]; then
    terminate_owned_apply "Terraform apply watchdog exited unexpectedly" || true
    wait "${apply_pid}" 2>/dev/null || true
    apply_active=false
  fi
  rm -f "${deadline_marker}"
  exit "${exit_status}"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# Job control gives this direct child a process group that cannot include the
# watchdog, runner, or any unrelated process. Every group signal below is
# additionally gated by PPID, PGID, and the per-run nonce in its command line.
mark_apply_started || exit 1
set -m
bash "${script_path}" __run_owned_apply "${owner_nonce}" "$@" &
apply_pid=$!
set +m
apply_pgid="$(ps -o pgid= -p "${apply_pid}" 2>/dev/null | tr -d '[:space:]')"

if [[ "${apply_pgid}" != "${apply_pid}" ]] || ! owned_apply_leader_matches; then
  echo "Could not isolate and verify the Terraform apply process group; refusing to continue." >&2
  if kill -0 "${apply_pid}" 2>/dev/null; then
    kill -TERM "${apply_pid}" 2>/dev/null || true
  fi
  wait "${apply_pid}" 2>/dev/null || true
  exit 1
fi
apply_active=true

(
  deadline_sleep_pid=""
  cancel_guardian_sleep() {
    if [[ "${deadline_sleep_pid}" =~ ^[0-9]+$ ]] && kill -0 "${deadline_sleep_pid}" 2>/dev/null; then
      kill -TERM "${deadline_sleep_pid}" 2>/dev/null || true
      wait "${deadline_sleep_pid}" 2>/dev/null || true
    fi
    exit 0
  }
  trap cancel_guardian_sleep TERM INT HUP
  sleep "${apply_deadline_seconds}" &
  deadline_sleep_pid=$!
  wait "${deadline_sleep_pid}"
  trap - TERM INT HUP
  if owned_apply_leader_matches; then
    printf 'deadline_exceeded\n' > "${deadline_marker}"
    terminate_owned_apply "Terraform apply exceeded its ${apply_deadline_seconds}s local deadline" || true
  fi
) &
deadline_guard_pid=$!

started_at="$(date +%s)"
next_renew_at=$(( started_at + renew_interval_seconds ))
next_readiness_at=$(( started_at + readiness_interval_seconds ))
fence_failure=false
readiness_failure=false

while kill -0 "${apply_pid}" 2>/dev/null; do
  now="$(date +%s)"
  if (( now >= next_readiness_at )); then
    if ! assert_apply_readiness; then
      readiness_failure=true
      terminate_owned_apply "Deployment readiness assertion failed while Terraform apply was running" || true
      break
    fi
    next_readiness_at=$(( $(date +%s) + readiness_interval_seconds ))
  fi
  if (( now >= next_renew_at )); then
    if ! maintain_fences; then
      fence_failure=true
      terminate_owned_apply "Deployment fence renewal or status verification failed" || true
      break
    fi
    next_renew_at=$(( $(date +%s) + renew_interval_seconds ))
  fi
  sleep "${poll_seconds}"
done

set +e
wait "${apply_pid}" 2>/dev/null
apply_status=$?
set -e
apply_active=false
cancel_deadline_guard

if [[ "${fence_failure}" == "true" ]]; then
  echo "Terraform apply was stopped because a deployment fence could not be renewed and verified." >&2
  exit 1
fi
if [[ "${readiness_failure}" == "true" ]]; then
  echo "Terraform apply was stopped because user, request, queue, ownership, or worker-idle readiness changed." >&2
  exit 1
fi
if [[ -f "${deadline_marker}" ]]; then
  echo "Terraform apply exceeded the bounded local deadline and was killed fail-closed." >&2
  exit 124
fi
if (( apply_status != 0 )); then
  echo "Terraform apply command failed with status ${apply_status}." >&2
fi
exit "${apply_status}"
