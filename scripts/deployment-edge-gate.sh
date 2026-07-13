#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "${script_dir}/assert-production-targets.sh"

action="${1:-}"
cloudflare_api_url="${DEPLOYMENT_EDGE_GATE_API_URL:-https://api.cloudflare.com/client/v4}"
cloudflare_token="${RUKTER_AI_CLOUDFLARE_API_TOKEN:-}"
zone_name="${DEPLOYMENT_EDGE_GATE_ZONE_NAME:-rukter.ai}"
public_url="${DEPLOYMENT_EDGE_GATE_PUBLIC_URL:-${RUKTER_AI_PUBLIC_URL:-https://rukter.ai}}"
production_mode="${DEPLOYMENT_EDGE_GATE_PRODUCTION:-false}"
test_mode="${DEPLOYMENT_EDGE_GATE_TEST_MODE:-false}"
state_file="${DEPLOYMENT_EDGE_GATE_STATE_FILE:-.ci-artifacts/deployment-edge-gate.json}"
ttl_seconds="${DEPLOYMENT_EDGE_GATE_TTL_SECONDS:-21600}"
verify_attempts="${DEPLOYMENT_EDGE_GATE_VERIFY_ATTEMPTS:-60}"
verify_interval_seconds="${DEPLOYMENT_EDGE_GATE_VERIFY_INTERVAL_SECONDS:-2}"
current_owner="${DEPLOYMENT_EDGE_GATE_OWNER:-rukter-ci-${CI_COMMIT_SHA:-${CI_PIPELINE_ID:-manual-run}}}"
phase_name="http_request_firewall_custom"
rule_ref_prefix="rukter_deploy_gate_"
description_prefix="Rukter deploy gate"

usage() {
  echo "Usage: $0 acquire|renew|status|release" >&2
  exit 2
}

