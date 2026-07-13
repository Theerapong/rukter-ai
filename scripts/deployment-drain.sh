#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "${script_dir}/assert-production-targets.sh"

action="${1:-}"
base_url="${RUKTER_AI_PUBLIC_URL:-https://rukter.ai}"
state_file="${DEPLOYMENT_DRAIN_STATE_FILE:-.ci-artifacts/deployment-drain.env}"
ttl_seconds="${DEPLOYMENT_DRAIN_TTL_SECONDS:-21600}"
edge_gate_state_file="${DEPLOYMENT_EDGE_GATE_STATE_FILE:-.ci-artifacts/deployment-edge-gate.json}"
edge_gate_required="${DEPLOYMENT_EDGE_GATE_REQUIRED:-false}"
legacy_parent_sha="${DEPLOYMENT_DRAIN_LEGACY_PARENT_SHA:-}"
bootstrap_approved_sha="${DEPLOYMENT_DRAIN_BOOTSTRAP_APPROVED_SHA:-}"
require_supported="${DEPLOYMENT_DRAIN_REQUIRE_SUPPORTED:-false}"
# Keep ownership stable across retries and replacement pipelines for the same
# commit. A newer commit gets a different owner and cannot release this fence.
drain_id="${DEPLOYMENT_DRAIN_ID:-rukter_ci_${CI_COMMIT_SHA:-${CI_PIPELINE_ID:-manual}}}"
digitalocean_api_url="${DEPLOYMENT_DRAIN_DIGITALOCEAN_API_URL:-${AMD_GPU_DIGITALOCEAN_API_URL:-https://api.digitalocean.com/v2}}"
deployment_digitalocean_token="${DEPLOYMENT_DRAIN_DIGITALOCEAN_TOKEN:-${AMD_GPU_DIGITALOCEAN_TOKEN:-${DIGITALOCEAN_TOKEN:-}}}"
persistent_tag="${AMD_GPU_PERSISTENT_TAG:-rukter-product-story-persistent}"

usage() {
  echo "Usage: $0 acquire|renew|status|assert-ready|release" >&2
  exit 2
}

if [[ ! "${drain_id}" =~ ^[A-Za-z0-9_-]{12,64}$ ]]; then
  echo "Deployment drain id must contain 12 to 64 letters, numbers, underscores, or dashes." >&2
  exit 2
fi
if [[ ! "${ttl_seconds}" =~ ^[0-9]+$ ]] || (( ttl_seconds < 60 || ttl_seconds > 21600 )); then
  echo "Deployment drain TTL must be between 60 and 21600 seconds." >&2
  exit 2
fi

read_state_value() {
  local key="$1"
  [[ ! -L "${state_file}" ]] || {
    echo "Refusing to read deployment drain state through a symbolic link." >&2
    return 2
  }
  [[ -f "${state_file}" && -r "${state_file}" ]] || return 1
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
  local tag_name="$3"
  local droplet_id="$4"
  local state_dir state_tmp
  state_dir="$(dirname "${state_file}")"
  mkdir -p "${state_dir}"
  [[ ! -L "${state_file}" ]] || {
    echo "Refusing to write deployment drain state through a symbolic link." >&2
    exit 1
  }
  if [[ -e "${state_file}" && ! -f "${state_file}" ]]; then
    echo "Deployment drain state path is not a regular file; refusing to replace it." >&2
    exit 1
  fi

  state_tmp="$(mktemp "${state_file}.tmp.XXXXXX")"
  if ! chmod 600 "${state_tmp}"; then
    rm -f "${state_tmp}"
    echo "Could not secure the temporary deployment drain state file." >&2
    exit 1
  fi
  if ! printf 'mode=%s\ndrain_id=%s\nowned_tag=%s\ndroplet_id=%s\n' \
    "${mode}" "${id}" "${tag_name}" "${droplet_id}" > "${state_tmp}"; then
    rm -f "${state_tmp}"
    echo "Could not write the temporary deployment drain state file." >&2
    exit 1
  fi
  [[ ! -L "${state_file}" ]] || {
    rm -f "${state_tmp}"
    echo "Refusing to replace deployment drain state through a symbolic link." >&2
    exit 1
  }
  if [[ -e "${state_file}" && ! -f "${state_file}" ]]; then
    rm -f "${state_tmp}"
    echo "Deployment drain state path changed to a non-regular file; refusing to replace it." >&2
    exit 1
  fi
  if ! mv -f "${state_tmp}" "${state_file}"; then
    rm -f "${state_tmp}"
    echo "Could not atomically publish deployment drain state." >&2
    exit 1
  fi
}

