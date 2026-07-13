#!/usr/bin/env bash
set -euo pipefail

: "${CI_API_V4_URL:?CI_API_V4_URL is required}"
: "${CI_PROJECT_ID:?CI_PROJECT_ID is required}"
: "${CI_JOB_TOKEN:?CI_JOB_TOKEN is required}"
: "${CI_COMMIT_SHA:?CI_COMMIT_SHA is required}"

branch="${CI_DEFAULT_BRANCH:-main}"
branch_json="$(curl -fsS \
  -H "JOB-TOKEN: ${CI_JOB_TOKEN}" \
  "${CI_API_V4_URL}/projects/${CI_PROJECT_ID}/repository/branches/${branch}")"
current_sha="$(jq -r '.commit.id // empty' <<<"${branch_json}")"

if [[ -z "${current_sha}" ]]; then
  echo "Could not resolve the current ${branch} SHA; refusing to deploy." >&2
  exit 1
fi

if [[ "${current_sha}" != "${CI_COMMIT_SHA}" ]]; then
  echo "Pipeline SHA ${CI_COMMIT_SHA} is stale; ${branch} is now ${current_sha}. Refusing to deploy the older image." >&2
  exit 1
fi

echo "Current-${branch} guard passed: ${CI_COMMIT_SHA}"
