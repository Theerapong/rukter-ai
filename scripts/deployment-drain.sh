#!/usr/bin/env bash
set -euo pipefail

action="${1:-}"
base_url="${RUKTER_AI_PUBLIC_URL:-https://rukter.ai}"
state_file="${DEPLOYMENT_DRAIN_STATE_FILE:-.ci-artifacts/deployment-drain.env}"
ttl_seconds="${DEPLOYMENT_DRAIN_TTL_SECONDS:-14400}"
legacy_parent_sha="${DEPLOYMENT_DRAIN_LEGACY_PARENT_SHA:-}"
require_supported="${DEPLOYMENT_DRAIN_REQUIRE_SUPPORTED:-false}"
# Keep ownership stable across retries and replacement pipelines for the same
# commit. A newer commit gets a different owner and cannot release this fence.
drain_id="${DEPLOYMENT_DRAIN_ID:-rukter_ci_${CI_COMMIT_SHA:-${CI_PIPELINE_ID:-manual}}}"
digitalocean_api_url="${AMD_GPU_DIGITALOCEAN_API_URL:-https://api.digitalocean.com/v2}"
persistent_tag="${AMD_GPU_PERSISTENT_TAG:-rukter-product-story-persistent}"

usage() {
  echo "Usage: $0 acquire|renew|status|release" >&2
  exit 2
}

if [[ ! "${drain_id}" =~ ^[A-Za-z0-9_-]{12,64}$ ]]; then
  echo "Deployment drain id must contain 12 to 64 letters, numbers, underscores, or dashes." >&2
  exit 2
fi

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

write_state() {
  local mode="$1"
  local id="$2"
  mkdir -p "$(dirname "${state_file}")"
  printf 'mode=%s\ndrain_id=%s\n' "${mode}" "${id}" > "${state_file}"
}

write_legacy_state() {
  local id="$1"
  local tag_name="$2"
  local droplet_id="$3"
  mkdir -p "$(dirname "${state_file}")"
  printf 'mode=legacy\ndrain_id=%s\nlegacy_tag=%s\nlegacy_droplet_id=%s\n' \
    "${id}" "${tag_name}" "${droplet_id}" > "${state_file}"
}

digitalocean_request() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local output_file="$4"
  : "${AMD_GPU_DIGITALOCEAN_TOKEN:?AMD_GPU_DIGITALOCEAN_TOKEN is required for the first deployment bridge}"
  local args=(
    -sS
    -o "${output_file}"
    -w '%{http_code}'
    -X "${method}"
    -H "Accept: application/json"
    -H "Authorization: Bearer ${AMD_GPU_DIGITALOCEAN_TOKEN}"
  )
  if [[ -n "${body}" ]]; then
    args+=(-H "Content-Type: application/json" --data "${body}")
  fi
  curl "${args[@]}" "${digitalocean_api_url%/}${path}"
}

acquire_legacy_durable_fence() {
  local response_file http_code encoded_tag droplet_count droplet_id expires_epoch tag_name payload
  response_file="$(mktemp)"
  encoded_tag="$(jq -rn --arg value "${persistent_tag}" '$value | @uri')"
  http_code="$(digitalocean_request GET "/droplets?tag_name=${encoded_tag}&per_page=200" '' "${response_file}")"
  [[ "${http_code}" == "200" ]] || {
    echo "Could not locate the persistent AMD worker for the first deployment fence (HTTP ${http_code})." >&2
    rm -f "${response_file}"
    exit 1
  }
  droplet_count="$(jq -r '[.droplets[]?] | length' "${response_file}")"
  [[ "${droplet_count}" == "1" ]] || {
    echo "Expected exactly one persistent AMD worker for the first deployment fence; found ${droplet_count}." >&2
    rm -f "${response_file}"
    exit 1
  }
  droplet_id="$(jq -r '.droplets[0].id | tostring' "${response_file}")"
  [[ "${droplet_id}" =~ ^[0-9]+$ ]] || {
    echo "The persistent AMD worker returned an invalid Droplet id." >&2
    rm -f "${response_file}"
    exit 1
  }

  expires_epoch=$(( $(date +%s) + ttl_seconds ))
  tag_name="rukter-deploy-drain-${drain_id}-until-${expires_epoch}"
  payload="$(jq -cn --arg name "${tag_name}" '{name: $name}')"
  http_code="$(digitalocean_request POST /tags "${payload}" "${response_file}")"
  if [[ "${http_code}" != "200" && "${http_code}" != "201" && "${http_code}" != "422" ]]; then
    echo "Could not create the owned first-deployment TTL fence (HTTP ${http_code})." >&2
    rm -f "${response_file}"
    exit 1
  fi

  payload="$(jq -cn --arg id "${droplet_id}" '{resources: [{resource_id: $id, resource_type: "droplet"}]}')"
  http_code="$(digitalocean_request POST "/tags/${tag_name}/resources" "${payload}" "${response_file}")"
  if [[ "${http_code}" != "200" && "${http_code}" != "204" ]]; then
    echo "Could not attach the owned first-deployment TTL fence (HTTP ${http_code}); refusing to deploy." >&2
    rm -f "${response_file}"
    exit 1
  fi

  write_legacy_state "${drain_id}" "${tag_name}" "${droplet_id}"
  rm -f "${response_file}"
  echo "Attached the one-time durable deployment fence ${tag_name} to persistent AMD Droplet ${droplet_id}." >&2
}