require_runtime() {
  : "${cloudflare_token:?RUKTER_AI_CLOUDFLARE_API_TOKEN is required to control the rukter.ai edge gate}"
  command -v curl >/dev/null 2>&1 || { echo "curl is required." >&2; exit 2; }
  command -v jq >/dev/null 2>&1 || { echo "jq is required." >&2; exit 2; }
  command -v node >/dev/null 2>&1 || { echo "node is required to derive the owned gate credential." >&2; exit 2; }
  [[ "${production_mode}" == "true" || "${production_mode}" == "false" ]] || {
    echo "DEPLOYMENT_EDGE_GATE_PRODUCTION must be true or false." >&2
    exit 2
  }
  [[ "${test_mode}" == "true" || "${test_mode}" == "false" ]] || {
    echo "DEPLOYMENT_EDGE_GATE_TEST_MODE must be true or false." >&2
    exit 2
  }
  if [[ "${test_mode}" == "true" ]]; then
    [[ "${production_mode}" == "false" && "${CI:-}" != "true" && "${GITLAB_CI:-}" != "true" ]] || {
      echo "Deployment edge gate test overrides are forbidden in CI or production mode." >&2
      exit 2
    }
  else
    [[ "${cloudflare_api_url}" == "https://api.cloudflare.com/client/v4" ]] || {
      echo "Production deployment edge gate requires the official Cloudflare API URL." >&2
      exit 2
    }
    [[ "${zone_name}" == "rukter.ai" ]] || {
      echo "Production deployment edge gate requires the exact rukter.ai zone." >&2
      exit 2
    }
    [[ "${public_url}" == "https://rukter.ai" ]] || {
      echo "Production deployment edge gate requires the exact https://rukter.ai public URL." >&2
      exit 2
    }
  fi
  if [[ "${production_mode}" == "true" ]]; then
    [[ "${RUKTER_AI_PUBLIC_URL:-}" == "https://rukter.ai" ]] || {
      echo "Production deployment edge gate requires RUKTER_AI_PUBLIC_URL=https://rukter.ai." >&2
      exit 2
    }
    [[ "${DEPLOYMENT_EDGE_GATE_PUBLIC_URL:-}" == "https://rukter.ai" ]] || {
      echo "Production deployment edge gate requires DEPLOYMENT_EDGE_GATE_PUBLIC_URL=https://rukter.ai." >&2
      exit 2
    }
  fi
  (( ${#cloudflare_token} >= 20 && ${#cloudflare_token} <= 512 )) \
    && [[ "${cloudflare_token}" =~ ^[A-Za-z0-9._~-]+$ ]] || {
    echo "RUKTER_AI_CLOUDFLARE_API_TOKEN has an invalid format." >&2
    exit 2
  }
  [[ "${zone_name}" =~ ^[A-Za-z0-9.-]{3,253}$ ]] || {
    echo "Deployment edge gate zone name is invalid." >&2
    exit 2
  }
  [[ "${ttl_seconds}" =~ ^[0-9]+$ ]] && (( ttl_seconds >= 300 && ttl_seconds <= 21600 )) || {
    echo "Deployment edge gate TTL must be between 300 and 21600 seconds." >&2
    exit 2
  }
  [[ "${verify_attempts}" =~ ^[0-9]+$ ]] && (( verify_attempts >= 1 && verify_attempts <= 300 )) || {
    echo "Deployment edge gate verification attempts must be between 1 and 300." >&2
    exit 2
  }
  [[ "${verify_interval_seconds}" =~ ^[0-9]+$ ]] && (( verify_interval_seconds <= 30 )) || {
    echo "Deployment edge gate verification interval must be between 0 and 30 seconds." >&2
    exit 2
  }
}

validate_owner() {
  local owner="$1"
  [[ "${owner}" =~ ^[A-Za-z0-9-]{12,64}$ ]] || {
    echo "Deployment edge gate owner must contain 12 to 64 letters, numbers, or dashes." >&2
    exit 2
  }
}

sha256_string() {
  local input="$1"
  DEPLOYMENT_EDGE_GATE_HASH_INPUT="${input}" \
    node -e 'const crypto = require("node:crypto"); process.stdout.write(crypto.createHash("sha256").update(process.env.DEPLOYMENT_EDGE_GATE_HASH_INPUT).digest("hex"))'
}

owner_fingerprint() {
  sha256_string "$1" | cut -c1-16
}

rule_ref_for_owner() {
  printf '%s%s' "${rule_ref_prefix}" "$(owner_fingerprint "$1")"
}

header_key_for_owner() {
  printf 'X-Rukter-Deploy-Gate-%s' "$(owner_fingerprint "$1")"
}

header_value_for_owner() {
  local owner="$1"
  local header_key
  header_key="$(header_key_for_owner "${owner}")"
  RUKTER_AI_CLOUDFLARE_API_TOKEN="${cloudflare_token}" DEPLOYMENT_EDGE_GATE_HEADER_KEY="${header_key}" \
    node -e 'const crypto = require("node:crypto"); process.stdout.write(crypto.createHmac("sha256", process.env.RUKTER_AI_CLOUDFLARE_API_TOKEN).update(process.env.DEPLOYMENT_EDGE_GATE_HEADER_KEY).digest("hex"))'
}

description_for_owner() {
  local owner="$1"
  local expires_epoch="$2"
  printf '%s owner=%s expires=%s' "${description_prefix}" "${owner}" "${expires_epoch}"
}

expression_with_header_value() {
  local owner="$1"
  local expires_epoch="$2"
  local header_value="$3"
  local header_key header_name upload_source_exemption amd_worker_source_exemption
  header_key="$(header_key_for_owner "${owner}")"
  header_name="$(printf '%s' "${header_key}" | tr '[:upper:]' '[:lower:]')"
  # Keep source reads available to the already-admitted AMD worker without a
  # paid-plan regex. Cloudflare's WAF API accepts normalized URI fields here;
  # the path must be one UUID-shaped filename segment, and encoded/path
  # traversal characters are forbidden before the request reaches the origin.
  upload_source_exemption='(starts_with(http.request.uri.path, "/uploads/") and len(http.request.uri.path) in {49 50} and http.request.uri.path.extension in {"png" "jpg" "webp" "avif" "gif" "mp4"} and substring(http.request.uri.path, 17, 18) eq "-" and substring(http.request.uri.path, 22, 23) eq "-" and substring(http.request.uri.path, 27, 28) eq "-" and substring(http.request.uri.path, 32, 33) eq "-" and substring(http.request.uri.path, 45, 46) eq "." and not (substring(http.request.uri.path, 9) contains "/") and not (substring(http.request.uri.path, 9) contains "%") and not (substring(http.request.uri.path, 9) contains "\\") and not (substring(http.request.uri.path, 9) contains ".."))'
  amd_worker_source_exemption='(http.request.uri.path in {"/amd-worker/bootstrap.sh" "/amd-worker/app.py" "/amd-worker/gpu_telemetry.py" "/amd-worker/identity_guard.py" "/amd-worker/requirements.txt" "/amd-worker/run_story_pipeline.py" "/amd-worker/run_story_pipeline.sh"})'
  printf '(http.host in {"%s" "www.%s"} and http.request.timestamp.sec lt %s and not any(http.request.headers["%s"][*] eq "%s") and not ((http.request.method in {"GET" "HEAD"}) and (%s or %s)) and not (http.request.method eq "POST" and http.request.uri.path eq "/api/amd-story-assets") and not (http.request.method eq "POST" and http.request.uri.path eq "/api/story-presence"))' \
    "${zone_name}" "${zone_name}" "${expires_epoch}" "${header_name}" "${header_value}" \
    "${upload_source_exemption}" "${amd_worker_source_exemption}"
}

expression_for_owner() {
  local owner="$1"
  local expires_epoch="$2"
  expression_with_header_value "${owner}" "${expires_epoch}" "$(header_value_for_owner "${owner}")"
}

rule_definition() {
  local owner="$1"
  local expires_epoch="$2"
  local expression description ref
  expression="$(expression_for_owner "${owner}" "${expires_epoch}")"
  description="$(description_for_owner "${owner}" "${expires_epoch}")"
  ref="$(rule_ref_for_owner "${owner}")"
  jq -cn \
    --arg expression "${expression}" \
    --arg description "${description}" \
    --arg ref "${ref}" \
    '{
      action: "block",
      expression: $expression,
      description: $description,
      ref: $ref,
      enabled: true,
      position: {index: 1}
    }'
}

state_mode() {
  if stat -f '%Lp' "${state_file}" >/dev/null 2>&1; then
    stat -f '%Lp' "${state_file}"
  else
    stat -c '%a' "${state_file}"
  fi
}

write_state() {
  local owner="$1"
  local zone_id="$2"
  local ruleset_id="$3"
  local rule_id="$4"
  local expires_epoch="$5"
  local state_dir state_tmp
  local rule_ref header_key header_value
  rule_ref="$(rule_ref_for_owner "${owner}")"
  header_key="$(header_key_for_owner "${owner}")"
  header_value="$(header_value_for_owner "${owner}")"
  state_dir="$(dirname "${state_file}")"
  mkdir -p "${state_dir}"
  [[ ! -L "${state_file}" ]] || {
    echo "Refusing to write deployment edge gate state through a symbolic link." >&2
    exit 1
  }
  umask 077
  state_tmp="$(mktemp "${state_file}.tmp.XXXXXX")"
  jq -n \
    --arg owner "${owner}" \
    --arg zone_name "${zone_name}" \
    --arg zone_id "${zone_id}" \
    --arg ruleset_id "${ruleset_id}" \
    --arg rule_id "${rule_id}" \
    --arg rule_ref "${rule_ref}" \
    --arg header_key "${header_key}" \
    --arg header_value "${header_value}" \
    --argjson expires_epoch "${expires_epoch}" \
    '{
      schema_version: 1,
      owner: $owner,
      zone_name: $zone_name,
      zone_id: $zone_id,
      ruleset_id: $ruleset_id,
      rule_id: $rule_id,
      rule_ref: $rule_ref,
      header_key: $header_key,
      header_value: $header_value,
      expires_epoch: $expires_epoch
    }' > "${state_tmp}"
  chmod 600 "${state_tmp}"
  mv "${state_tmp}" "${state_file}"
  chmod 600 "${state_file}"
}

load_state() {
  [[ -f "${state_file}" && ! -L "${state_file}" && -r "${state_file}" ]] || {
    echo "Deployment edge gate state is unavailable; refusing an unowned operation." >&2
    exit 1
  }
  [[ "$(state_mode)" == "600" ]] || {
    echo "Deployment edge gate state permissions must be 600." >&2
    exit 1
  }
  jq -e --arg ref_prefix "${rule_ref_prefix}" '
    .schema_version == 1
    and (.owner | type == "string" and test("^[A-Za-z0-9-]{12,64}$"))
    and (.zone_name | type == "string" and test("^[A-Za-z0-9.-]{3,253}$"))
    and (.zone_id | type == "string" and test("^[a-f0-9]{32}$"))
    and (.ruleset_id | type == "string" and test("^[a-f0-9]{32}$"))
    and (.rule_id | type == "string" and test("^[a-f0-9]{32}$"))
    and (.rule_ref | type == "string" and startswith($ref_prefix) and test("^[a-z0-9_]{20,50}$"))
    and (.header_key | type == "string" and test("^[A-Za-z0-9-]{20,128}$"))
    and (.header_value | type == "string" and test("^[a-f0-9]{64}$"))
    and ((.expires_epoch | type) == "number")
    and (.expires_epoch >= 1000000000 and .expires_epoch <= 999999999999)
    and (has("ruleset") | not)
    and (has("expression") | not)
  ' "${state_file}" >/dev/null || {
    echo "Deployment edge gate state failed strict validation." >&2
    exit 1
  }

  state_owner="$(jq -r '.owner' "${state_file}")"
  state_zone_name="$(jq -r '.zone_name' "${state_file}")"
  state_zone_id="$(jq -r '.zone_id' "${state_file}")"
  state_ruleset_id="$(jq -r '.ruleset_id' "${state_file}")"
  state_rule_id="$(jq -r '.rule_id' "${state_file}")"
  state_rule_ref="$(jq -r '.rule_ref' "${state_file}")"
  state_header_key="$(jq -r '.header_key' "${state_file}")"
  state_header_value="$(jq -r '.header_value' "${state_file}")"
  state_expires_epoch="$(jq -r '.expires_epoch | floor' "${state_file}")"

  validate_owner "${state_owner}"
  [[ "${state_owner}" == "${current_owner}" ]] || {
    echo "Deployment edge gate state belongs to a different pipeline owner." >&2
    exit 1
  }
  [[ "${state_zone_name}" == "${zone_name}" ]] || {
    echo "Deployment edge gate state belongs to a different Cloudflare zone." >&2
    exit 1
  }
  [[ "${state_rule_ref}" == "$(rule_ref_for_owner "${state_owner}")" ]] || {
    echo "Deployment edge gate state has an invalid owner reference." >&2
    exit 1
  }
  [[ "${state_header_key}" == "$(header_key_for_owner "${state_owner}")" ]] || {
    echo "Deployment edge gate state has an invalid owner header." >&2
    exit 1
  }
  [[ "${state_header_value}" == "$(header_value_for_owner "${state_owner}")" ]] || {
    echo "Deployment edge gate state cannot be recovered with this Cloudflare token." >&2
    exit 1
  }
}