digitalocean_request() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local output_file="$4"
  local header_file curl_status
  : "${deployment_digitalocean_token:?DIGITALOCEAN_TOKEN is required to own the deployment fence}"
  header_file="$(mktemp "${TMPDIR:-/tmp}/rukter-do-headers.XXXXXX")"
  chmod 600 "${header_file}"
  {
    printf 'Accept: application/json\n'
    printf 'Authorization: Bearer %s\n' "${deployment_digitalocean_token}"
    if [[ -n "${body}" ]]; then
      printf 'Content-Type: application/json\n'
    fi
  } > "${header_file}"
  local args=(
    -sS
    -o "${output_file}"
    -w '%{http_code}'
    -X "${method}"
    --header "@${header_file}"
  )
  if [[ -n "${body}" ]]; then
    if printf '%s' "${body}" | curl "${args[@]}" --data-binary @- "${digitalocean_api_url%/}${path}"; then
      curl_status=0
    else
      curl_status=$?
    fi
  elif curl "${args[@]}" "${digitalocean_api_url%/}${path}"; then
    curl_status=0
  else
    curl_status=$?
  fi
  rm -f "${header_file}"
  return "${curl_status}"
}

remove_owned_durable_tag() {
  local tag_name="$1"
  local droplet_id="$2"
  local response_file payload http_code
  [[ "${tag_name}" =~ ^rukter-deploy-drain-${drain_id}-until-[0-9]{10,12}$ && "${droplet_id}" =~ ^[0-9]+$ ]] || {
    echo "Deployment fence state is incomplete; refusing an unowned tag removal." >&2
    exit 1
  }
  response_file="$(mktemp)"
  payload="$(jq -cn --arg id "${droplet_id}" '{resources: [{resource_id: $id, resource_type: "droplet"}]}')"
  http_code="$(digitalocean_request DELETE "/tags/${tag_name}/resources" "${payload}" "${response_file}")"
  if [[ "${http_code}" != "200" && "${http_code}" != "204" && "${http_code}" != "404" ]]; then
    echo "Could not detach owned deployment fence ${tag_name} (HTTP ${http_code}); it remains until expiry." >&2
    rm -f "${response_file}"
    exit 1
  fi
  http_code="$(digitalocean_request DELETE "/tags/${tag_name}" '' "${response_file}")"
  if [[ "${http_code}" != "200" && "${http_code}" != "204" && "${http_code}" != "404" ]]; then
    echo "Could not delete owned deployment tag ${tag_name} (HTTP ${http_code}); it remains until expiry." >&2
    rm -f "${response_file}"
    exit 1
  fi
  rm -f "${response_file}"
}

