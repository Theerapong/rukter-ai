#!/usr/bin/env bash
set -euo pipefail

: "${CI_COMMIT_SHA:?CI_COMMIT_SHA is required}"

base_url="${RUKTER_AI_PUBLIC_URL:-https://rukter.ai}"
wait_seconds="${DEPLOYMENT_VERIFY_WAIT_SECONDS:-1200}"
poll_seconds="${DEPLOYMENT_VERIFY_POLL_SECONDS:-10}"
deadline=$(( $(date +%s) + wait_seconds ))

echo "Waiting for ${base_url} to serve commit ${CI_COMMIT_SHA}."
while (( $(date +%s) < deadline )); do
  health="$(curl -fsS "${base_url%/}/health" 2>/dev/null || true)"
  live_sha="$(jq -r '.commitSha // .appCommitSha // .deployment.commitSha // empty' <<<"${health}" 2>/dev/null || true)"
  if [[ "${live_sha}" == "${CI_COMMIT_SHA}" ]]; then
    echo "Live deployment version verified: ${live_sha}"
    exit 0
  fi
  if [[ -n "${live_sha}" ]]; then
    echo "Live deployment still serves ${live_sha}; waiting for ${CI_COMMIT_SHA}."
  else
    echo "Live health is reachable but does not yet expose the expected deployment SHA."
  fi
  sleep "${poll_seconds}"
done

echo "Timed out waiting for the live app to serve ${CI_COMMIT_SHA}; keeping the deployment drain locked until its TTL expires." >&2
exit 1