cloudflare_request() {
  local method="$1"
  local path="$2"
  local output_file="$3"
  local body="${4:-}"
  local header_file curl_status
  local args=(
    --connect-timeout 5
    --max-time 30
    -sS
    -o "${output_file}"
    -w '%{http_code}'
    -X "${method}"
  )
  header_file="$(mktemp "${TMPDIR:-/tmp}/rukter-cloudflare-headers.XXXXXX")"
  chmod 600 "${header_file}"
  {
    printf 'Accept: application/json\n'
    printf 'Authorization: Bearer %s\n' "${cloudflare_token}"
    if [[ -n "${body}" ]]; then
      printf 'Content-Type: application/json\n'
    fi
  } > "${header_file}"
  args+=(--header "@${header_file}")
  if [[ -n "${body}" ]]; then
    args+=(--data-binary @-)
    if printf '%s' "${body}" | curl "${args[@]}" "${cloudflare_api_url%/}${path}"; then
      curl_status=0
    else
      curl_status=$?
    fi
  elif curl "${args[@]}" "${cloudflare_api_url%/}${path}"; then
    curl_status=0
  else
    curl_status=$?
  fi
  rm -f "${header_file}"
  return "${curl_status}"
}

cloudflare_failure() {
  local operation="$1"
  local http_code="$2"
  local response_file="$3"
  local codes details
  codes="$(jq -r '[.errors[]?.code | tostring] | join(",")' "${response_file}" 2>/dev/null || true)"
  echo "Cloudflare ${operation} failed (HTTP ${http_code}${codes:+; error codes ${codes}})." >&2
  details="$(jq -r '(.errors // [])[]? | .message // empty' "${response_file}" 2>/dev/null \
    | sed -E 's/[a-f0-9]{64}/[redacted-64-hex]/g; s/cfut_[A-Za-z0-9._~-]+/[redacted-token]/g' \
    | sed -n '1,8p' || true)"
  if [[ -n "${details}" ]]; then
    while IFS= read -r detail; do
      [[ -n "${detail}" ]] && echo "Cloudflare ${operation} detail: ${detail}" >&2
    done <<<"${details}"
  fi
}