release_legacy_durable_fence() {
  local tag_name droplet_id response_file payload http_code
  tag_name="$(read_state_value legacy_tag || true)"
  droplet_id="$(read_state_value legacy_droplet_id || true)"
  [[ "${tag_name}" =~ ^rukter-deploy-drain-[A-Za-z0-9_-]{12,64}-until-[0-9]{10,12}$ && "${droplet_id}" =~ ^[0-9]+$ ]] || {
    echo "Legacy deployment fence state is incomplete; refusing an unowned release." >&2
    exit 1
  }
  response_file="$(mktemp)"
  payload="$(jq -cn --arg id "${droplet_id}" '{resources: [{resource_id: $id, resource_type: "droplet"}]}')"
  http_code="$(digitalocean_request DELETE "/tags/${tag_name}/resources" "${payload}" "${response_file}")"
  if [[ "${http_code}" != "200" && "${http_code}" != "204" && "${http_code}" != "404" ]]; then
    echo "Could not detach the owned first-deployment TTL fence (HTTP ${http_code}); it remains until expiry." >&2
    rm -f "${response_file}"
    exit 1
  fi
  http_code="$(digitalocean_request DELETE "/tags/${tag_name}" '' "${response_file}")"
  if [[ "${http_code}" != "200" && "${http_code}" != "204" && "${http_code}" != "404" ]]; then
    echo "Could not delete the owned first-deployment TTL tag (HTTP ${http_code}); it remains until expiry." >&2
    rm -f "${response_file}"
    exit 1
  fi
  rm -f "${response_file}"
  echo "Released the owned first-deployment TTL fence ${tag_name}."
}

request() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local output_file="$4"
  local args=(
    -sS
    -o "${output_file}"
    -w '%{http_code}'
    -X "${method}"
    -H "Accept: application/json"
    -H "Authorization: Bearer ${AMD_GPU_ORCHESTRATOR_TOKEN}"
  )
  if [[ -n "${body}" ]]; then
    args+=(-H "Content-Type: application/json" --data "${body}")
  fi
  curl "${args[@]}" "${base_url%/}${path}"
}

require_token() {
  : "${AMD_GPU_ORCHESTRATOR_TOKEN:?AMD_GPU_ORCHESTRATOR_TOKEN is required}"
}