acquire_durable_fence() {
  local mode="$1"
  local response_file http_code encoded_tag droplet_count droplet_id now_epoch expires_epoch tag_name payload conflicting_ids
  response_file="$(mktemp)"
  encoded_tag="$(jq -rn --arg value "${persistent_tag}" '$value | @uri')"
  http_code="$(digitalocean_request GET "/droplets?tag_name=${encoded_tag}&per_page=200" '' "${response_file}")"
  [[ "${http_code}" == "200" ]] || {
    echo "Could not locate the persistent AMD worker for the deployment fence (HTTP ${http_code})." >&2
    rm -f "${response_file}"
    exit 1
  }
  droplet_count="$(jq -r '[.droplets[]?] | length' "${response_file}")"
  [[ "${droplet_count}" == "1" ]] || {
    echo "Expected exactly one persistent AMD worker for the deployment fence; found ${droplet_count}." >&2
    rm -f "${response_file}"
    exit 1
  }
  droplet_id="$(jq -r '.droplets[0].id | tostring' "${response_file}")"
  [[ "${droplet_id}" =~ ^[0-9]+$ ]] || {
    echo "The persistent AMD worker returned an invalid Droplet id." >&2
    rm -f "${response_file}"
    exit 1
  }

  now_epoch="$(date +%s)"
  conflicting_ids="$(jq -r --arg owner "${drain_id}" --argjson now "${now_epoch}" '
    [
      .droplets[0].tags[]?
      | try capture("^rukter-deploy-drain-(?<owner>[A-Za-z0-9_-]{12,64})-until-(?<expires>[0-9]{10,12})$") catch empty
      | select((.expires | tonumber) > $now and .owner != $owner)
      | .owner
    ] | unique | join(",")
  ' "${response_file}")"
  if [[ -n "${conflicting_ids}" ]]; then
    echo "Deployment drain is already owned by ${conflicting_ids}; refusing to replace another pipeline's fence." >&2
    rm -f "${response_file}"
    exit 1
  fi

  expires_epoch=$(( now_epoch + ttl_seconds ))
  tag_name="rukter-deploy-drain-${drain_id}-until-${expires_epoch}"
  payload="$(jq -cn --arg name "${tag_name}" '{name: $name}')"
  http_code="$(digitalocean_request POST /tags "${payload}" "${response_file}")"
  if [[ "${http_code}" != "200" && "${http_code}" != "201" && "${http_code}" != "422" ]]; then
    echo "Could not create the owned deployment TTL fence (HTTP ${http_code})." >&2
    rm -f "${response_file}"
    exit 1
  fi

  payload="$(jq -cn --arg id "${droplet_id}" '{resources: [{resource_id: $id, resource_type: "droplet"}]}')"
  http_code="$(digitalocean_request POST "/tags/${tag_name}/resources" "${payload}" "${response_file}")"
  if [[ "${http_code}" != "200" && "${http_code}" != "204" ]]; then
    echo "Could not attach the owned deployment TTL fence (HTTP ${http_code}); refusing to deploy." >&2
    rm -f "${response_file}"
    exit 1
  fi

  http_code="$(digitalocean_request GET "/droplets?tag_name=${encoded_tag}&per_page=200" '' "${response_file}")"
  [[ "${http_code}" == "200" ]] || {
    echo "Could not verify the persistent AMD worker after attaching the deployment fence (HTTP ${http_code})." >&2
    rm -f "${response_file}"
    exit 1
  }
  droplet_count="$(jq -r '[.droplets[]?] | length' "${response_file}")"
  [[ "${droplet_count}" == "1" && "$(jq -r '.droplets[0].id | tostring' "${response_file}")" == "${droplet_id}" ]] || {
    echo "The persistent AMD worker changed while the deployment fence was being attached; refusing to continue." >&2
    rm -f "${response_file}"
    exit 1
  }
  if ! jq -e --arg tag "${tag_name}" '(.droplets[0].tags // []) | index($tag) != null' "${response_file}" >/dev/null; then
    echo "DigitalOcean did not confirm the newly attached deployment fence; refusing to continue." >&2
    rm -f "${response_file}"
    exit 1
  fi
  conflicting_ids="$(jq -r --arg owner "${drain_id}" --argjson now "${now_epoch}" '
    [
      .droplets[0].tags[]?
      | try capture("^rukter-deploy-drain-(?<owner>[A-Za-z0-9_-]{12,64})-until-(?<expires>[0-9]{10,12})$") catch empty
      | select((.expires | tonumber) > $now and .owner != $owner)
      | .owner
    ] | unique | join(",")
  ' "${response_file}")"
  if [[ -n "${conflicting_ids}" ]]; then
    echo "A foreign deployment fence appeared during acquisition (${conflicting_ids}); keeping this TTL fence fail-closed." >&2
    rm -f "${response_file}"
    exit 1
  fi

  while IFS= read -r obsolete_tag; do
    [[ -n "${obsolete_tag}" ]] || continue
    remove_owned_durable_tag "${obsolete_tag}" "${droplet_id}"
  done < <(jq -r --arg owner "${drain_id}" --arg current "${tag_name}" '
    .droplets[0].tags[]? as $tag
    | try ($tag | capture("^rukter-deploy-drain-(?<owner>[A-Za-z0-9_-]{12,64})-until-(?<expires>[0-9]{10,12})$")) catch empty
    | select($tag != $current and .owner == $owner)
    | $tag
  ' "${response_file}")

  write_state "${mode}" "${drain_id}" "${tag_name}" "${droplet_id}"
  rm -f "${response_file}"
  echo "Attached owned deployment fence ${tag_name} to persistent AMD Droplet ${droplet_id}." >&2
}

release_all_owned_durable_tags() {
  local expected_droplet_id="${1:-}"
  local response_file http_code encoded_tag droplet_count droplet_id remaining
  response_file="$(mktemp)"
  encoded_tag="$(jq -rn --arg value "${persistent_tag}" '$value | @uri')"
  http_code="$(digitalocean_request GET "/droplets?tag_name=${encoded_tag}&per_page=200" '' "${response_file}")"
  [[ "${http_code}" == "200" ]] || {
    echo "Could not locate the persistent AMD worker while releasing the deployment fence (HTTP ${http_code})." >&2
    rm -f "${response_file}"
    exit 1
  }
  droplet_count="$(jq -r '[.droplets[]?] | length' "${response_file}")"
  [[ "${droplet_count}" == "1" ]] || {
    echo "Expected exactly one persistent AMD worker while releasing the deployment fence; found ${droplet_count}." >&2
    rm -f "${response_file}"
    exit 1
  }
  droplet_id="$(jq -r '.droplets[0].id | tostring' "${response_file}")"
  [[ -z "${expected_droplet_id}" || "${droplet_id}" == "${expected_droplet_id}" ]] || {
    echo "The persistent AMD worker changed before fence release; refusing to touch a different Droplet." >&2
    rm -f "${response_file}"
    exit 1
  }
  while IFS= read -r owned_tag; do
    [[ -n "${owned_tag}" ]] || continue
    remove_owned_durable_tag "${owned_tag}" "${droplet_id}"
  done < <(jq -r --arg owner "${drain_id}" '
    .droplets[0].tags[]? as $tag
    | try ($tag | capture("^rukter-deploy-drain-(?<owner>[A-Za-z0-9_-]{12,64})-until-(?<expires>[0-9]{10,12})$")) catch empty
    | select(.owner == $owner)
    | $tag
  ' "${response_file}")

  http_code="$(digitalocean_request GET "/droplets?tag_name=${encoded_tag}&per_page=200" '' "${response_file}")"
  [[ "${http_code}" == "200" ]] || {
    echo "Could not verify deployment fence release (HTTP ${http_code})." >&2
    rm -f "${response_file}"
    exit 1
  }
  droplet_count="$(jq -r '[.droplets[]?] | length' "${response_file}")"
  [[ "${droplet_count}" == "1" && "$(jq -r '.droplets[0].id | tostring' "${response_file}")" == "${droplet_id}" ]] || {
    echo "The persistent AMD worker changed while deployment fence release was being verified." >&2
    rm -f "${response_file}"
    exit 1
  }
  remaining="$(jq -r --arg owner "${drain_id}" '
    [
      .droplets[0].tags[]?
      | try capture("^rukter-deploy-drain-(?<owner>[A-Za-z0-9_-]{12,64})-until-(?<expires>[0-9]{10,12})$") catch empty
      | select(.owner == $owner)
    ] | length
  ' "${response_file}")"
  rm -f "${response_file}"
  [[ "${remaining}" == "0" ]] || {
    echo "DigitalOcean still reports ${remaining} tag(s) owned by ${drain_id}; refusing to claim release." >&2
    exit 1
  }
}

request() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local output_file="$4"
  local header_file curl_status
  local args=(
    -sS
    -o "${output_file}"
    -w '%{http_code}'
    -X "${method}"
  )
  if [[ "${edge_gate_required}" == "true" && ! -r "${edge_gate_state_file}" ]]; then
    echo "Deployment edge gate state is required; refusing an ungated app request." >&2
    return 1
  fi
  local edge_header_key=""
  local edge_header_value=""
  if [[ -r "${edge_gate_state_file}" ]]; then
    edge_header_key="$(jq -er '.header_key | select(type == "string" and test("^[A-Za-z0-9-]{1,128}$"))' "${edge_gate_state_file}")" || {
      echo "Deployment edge gate state has an invalid header key; refusing an ungated app request." >&2
      return 1
    }
    edge_header_value="$(jq -er '.header_value | select(type == "string" and test("^[A-Fa-f0-9]{64}$"))' "${edge_gate_state_file}")" || {
      echo "Deployment edge gate state has an invalid header value; refusing an ungated app request." >&2
      return 1
    }
  fi
  header_file="$(mktemp "${TMPDIR:-/tmp}/rukter-drain-headers.XXXXXX")"
  chmod 600 "${header_file}"
  {
    printf 'Accept: application/json\n'
    printf 'Authorization: Bearer %s\n' "${AMD_GPU_ORCHESTRATOR_TOKEN}"
    if [[ -n "${edge_header_key}" ]]; then
      printf '%s: %s\n' "${edge_header_key}" "${edge_header_value}"
    fi
    if [[ -n "${body}" ]]; then
      printf 'Content-Type: application/json\n'
    fi
  } > "${header_file}"
  args+=(--header "@${header_file}")
  if [[ -n "${body}" ]]; then
    args+=(--data-binary @-)
    if printf '%s' "${body}" | curl "${args[@]}" "${base_url%/}${path}"; then
      curl_status=0
    else
      curl_status=$?
    fi
  elif curl "${args[@]}" "${base_url%/}${path}"; then
    curl_status=0
  else
    curl_status=$?
  fi
  rm -f "${header_file}"
  return "${curl_status}"
}

require_token() {
  : "${AMD_GPU_ORCHESTRATOR_TOKEN:?AMD_GPU_ORCHESTRATOR_TOKEN is required}"
}

detect_app_mode() {
  local response_file http_code
  require_token
  response_file="$(mktemp)"
  http_code="$(request GET /v1/deployment-drain '' "${response_file}")"
  if [[ "${http_code}" == "200" ]]; then
    if jq -e '.supported == true' "${response_file}" >/dev/null; then
      rm -f "${response_file}"
      printf 'active\n'
      return 0
    fi
    echo "Production returned the deployment endpoint without declaring support; refusing to deploy." >&2
    rm -f "${response_file}"
    exit 1
  fi
  rm -f "${response_file}"
  if [[ ( "${http_code}" == "404" || "${http_code}" == "405" ) && "${require_supported}" != "true" ]] && is_pinned_legacy_rollout; then
    if [[ -z "${CI_COMMIT_SHA:-}" || "${bootstrap_approved_sha}" != "${CI_COMMIT_SHA}" ]]; then
      echo "The one-time legacy rollout cannot prove that no completed-result viewer is active. Close active Rukter tabs, then run this exact SHA with DEPLOYMENT_DRAIN_BOOTSTRAP_APPROVED_SHA=${CI_COMMIT_SHA:-unknown}; refusing any production mutation." >&2
      exit 1
    fi
    printf 'legacy\n'
    return 0
  fi
  if [[ ( "${http_code}" == "404" || "${http_code}" == "405" ) && "${require_supported}" == "true" ]]; then
    echo "The post-apply app does not expose the required deployment-drain API; refusing further deployment work." >&2
    exit 1
  fi
  echo "Deployment drain status failed with HTTP ${http_code}; refusing to deploy." >&2
  exit 1
}

verify_active_app_fence() {
  local operation="$1"
  local response_file http_code deadline
  require_token
  response_file="$(mktemp)"
  deadline=$(( $(date +%s) + ${DEPLOYMENT_DRAIN_VISIBILITY_WAIT_SECONDS:-60} ))
  while true; do
    http_code="$(request GET /v1/deployment-drain '' "${response_file}")"
    if [[ "${http_code}" == "200" ]] && jq -e --arg id "${drain_id}" '
      .supported == true
      and .active == true
      and .admissionLocked == true
      and (if (.drainIds | type) == "array"
        then ((.drainIds | length) == 1 and .drainIds[0] == $id)
        else .drainId == $id
      end)
    ' "${response_file}" >/dev/null; then
      jq -r --arg operation "${operation}" '"Deployment drain \($operation): id=\(.drainId // "owned") state=\(.state) expiresAt=\(.expiresAt)"' "${response_file}"
      rm -f "${response_file}"
      return 0
    fi
    if (( $(date +%s) >= deadline )); then
      echo "Production did not confirm this pipeline's durable deployment fence after ${operation}; refusing to continue." >&2
      jq '{supported,active,state,drainId,drainIds,expiresAt,admissionLocked}' "${response_file}" >&2 2>/dev/null || true
      rm -f "${response_file}"
      exit 1
    fi
    sleep "${DEPLOYMENT_DRAIN_VISIBILITY_POLL_SECONDS:-3}"
  done
}

acquire_or_renew() {
  local operation="$1"
  local mode state_id
  if [[ "${operation}" == "renew" ]]; then
    mode="$(read_state_value mode || true)"
    state_id="$(read_state_value drain_id || true)"
    [[ ( "${mode}" == "active" || "${mode}" == "legacy" ) && -n "${state_id}" ]] || {
      echo "Cannot renew deployment drain without an owned state file." >&2
      exit 1
    }
    drain_id="${state_id}"
  else
    mode="$(detect_app_mode)"
  fi

  acquire_durable_fence "${mode}"
  if [[ "${mode}" == "active" ]]; then
    verify_active_app_fence "${operation}"
  else
    echo "The pre-drain production release does not expose the drain API. This one bootstrap pipeline holds a durable TTL tag and requires a long continuous idle window; later commits fail closed." >&2
  fi
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
  jq '{supported,active,state,drainIds,expiresAt,admissionLocked,activeAdmittedRequests,activeUserSessions,quietForSeconds,workerActivity,queue,readyForDeploy,checkedAt}' "${response_file}"
  rm -f "${response_file}"
}

assert_ready() {
  local state_mode state_id response_file http_code
  state_mode="$(read_state_value mode || true)"
  state_id="$(read_state_value drain_id || true)"
  [[ ( "${state_mode}" == "active" || "${state_mode}" == "legacy" ) && -n "${state_id}" ]] || {
    echo "Cannot assert deployment readiness without an owned state file." >&2
    exit 1
  }
  [[ "${state_id}" == "${drain_id}" ]] || {
    echo "Deployment drain readiness state belongs to a different owner." >&2
    exit 1
  }
  if [[ "${state_mode}" == "legacy" ]]; then
    echo "Legacy drain mode has no protected readiness endpoint; preserving the required gated continuous-idle proof."
    return 0
  fi

  require_token
  response_file="$(mktemp)"
  http_code="$(request GET /v1/deployment-drain '' "${response_file}")"
  [[ "${http_code}" == "200" ]] || {
    echo "Deployment readiness assertion failed with HTTP ${http_code}; refusing to continue." >&2
    rm -f "${response_file}"
    exit 1
  }

  # readyForDeploy is the server's strict quiet-window result. The explicit
  # no-work branch deliberately ignores quietForSeconds so a freshly deployed
  # app can reset its quiet timer without making an actually idle apply fail.
  # Every live work signal must be present and zero in that fallback branch.
  if ! jq -e --arg id "${drain_id}" '
    .supported == true
    and .active == true
    and .admissionLocked == true
    and .drainId == $id
    and ((.drainIds | type) == "array" and (.drainIds | length) == 1 and .drainIds[0] == $id)
    and (
      .readyForDeploy == true
      or (
        .activeAdmittedRequests == 0
        and .activeUserSessions == 0
        and (.queue | type) == "object"
        and .queue.activeJobPresent == false
        and .queue.queuedJobs == 0
        and .queue.readyJobs == 0
        and .queue.preparingJobs == 0
        and .queue.inProgressJobs == 0
        and .queue.activeStoryJobs == 0
        and .queue.amdInProgressJobs == 0
        and .queue.fastStoryJobs == 0
        and .queue.planningJobs == 0
        and .queue.awaitingApprovalJobs == 0
        and .workerActivity.reachable == true
        and .workerActivity.verifiable == true
        and .workerActivity.idle == true
      )
    )
  ' "${response_file}" >/dev/null; then
    echo "Deployment readiness changed: exact ownership, admission lock, users, requests, queue, or worker idle evidence is no longer safe." >&2
    jq '{supported,active,state,drainId,drainIds,admissionLocked,activeAdmittedRequests,activeUserSessions,workerActivity,queue,readyForDeploy,checkedAt}' "${response_file}" >&2 2>/dev/null || true
    rm -f "${response_file}"
    exit 1
  fi
  jq -r '"Deployment readiness asserted: owner=\(.drainId) users=\(.activeUserSessions) admitted=\(.activeAdmittedRequests) ready=\(.readyForDeploy)."' "${response_file}"
  rm -f "${response_file}"
}

release_drain() {
  local state_mode="" state_id="" expected_droplet_id=""
  [[ ! -L "${state_file}" ]] || {
    echo "Refusing to release a deployment drain using symbolic-link state." >&2
    exit 1
  }
  if [[ -e "${state_file}" ]]; then
    [[ -f "${state_file}" && -r "${state_file}" ]] || {
      echo "Deployment drain state exists but is not a readable regular file; refusing release." >&2
      exit 1
    }
    state_mode="$(read_state_value mode)"
    state_id="$(read_state_value drain_id)"
    expected_droplet_id="$(read_state_value droplet_id)"
    [[ ( "${state_mode}" == "active" || "${state_mode}" == "legacy" ) && -n "${state_id}" && "${expected_droplet_id}" =~ ^[0-9]+$ ]] || {
      echo "Deployment drain state is incomplete; refusing release." >&2
      exit 1
    }
    [[ "${state_id}" == "${drain_id}" ]] || {
      echo "Deployment drain state belongs to a different owner; refusing release." >&2
      exit 1
    }
  else
    echo "Deployment drain state is absent; recovering release for current owner ${drain_id} from the persistent Droplet tags." >&2
  fi
  release_all_owned_durable_tags "${expected_droplet_id}"
  echo "Released deployment drain ${drain_id} after app and persistent worker verification succeeded."
}

case "${action}" in
  acquire|renew)
    acquire_or_renew "${action}"
    ;;
  status)
    show_status
    ;;
  assert-ready)
    assert_ready
    ;;
  release)
    release_drain
    ;;
  *)
    usage
    ;;
esac