find_zone_id() {
  local response_file http_code encoded_zone count total zone_id
  response_file="$(mktemp)"
  encoded_zone="$(jq -rn --arg value "${zone_name}" '$value | @uri')"
  http_code="$(cloudflare_request GET "/zones?name=${encoded_zone}&status=active&per_page=50" "${response_file}")"
  [[ "${http_code}" == "200" ]] || {
    cloudflare_failure "zone lookup" "${http_code}" "${response_file}"
    rm -f "${response_file}"
    exit 1
  }
  jq -e '.success == true and (.result | type == "array")' "${response_file}" >/dev/null || {
    echo "Cloudflare zone response was malformed." >&2
    rm -f "${response_file}"
    exit 1
  }
  count="$(jq -r --arg name "${zone_name}" '[.result[]? | select(.name == $name and .status == "active")] | length' "${response_file}")"
  total="$(jq -r '.result_info.total_count // (.result | length)' "${response_file}")"
  [[ "${count}" == "1" && "${total}" == "1" ]] || {
    echo "Expected exactly one active Cloudflare zone named ${zone_name}; found ${count} of ${total} visible zones." >&2
    rm -f "${response_file}"
    exit 1
  }
  zone_id="$(jq -r --arg name "${zone_name}" '.result[] | select(.name == $name and .status == "active") | .id' "${response_file}")"
  rm -f "${response_file}"
  [[ "${zone_id}" =~ ^[a-f0-9]{32}$ ]] || {
    echo "Cloudflare returned an invalid zone id." >&2
    exit 1
  }
  printf '%s' "${zone_id}"
}

