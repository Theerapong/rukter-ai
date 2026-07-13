#!/usr/bin/env bash
set -euo pipefail

: "${CI_COMMIT_SHA:?CI_COMMIT_SHA is required}"

branch="${CI_DEFAULT_BRANCH:-main}"
current_sha="$(git ls-remote --heads origin "refs/heads/${branch}" | awk 'NR == 1 { print $1 }')"

if [[ -z "${current_sha}" ]]; then
  echo "Could not resolve the current ${branch} SHA; refusing to deploy." >&2
  exit 1
fi

if [[ "${current_sha}" != "${CI_COMMIT_SHA}" ]]; then
  echo "Pipeline SHA ${CI_COMMIT_SHA} is stale; ${branch} is now ${current_sha}. Refusing to deploy the older image." >&2
  exit 1
fi

echo "Current-${branch} guard passed: ${CI_COMMIT_SHA}"