acquire_or_renew() {
  local operation="$1"
  local response_file http_code payload
  require_token

  if [[ "${operation}" == "renew" ]]; then
    local state_mode state_id
    state_mode="$(read_state_value mode || true)"
    state_id="$(read_state_value drain_id || true)"
    if [[ "${state_mode}" == "legacy" ]]; then
      echo "Legacy bootstrap mode has no server-side deployment drain to renew."
      return 0
    fi
    [[ "${state_mode}" == "active" && -n "${state_id}" ]] || {
      echo "Cannot renew deployment drain without an active state file." >&2
      exit 1
    }
    drain_id="${state_id}"
  fi

  response_file="$(mktemp)"
  payload="$(jq -cn --arg drainId "${drain_id}" --argjson ttlSeconds "${ttl_seconds}" '{drainId: $drainId, ttlSeconds: $ttlSeconds}')"
  http_code="$(request POST /v1/deployment-drain/acquire "${payload}" "${response_file}")"

  if [[ "${http_code}" == "200" || "${http_code}" == "201" ]]; then
    if ! jq -e --arg id "${drain_id}" '
      .supported == true
      and .active == true
      and .admissionLocked == true
      and ((.drainId == $id) or ((.drainIds // []) | index($id) != null))
    ' "${response_file}" >/dev/null; then
      echo "Deployment drain ${operation} returned an invalid or unlocked response." >&2
      jq '{supported,active,state,drainId,drainIds,expiresAt,admissionLocked}' "${response_file}" >&2 || true
      exit 1
    fi
    write_state active "${drain_id}"
    jq -r --arg operation "${operation}" '"Deployment drain \($operation): id=\(.drainId // "owned") state=\(.state) expiresAt=\(.expiresAt)"' "${response_file}"
    rm -f "${response_file}"
    return 0
  fi

  if [[ "${operation}" == "acquire" && ( "${http_code}" == "404" || "${http_code}" == "405" ) && "${require_supported}" != "true" ]]; then
    if is_pinned_legacy_rollout; then
      rm -f "${response_file}"
      acquire_legacy_durable_fence
      echo "The pre-drain production release does not expose the drain API. This one bootstrap pipeline holds a durable TTL tag and requires a long continuous idle window; later commits fail closed." >&2
      return 0
    fi
    echo "Deployment drain API is unavailable and this is not the explicitly pinned bootstrap pipeline; refusing to deploy." >&2
    exit 1
  fi

  if [[ ( "${http_code}" == "404" || "${http_code}" == "405" ) && "${require_supported}" == "true" ]]; then
    echo "The post-apply app does not expose the required deployment-drain API; refusing further deployment work." >&2
    exit 1
  fi

  echo "Deployment drain ${operation} failed with HTTP ${http_code}." >&2
  jq . "${response_file}" >&2 2>/dev/null || sed -n '1,20p' "${response_file}" >&2
  exit 1
}

show_status() {
  local response_file http_code
  require_token
  response_file="$(mktemp)"
  http_code="$(request GET /v1/deployment-drain '' "${response_file}")"
  [[ "${http_code}" == "200" ]] || {
    echo "Deployment drain status failed with HTTP ${http_code}; refusing to continue." >&2
    exit 1
  }
  jq -e '.supported == true' "${response_file}" >/dev/null || {
    echo "Production does not report deployment-drain support." >&2
    exit 1
  }
  jq '{supported,active,state,drainIds,expiresAt,admissionLocked,activeAdmittedRequests,quietForSeconds,queue,readyForDeploy,checkedAt}' "${response_file}"
  rm -f "${response_file}"
}

release_drain() {
  local state_mode state_id response_file http_code payload
  require_token
  state_mode="$(read_state_value mode || true)"
  state_id="$(read_state_value drain_id || true)"
  [[ -n "${state_mode}" && -n "${state_id}" ]] || {
    echo "Deployment drain state is missing; refusing an unowned release." >&2
    exit 1
  }

  if [[ "${state_mode}" == "legacy" ]]; then
    release_legacy_durable_fence
    return 0
  fi

  response_file="$(mktemp)"
  payload="$(jq -cn --arg drainId "${state_id}" '{drainId: $drainId}')"
  http_code="$(request POST /v1/deployment-drain/release "${payload}" "${response_file}")"
  [[ "${http_code}" == "200" ]] || {
    echo "Owned deployment drain release failed with HTTP ${http_code}; the TTL fence remains in place." >&2
    jq . "${response_file}" >&2 2>/dev/null || true
    exit 1
  }
  if ! jq -e --arg id "${state_id}" '((.drainIds // []) | index($id)) == null' "${response_file}" >/dev/null; then
    echo "The deployment drain response still contains this pipeline's drain id; the TTL fence remains in place." >&2
    exit 1
  fi
  echo "Released deployment drain ${state_id} after app and persistent worker verification succeeded."
  rm -f "${response_file}"
}

case "${action}" in
  acquire|renew)
    acquire_or_renew "${action}"
    ;;
  status)
    show_status
    ;;
  release)
    release_drain
    ;;
  *)
    usage
    ;;
esac