read_entrypoint() {
  local zone_id="$1"
  local allow_create="$2"
  local response_file http_code body
  response_file="$(mktemp)"
  http_code="$(cloudflare_request GET "/zones/${zone_id}/rulesets/phases/${phase_name}/entrypoint" "${response_file}")"
  if [[ "${http_code}" == "404" && "${allow_create}" == "true" ]]; then
    body="$(jq -cn --arg phase "${phase_name}" '{name: "Rukter production firewall", description: "Rukter zone custom firewall entrypoint", kind: "zone", phase: $phase}')"
    http_code="$(cloudflare_request POST "/zones/${zone_id}/rulesets" "${response_file}" "${body}")"
    if [[ "${http_code}" != "200" && "${http_code}" != "201" && "${http_code}" != "409" ]]; then
      cloudflare_failure "entrypoint creation" "${http_code}" "${response_file}"
      rm -f "${response_file}"
      exit 1
    fi
    http_code="$(cloudflare_request GET "/zones/${zone_id}/rulesets/phases/${phase_name}/entrypoint" "${response_file}")"
  fi
  if [[ "${http_code}" == "404" ]]; then
    rm -f "${response_file}"
    return 4
  fi
  [[ "${http_code}" == "200" ]] || {
    cloudflare_failure "entrypoint lookup" "${http_code}" "${response_file}"
    rm -f "${response_file}"
    exit 1
  }
  jq -e --arg phase "${phase_name}" '
    .success == true
    and (.result.id | type == "string" and test("^[a-f0-9]{32}$"))
    and .result.kind == "zone"
    and .result.phase == $phase
    and ((.result.rules // []) | type == "array")
  ' "${response_file}" >/dev/null || {
    echo "Cloudflare custom-firewall entrypoint response was malformed." >&2
    rm -f "${response_file}"
    exit 1
  }
  jq -c '.result | .rules = (.rules // [])' "${response_file}"
  rm -f "${response_file}"
}

fetch_ruleset() {
  local zone_id="$1"
  local ruleset_id="$2"
  local response_file http_code
  response_file="$(mktemp)"
  http_code="$(cloudflare_request GET "/zones/${zone_id}/rulesets/${ruleset_id}" "${response_file}")"
  [[ "${http_code}" == "200" ]] || {
    cloudflare_failure "ruleset lookup" "${http_code}" "${response_file}"
    rm -f "${response_file}"
    exit 1
  }
  jq -e --arg id "${ruleset_id}" --arg phase "${phase_name}" '
    .success == true
    and .result.id == $id
    and .result.kind == "zone"
    and .result.phase == $phase
    and ((.result.rules // []) | type == "array")
  ' "${response_file}" >/dev/null || {
    echo "Cloudflare ruleset response was malformed or changed scope." >&2
    rm -f "${response_file}"
    exit 1
  }
  jq -c '.result | .rules = (.rules // [])' "${response_file}"
  rm -f "${response_file}"
}

expected_rule_matches() {
  local rule_json="$1"
  local owner="$2"
  local expires_epoch="$3"
  local expected
  expected="$(rule_definition "${owner}" "${expires_epoch}")"
  jq -e --argjson expected "${expected}" '
    .action == $expected.action
    and .expression == $expected.expression
    and .description == $expected.description
    and .ref == $expected.ref
    and .enabled == true
  ' <<<"${rule_json}" >/dev/null
}

reserved_rule_static_shape_matches() {
  local rule_json="$1"
  local owner="$2"
  local expires_epoch="$3"
  local expression header_key header_name header_marker header_remainder embedded_header_value expected_expression
  expression="$(jq -er '.expression | select(type == "string")' <<<"${rule_json}")" || return 1
  header_key="$(header_key_for_owner "${owner}")"
  header_name="$(printf '%s' "${header_key}" | tr '[:upper:]' '[:lower:]')"
  header_marker="http.request.headers[\"${header_name}\"][*] eq \""
  [[ "${expression}" == *"${header_marker}"* ]] || return 1
  header_remainder="${expression#*"${header_marker}"}"
  embedded_header_value="${header_remainder%%\"*}"
  [[ "${embedded_header_value}" =~ ^[a-f0-9]{64}$ ]] || return 1
  expected_expression="$(expression_with_header_value "${owner}" "${expires_epoch}" "${embedded_header_value}")"
  jq -e \
    --arg expression "${expected_expression}" \
    --arg description "$(description_for_owner "${owner}" "${expires_epoch}")" \
    --arg ref "$(rule_ref_for_owner "${owner}")" '
      .action == "block"
      and .expression == $expression
      and .description == $description
      and .ref == $ref
      and .enabled == true
    ' <<<"${rule_json}" >/dev/null
}

parse_owned_rule() {
  local rule_json="$1"
  local description ref owner expires_epoch expected_ref
  description="$(jq -r '.description // ""' <<<"${rule_json}")"
  ref="$(jq -r '.ref // ""' <<<"${rule_json}")"
  if [[ ! "${description}" =~ ^Rukter\ deploy\ gate\ owner=([A-Za-z0-9-]{12,64})\ expires=([0-9]{10,12})$ ]]; then
    echo "A reserved Cloudflare deployment rule has invalid ownership metadata; refusing to modify it." >&2
    return 1
  fi
  owner="${BASH_REMATCH[1]}"
  expires_epoch="${BASH_REMATCH[2]}"
  validate_owner "${owner}"
  expected_ref="$(rule_ref_for_owner "${owner}")"
  [[ "${ref}" == "${expected_ref}" ]] || {
    echo "A reserved Cloudflare deployment rule has a mismatched owner reference; refusing to modify it." >&2
    return 1
  }
  PARSED_RULE_OWNER="${owner}"
  PARSED_RULE_EXPIRES="${expires_epoch}"
}

delete_rule() {
  local zone_id="$1"
  local ruleset_id="$2"
  local rule_id="$3"
  local response_file http_code
  response_file="$(mktemp)"
  http_code="$(cloudflare_request DELETE "/zones/${zone_id}/rulesets/${ruleset_id}/rules/${rule_id}" "${response_file}")"
  if [[ "${http_code}" != "200" && "${http_code}" != "204" && "${http_code}" != "404" ]]; then
    cloudflare_failure "owned rule deletion" "${http_code}" "${response_file}"
    rm -f "${response_file}"
    return 1
  fi
  rm -f "${response_file}"
}

reconcile_gate_rules() {
  local zone_id="$1"
  local ruleset_id="$2"
  local ruleset_json rule_json rule_id ref now owned_count foreign_owners expired_rule_id rule_index
  local -a expired_rule_ids
  while true; do
    RECONCILED_RULE_ID=""
    RECONCILED_RULE_EXPIRES=""
    RECONCILED_RULE_INDEX=""
    now="$(date +%s)"
    ruleset_json="$(fetch_ruleset "${zone_id}" "${ruleset_id}")"
    expired_rule_ids=()
    owned_count=0
    foreign_owners=""
    rule_index=0
    while IFS= read -r encoded_rule; do
      [[ -n "${encoded_rule}" ]] || continue
      rule_index=$(( rule_index + 1 ))
      rule_json="$(jq -rn --arg value "${encoded_rule}" '$value | @base64d')"
      ref="$(jq -r '.ref // ""' <<<"${rule_json}")"
      [[ "${ref}" == "${rule_ref_prefix}"* ]] || continue
      rule_id="$(jq -r '.id // ""' <<<"${rule_json}")"
      [[ "${rule_id}" =~ ^[a-f0-9]{32}$ ]] || {
        echo "A reserved Cloudflare deployment rule has an invalid id." >&2
        exit 1
      }
      parse_owned_rule "${rule_json}"
      if (( PARSED_RULE_EXPIRES <= now )); then
        reserved_rule_static_shape_matches "${rule_json}" "${PARSED_RULE_OWNER}" "${PARSED_RULE_EXPIRES}" || {
          echo "An expired reserved Cloudflare deployment rule has an invalid static shape; refusing to modify it." >&2
          exit 1
        }
        expired_rule_ids+=("${rule_id}")
        continue
      fi
      expected_rule_matches "${rule_json}" "${PARSED_RULE_OWNER}" "${PARSED_RULE_EXPIRES}" || {
        echo "A fresh reserved Cloudflare deployment rule was altered or signed by another token; refusing to modify it." >&2
        exit 1
      }
      if [[ "${PARSED_RULE_OWNER}" == "${current_owner}" ]]; then
        owned_count=$(( owned_count + 1 ))
        RECONCILED_RULE_ID="${rule_id}"
        RECONCILED_RULE_EXPIRES="${PARSED_RULE_EXPIRES}"
        RECONCILED_RULE_INDEX="${rule_index}"
      else
        foreign_owners="${foreign_owners}${foreign_owners:+,}${PARSED_RULE_OWNER}"
      fi
    done < <(jq -r '.rules[]? | @base64' <<<"${ruleset_json}")
    [[ -z "${foreign_owners}" ]] || {
      echo "Cloudflare deployment admission is already owned by ${foreign_owners}; refusing to replace a fresh foreign gate." >&2
      exit 1
    }
    [[ "${owned_count}" -le 1 ]] || {
      echo "Cloudflare reports multiple fresh deployment rules for this owner; refusing an ambiguous mutation." >&2
      exit 1
    }
    if (( ${#expired_rule_ids[@]} > 0 )); then
      for expired_rule_id in "${expired_rule_ids[@]}"; do
        delete_rule "${zone_id}" "${ruleset_id}" "${expired_rule_id}"
      done
      continue
    fi
    return 0
  done
}

mutate_rule() {
  local method="$1"
  local zone_id="$2"
  local ruleset_id="$3"
  local rule_id="$4"
  local owner="$5"
  local expires_epoch="$6"
  local move_to_first="${7:-true}"
  local response_file http_code body path
  response_file="$(mktemp)"
  body="$(rule_definition "${owner}" "${expires_epoch}")"
  if [[ "${method}" == "POST" ]]; then
    path="/zones/${zone_id}/rulesets/${ruleset_id}/rules"
  else
    path="/zones/${zone_id}/rulesets/${ruleset_id}/rules/${rule_id}"
    if [[ "${move_to_first}" != "true" || "${RECONCILED_RULE_INDEX:-}" == "1" ]]; then
      body="$(jq -c 'del(.position)' <<<"${body}")"
    fi
  fi
  http_code="$(cloudflare_request "${method}" "${path}" "${response_file}" "${body}")"
  if [[ "${http_code}" != "200" && "${http_code}" != "201" ]]; then
    cloudflare_failure "owned rule mutation" "${http_code}" "${response_file}"
    rm -f "${response_file}"
    exit 1
  fi
  rm -f "${response_file}"
}

verify_api_gate() {
  local zone_id="$1"
  local ruleset_id="$2"
  local rule_id="$3"
  local owner="$4"
  local expires_epoch="$5"
  local ruleset_json first_rule_id matching_rule
  ruleset_json="$(fetch_ruleset "${zone_id}" "${ruleset_id}")"
  first_rule_id="$(jq -r '.rules[0].id // ""' <<<"${ruleset_json}")"
  [[ "${first_rule_id}" == "${rule_id}" ]] || {
    echo "The Cloudflare deployment gate is not first in the custom-firewall phase." >&2
    return 1
  }
  matching_rule="$(jq -c --arg id "${rule_id}" '[.rules[]? | select(.id == $id)] | if length == 1 then .[0] else null end' <<<"${ruleset_json}")"
  [[ "${matching_rule}" != "null" ]] && expected_rule_matches "${matching_rule}" "${owner}" "${expires_epoch}" || {
    echo "Cloudflare did not confirm the exact owned deployment gate." >&2
    return 1
  }
  (( expires_epoch > $(date +%s) )) || {
    echo "The Cloudflare deployment gate has already expired." >&2
    return 1
  }
}

queue_json_is_valid() {
  local file="$1"
  jq -e '
    type == "object"
    and (.queuedJobs | type == "number")
    and (.inProgressJobs | type == "number")
  ' "${file}" >/dev/null 2>&1
}

edge_request() {
  local output_file="$1"
  local path="$2"
  local method="${3:-GET}"
  local header_key="${4:-}"
  local header_value="${5:-}"
  local header_file curl_status
  local args=(--path-as-is --connect-timeout 5 --max-time 20 -sS -o "${output_file}" -w '%{http_code}' -X "${method}")
  header_file="$(mktemp "${TMPDIR:-/tmp}/rukter-edge-headers.XXXXXX")"
  chmod 600 "${header_file}"
  {
    printf 'Accept: application/json\n'
    if [[ -n "${header_key}" ]]; then
      printf '%s: %s\n' "${header_key}" "${header_value}"
    fi
  } > "${header_file}"
  args+=(--header "@${header_file}")
  if curl "${args[@]}" "${public_url%/}${path}"; then
    curl_status=0
  else
    curl_status=$?
  fi
  rm -f "${header_file}"
  return "${curl_status}"
}

verify_edge_gate_present() {
  local header_key="$1"
  local header_value="$2"
  local attempt authorized_file ordinary_file source_file amd_source_file amd_unknown_file upload_file presence_file presence_get_file
  local traversal_plain_file traversal_encoded_dots_file traversal_encoded_slash_file traversal_encoded_backslash_file
  local authorized_code ordinary_code source_code amd_source_code amd_unknown_code upload_code presence_code presence_get_code
  local traversal_plain_code traversal_encoded_dots_code traversal_encoded_slash_code traversal_encoded_backslash_code
  authorized_file="$(mktemp)"
  ordinary_file="$(mktemp)"
  source_file="$(mktemp)"
  amd_source_file="$(mktemp)"
  amd_unknown_file="$(mktemp)"
  upload_file="$(mktemp)"
  presence_file="$(mktemp)"
  presence_get_file="$(mktemp)"
  traversal_plain_file="$(mktemp)"
  traversal_encoded_dots_file="$(mktemp)"
  traversal_encoded_slash_file="$(mktemp)"
  traversal_encoded_backslash_file="$(mktemp)"
  for (( attempt = 1; attempt <= verify_attempts; attempt++ )); do
    authorized_code="$(edge_request "${authorized_file}" '/api/story-queue' GET "${header_key}" "${header_value}" || true)"
    ordinary_code="$(edge_request "${ordinary_file}" '/api/story-queue' || true)"
    source_code="$(edge_request "${source_file}" '/uploads/00000000-0000-4000-8000-000000000000.webp' || true)"
    amd_source_code="$(edge_request "${amd_source_file}" '/amd-worker/bootstrap.sh' || true)"
    amd_unknown_code="$(edge_request "${amd_unknown_file}" '/amd-worker/not-allowed.sh' || true)"
    upload_code="$(edge_request "${upload_file}" '/api/amd-story-assets' POST || true)"
    presence_code="$(edge_request "${presence_file}" '/api/story-presence' POST || true)"
    presence_get_code="$(edge_request "${presence_get_file}" '/api/story-presence' GET || true)"
    traversal_plain_code="$(edge_request "${traversal_plain_file}" '/uploads/../api/story-queue' || true)"
    traversal_encoded_dots_code="$(edge_request "${traversal_encoded_dots_file}" '/uploads/%2e%2e/api/story-queue' || true)"
    traversal_encoded_slash_code="$(edge_request "${traversal_encoded_slash_file}" '/uploads/00000000-0000-4000-8000-000000000000.webp%2f..%2fapi%2fstory-queue' || true)"
    traversal_encoded_backslash_code="$(edge_request "${traversal_encoded_backslash_file}" '/uploads/00000000-0000-4000-8000-000000000000.webp%5c..%5capi%5cstory-queue' || true)"
    if [[ "${authorized_code}" == "200" ]] && queue_json_is_valid "${authorized_file}" \
      && [[ "${ordinary_code}" == "403" ]] \
      && [[ "${source_code}" == "404" ]] \
      && [[ "${amd_source_code}" == "200" ]] \
      && [[ "${amd_unknown_code}" == "403" ]] \
      && [[ "${upload_code}" == "401" ]] \
      && [[ "${presence_code}" == "401" || "${presence_code}" == "404" || "${presence_code}" == "405" ]] \
      && [[ "${presence_get_code}" == "403" ]] \
      && [[ "${traversal_plain_code}" == "403" ]] \
      && [[ "${traversal_encoded_dots_code}" == "403" ]] \
      && [[ "${traversal_encoded_slash_code}" == "403" ]] \
      && [[ "${traversal_encoded_backslash_code}" == "403" ]]; then
      rm -f "${authorized_file}" "${ordinary_file}" "${source_file}" "${amd_source_file}" "${amd_unknown_file}" \
        "${upload_file}" "${presence_file}" "${presence_get_file}" "${traversal_plain_file}" \
        "${traversal_encoded_dots_file}" "${traversal_encoded_slash_file}" "${traversal_encoded_backslash_file}"
      return 0
    fi
    sleep "${verify_interval_seconds}"
  done
  rm -f "${authorized_file}" "${ordinary_file}" "${source_file}" "${amd_source_file}" "${amd_unknown_file}" \
    "${upload_file}" "${presence_file}" "${presence_get_file}" "${traversal_plain_file}" \
    "${traversal_encoded_dots_file}" "${traversal_encoded_slash_file}" "${traversal_encoded_backslash_file}"
  echo "Cloudflare edge verification failed: CI bypass, exact AMD continuity exemptions, or traversal blocking were not all active." >&2
  return 1
}

verify_edge_gate_absent() {
  local attempt response_file http_code
  response_file="$(mktemp)"
  for (( attempt = 1; attempt <= verify_attempts; attempt++ )); do
    http_code="$(edge_request "${response_file}" '/api/story-queue' || true)"
    if [[ "${http_code}" == "200" ]] && queue_json_is_valid "${response_file}"; then
      rm -f "${response_file}"
      return 0
    fi
    sleep "${verify_interval_seconds}"
  done
  rm -f "${response_file}"
  echo "Cloudflare edge verification failed: ordinary traffic did not regain queue JSON." >&2
  return 1
}

read_rule_by_id() {
  local ruleset_json="$1"
  local rule_id="$2"
  jq -c --arg id "${rule_id}" '[.rules[]? | select(.id == $id)] | if length == 1 then .[0] else null end' <<<"${ruleset_json}"
}

acquire_gate() {
  local zone_id entrypoint_json ruleset_id expires_epoch method rule_id
  validate_owner "${current_owner}"
  zone_id="$(find_zone_id)"
  entrypoint_json="$(read_entrypoint "${zone_id}" true)"
  ruleset_id="$(jq -r '.id' <<<"${entrypoint_json}")"
  reconcile_gate_rules "${zone_id}" "${ruleset_id}"
  expires_epoch=$(( $(date +%s) + ttl_seconds ))
  if [[ -n "${RECONCILED_RULE_ID}" ]]; then
    method="PATCH"
    rule_id="${RECONCILED_RULE_ID}"
  else
    method="POST"
    rule_id=""
  fi
  mutate_rule "${method}" "${zone_id}" "${ruleset_id}" "${rule_id}" "${current_owner}" "${expires_epoch}"
  reconcile_gate_rules "${zone_id}" "${ruleset_id}"
  [[ -n "${RECONCILED_RULE_ID}" && "${RECONCILED_RULE_EXPIRES}" == "${expires_epoch}" ]] || {
    echo "Cloudflare did not return exactly one freshly owned deployment rule." >&2
    exit 1
  }
  rule_id="${RECONCILED_RULE_ID}"
  verify_api_gate "${zone_id}" "${ruleset_id}" "${rule_id}" "${current_owner}" "${expires_epoch}"
  write_state "${current_owner}" "${zone_id}" "${ruleset_id}" "${rule_id}" "${expires_epoch}"
  verify_edge_gate_present "$(header_key_for_owner "${current_owner}")" "$(header_value_for_owner "${current_owner}")"
  echo "Owned auto-expiring Cloudflare deployment gate is active for ${zone_name}."
}

renew_gate() {
  local zone_id entrypoint_json ruleset_id expires_epoch
  load_state
  zone_id="$(find_zone_id)"
  [[ "${zone_id}" == "${state_zone_id}" ]] || {
    echo "Cloudflare zone identity changed before deployment gate renewal." >&2
    exit 1
  }
  entrypoint_json="$(read_entrypoint "${zone_id}" false)" || {
    echo "Cloudflare custom-firewall entrypoint disappeared before renewal." >&2
    exit 1
  }
  ruleset_id="$(jq -r '.id' <<<"${entrypoint_json}")"
  [[ "${ruleset_id}" == "${state_ruleset_id}" ]] || {
    echo "Cloudflare ruleset identity changed before deployment gate renewal." >&2
    exit 1
  }
  reconcile_gate_rules "${zone_id}" "${ruleset_id}"
  [[ "${RECONCILED_RULE_ID}" == "${state_rule_id}" ]] || {
    echo "The exact owned Cloudflare deployment rule is missing before renewal." >&2
    exit 1
  }
  expires_epoch=$(( $(date +%s) + ttl_seconds ))
  mutate_rule PATCH "${zone_id}" "${ruleset_id}" "${state_rule_id}" "${state_owner}" "${expires_epoch}" false
  verify_api_gate "${zone_id}" "${ruleset_id}" "${state_rule_id}" "${state_owner}" "${expires_epoch}"
  write_state "${state_owner}" "${zone_id}" "${ruleset_id}" "${state_rule_id}" "${expires_epoch}"
  verify_edge_gate_present "${state_header_key}" "${state_header_value}"
  echo "Owned Cloudflare deployment gate was renewed through ${expires_epoch}."
}

status_gate() {
  local zone_id entrypoint_json ruleset_id
  load_state
  zone_id="$(find_zone_id)"
  [[ "${zone_id}" == "${state_zone_id}" ]] || {
    echo "Cloudflare zone identity no longer matches the owned gate." >&2
    exit 1
  }
  entrypoint_json="$(read_entrypoint "${zone_id}" false)" || {
    echo "Cloudflare custom-firewall entrypoint is unavailable." >&2
    exit 1
  }
  ruleset_id="$(jq -r '.id' <<<"${entrypoint_json}")"
  [[ "${ruleset_id}" == "${state_ruleset_id}" ]] || {
    echo "Cloudflare ruleset identity no longer matches the owned gate." >&2
    exit 1
  }
  verify_api_gate "${zone_id}" "${ruleset_id}" "${state_rule_id}" "${state_owner}" "${state_expires_epoch}"
  verify_edge_gate_present "${state_header_key}" "${state_header_value}"
  echo "Owned auto-expiring Cloudflare deployment gate is active for ${zone_name}."
}

release_gate() {
  local zone_id entrypoint_json ruleset_id ruleset_json rule_json
  if [[ ! -e "${state_file}" ]]; then
    validate_owner "${current_owner}"
    zone_id="$(find_zone_id)"
    if ! entrypoint_json="$(read_entrypoint "${zone_id}" false)"; then
      verify_edge_gate_absent
      echo "No owned Cloudflare deployment gate needs recovery for ${zone_name}."
      return 0
    fi
    ruleset_id="$(jq -r '.id' <<<"${entrypoint_json}")"
    reconcile_gate_rules "${zone_id}" "${ruleset_id}"
    if [[ -n "${RECONCILED_RULE_ID}" ]]; then
      delete_rule "${zone_id}" "${ruleset_id}" "${RECONCILED_RULE_ID}"
      ruleset_json="$(fetch_ruleset "${zone_id}" "${ruleset_id}")"
      [[ "$(read_rule_by_id "${ruleset_json}" "${RECONCILED_RULE_ID}")" == "null" ]] || {
        echo "Cloudflare still reports the recovered owned deployment rule after release." >&2
        exit 1
      }
    fi
    verify_edge_gate_absent
    echo "Recovered and released this commit's Cloudflare deployment gate for ${zone_name}."
    return 0
  fi
  load_state
  zone_id="$(find_zone_id)"
  [[ "${zone_id}" == "${state_zone_id}" ]] || {
    echo "Cloudflare zone identity changed; refusing to release another zone's rule." >&2
    exit 1
  }
  if ! entrypoint_json="$(read_entrypoint "${zone_id}" false)"; then
    verify_edge_gate_absent
    rm -f "${state_file}"
    echo "Owned Cloudflare deployment gate was already absent."
    return 0
  fi
  ruleset_id="$(jq -r '.id' <<<"${entrypoint_json}")"
  [[ "${ruleset_id}" == "${state_ruleset_id}" ]] || {
    echo "Cloudflare ruleset identity changed; refusing an unowned release." >&2
    exit 1
  }
  ruleset_json="$(fetch_ruleset "${zone_id}" "${ruleset_id}")"
  rule_json="$(read_rule_by_id "${ruleset_json}" "${state_rule_id}")"
  if [[ "${rule_json}" != "null" ]]; then
    parse_owned_rule "${rule_json}"
    [[ "${PARSED_RULE_OWNER}" == "${state_owner}" ]] || {
      echo "Cloudflare rule identity changed; refusing to release another owner's gate." >&2
      exit 1
    }
    expected_rule_matches "${rule_json}" "${state_owner}" "${PARSED_RULE_EXPIRES}" || {
      echo "Cloudflare rule no longer matches the exact current-token deployment gate; refusing release." >&2
      exit 1
    }
    delete_rule "${zone_id}" "${ruleset_id}" "${state_rule_id}"
  fi
  ruleset_json="$(fetch_ruleset "${zone_id}" "${ruleset_id}")"
  [[ "$(read_rule_by_id "${ruleset_json}" "${state_rule_id}")" == "null" ]] || {
    echo "Cloudflare still reports the owned deployment rule after release." >&2
    exit 1
  }
  verify_edge_gate_absent
  rm -f "${state_file}"
  echo "Owned Cloudflare deployment gate was released for ${zone_name}."
}

require_runtime
case "${action}" in
  acquire)
    acquire_gate
    ;;
  renew)
    renew_gate
    ;;
  status)
    status_gate
    ;;
  release)
    release_gate
    ;;
  *)
    usage
    ;;
esac
