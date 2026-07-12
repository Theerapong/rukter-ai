#!/usr/bin/env bash
set -euo pipefail

base_url="${RUKTER_AI_PUBLIC_URL:-https://rukter.ai}"
wait_seconds="${AMD_QUEUE_IDLE_WAIT_SECONDS:-1800}"
poll_seconds="${AMD_QUEUE_IDLE_POLL_SECONDS:-15}"
deadline=$(( $(date +%s) + wait_seconds ))

echo "Waiting for live AMD Product Story queue to become idle before deploy: ${base_url}"
while true; do
  payload="$(curl -fsS "${base_url%/}/api/story-queue")"
  active="$(printf '%s' "${payload}" | jq -r '.activeJobPresent')"
  queued="$(printf '%s' "${payload}" | jq -r '.queuedJobs // 0')"
  ready="$(printf '%s' "${payload}" | jq -r '.readyJobs // 0')"
  preparing="$(printf '%s' "${payload}" | jq -r '.preparingJobs // 0')"
  in_progress="$(printf '%s' "${payload}" | jq -r '.inProgressJobs // 0')"
  planning="$(printf '%s' "${payload}" | jq -r '.planningJobs // 0')"
  awaiting_approval="$(printf '%s' "${payload}" | jq -r '.awaitingApprovalJobs // 0')"
  checked_at="$(printf '%s' "${payload}" | jq -r '.checkedAt // "unknown"')"
  echo "AMD story snapshot at ${checked_at}: active=${active} queued=${queued} ready=${ready} preparing=${preparing} in_progress=${in_progress} planning=${planning} awaiting_approval=${awaiting_approval}"
  if [[ "${active}" != "true" && "${queued}" == "0" && "${in_progress}" == "0" ]]; then
    echo "AMD Product Story queue is idle; deploy may continue."
    exit 0
  fi
  if (( $(date +%s) >= deadline )); then
    echo "Timed out waiting for AMD Product Story queue to become idle." >&2
    exit 1
  fi
  sleep "${poll_seconds}"
done
