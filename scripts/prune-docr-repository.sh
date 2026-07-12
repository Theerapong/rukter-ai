#!/usr/bin/env bash
set -euo pipefail

: "${DIGITALOCEAN_TOKEN:?DIGITALOCEAN_TOKEN is required}"
: "${DOCR_REGISTRY_NAME:?DOCR_REGISTRY_NAME is required}"
: "${DOCR_REPOSITORY_NAME:?DOCR_REPOSITORY_NAME is required}"

DO_API="${DO_API:-https://api.digitalocean.com/v2}"
DO_APP_NAME="${DO_APP_NAME:-rukter-ai-launch-agent}"
DO_APP_SERVICE_NAME="${DO_APP_SERVICE_NAME:-web}"
DOCR_RETAIN_ROLLBACK_MANIFESTS="${DOCR_RETAIN_ROLLBACK_MANIFESTS:-3}"

if ! [[ "${DOCR_RETAIN_ROLLBACK_MANIFESTS}" =~ ^[0-9]+$ ]] || (( DOCR_RETAIN_ROLLBACK_MANIFESTS < 3 )); then
  echo "DOCR_RETAIN_ROLLBACK_MANIFESTS must be an integer of at least 3." >&2
  exit 1
fi

auth_header="Authorization: Bearer ${DIGITALOCEAN_TOKEN}"
repository_path="$(jq -rn --arg value "${DOCR_REPOSITORY_NAME}" '$value | @uri')"
registry_path="$(jq -rn --arg value "${DOCR_REGISTRY_NAME}" '$value | @uri')"
active_gc_file="$(mktemp)"
post_gc_file="$(mktemp)"
trap 'rm -f "${active_gc_file}" "${post_gc_file}"' EXIT

api_get() {
  curl --retry 3 --retry-all-errors -fsS -H "${auth_header}" "$1"
}

load_all_manifests() {
  local manifests='[]'
  local page=1
  local page_json page_total collected
  while :; do
    page_json="$(api_get "${DO_API}/registries/${registry_path}/repositories/${repository_path}/digests?per_page=200&page=${page}")"
    page_total="$(printf '%s' "${page_json}" | jq -r '.meta.total // empty')"
    if ! [[ "${page_total}" =~ ^[0-9]+$ ]]; then
      echo "DOCR manifest response omitted a numeric total; refusing registry pruning." >&2
      return 1
    fi
    manifests="$(jq -cn --argjson current "${manifests}" --argjson response "${page_json}" \
      '$current + ($response.manifests // [])')"
    collected="$(printf '%s' "${manifests}" | jq 'length')"
    if (( collected >= page_total )); then
      if (( collected != page_total )); then
        echo "DOCR manifest total changed during pagination; refusing registry pruning." >&2
        return 1
      fi
      printf '%s' "${manifests}"
      return 0
    fi
    ((page += 1))
    if (( page > 20 )); then
      echo "DOCR manifest pagination exceeded the safety limit." >&2
      return 1
    fi
  done
}

active_gc_status() {
  curl -sS -o "${active_gc_file}" -w '%{http_code}' -H "${auth_header}" \
    "${DO_API}/registries/${registry_path}/garbage-collection"
}

wait_for_gc() {
  local gc_uuid="$1"
  local attempt http_code history_json gc_state freed_bytes observed_uuid
  for attempt in $(seq 1 120); do
    http_code="$(active_gc_status)"
    if [[ "${http_code}" == "200" ]]; then
      observed_uuid="$(jq -r '.garbage_collection.uuid // empty' "${active_gc_file}")"
      if [[ -n "${observed_uuid}" && "${observed_uuid}" != "${gc_uuid}" ]]; then
        echo "Another DOCR garbage collection replaced ${gc_uuid}; refusing to guess its outcome." >&2
        return 1
      fi
      gc_state="$(jq -r '.garbage_collection.status // empty' "${active_gc_file}")"
    elif [[ "${http_code}" == "404" ]]; then
      history_json="$(api_get "${DO_API}/registries/${registry_path}/garbage-collections?per_page=200")"
      gc_state="$(printf '%s' "${history_json}" | jq -r --arg uuid "${gc_uuid}" \
        '.garbage_collections[]? | select(.uuid == $uuid) | .status // empty' | head -n 1)"
    else
      echo "Could not read active DOCR garbage collection (HTTP ${http_code})." >&2
      return 1
    fi

    case "${gc_state}" in
      succeeded|success)
        history_json="$(api_get "${DO_API}/registries/${registry_path}/garbage-collections?per_page=200")"
        freed_bytes="$(printf '%s' "${history_json}" | jq -r --arg uuid "${gc_uuid}" \
          '.garbage_collections[]? | select(.uuid == $uuid) | .freed_bytes // 0' | head -n 1)"
        echo "DOCR garbage collection ${gc_uuid} succeeded and freed ${freed_bytes:-0} bytes."
        return 0
        ;;
      requested|'waiting for write JWTs to expire'|'scanning manifests'|'deleting unreferenced blobs'|'')
        if (( attempt % 6 == 0 )); then
          echo "DOCR garbage collection is ${gc_state:-pending} (${attempt}/120)."
        fi
        sleep 10
        ;;
      cancelling|failed|canceled|cancelled)
        echo "DOCR garbage collection ${gc_uuid} ended with status ${gc_state}." >&2
        return 1
        ;;
      *)
        echo "Unknown DOCR garbage collection status: ${gc_state}." >&2
        return 1
        ;;
    esac
  done
  echo "Timed out waiting for DOCR garbage collection ${gc_uuid}." >&2
  return 1
}

preflight_code="$(active_gc_status)"
if [[ "${preflight_code}" == "200" ]]; then
  preflight_uuid="$(jq -r '.garbage_collection.uuid // empty' "${active_gc_file}")"
  test -n "${preflight_uuid}"
  echo "Waiting for existing DOCR garbage collection ${preflight_uuid}."
  wait_for_gc "${preflight_uuid}"
elif [[ "${preflight_code}" != "404" ]]; then
  echo "Could not preflight DOCR garbage collection (HTTP ${preflight_code})." >&2
  exit 1
fi

apps_json="$(api_get "${DO_API}/apps?per_page=200")"
app_ids="$(printf '%s' "${apps_json}" | jq -c --arg app "${DO_APP_NAME}" \
  '[.apps[]? | select(.spec.name == $app) | .id] | unique')"
if [[ "$(printf '%s' "${app_ids}" | jq 'length')" != "1" ]]; then
  echo "Expected exactly one App Platform app named ${DO_APP_NAME}; refusing registry pruning." >&2
  exit 1
fi
app_id="$(printf '%s' "${app_ids}" | jq -r '.[0]')"
app_json="$(api_get "${DO_API}/apps/${app_id}")"
active_deployment_id="$(printf '%s' "${app_json}" | jq -r '.app.active_deployment.id // empty')"
if [[ -z "${active_deployment_id}" ]]; then
  echo "The App Platform app has no active deployment; refusing registry pruning." >&2
  exit 1
fi
active_tags="$(printf '%s' "${app_json}" | jq -c \
  --arg service "${DO_APP_SERVICE_NAME}" \
  --arg repository "${DOCR_REPOSITORY_NAME}" '
    [.app.active_deployment.spec.services[]?
      | select(.name == $service)
      | select(.image.repository == $repository)
      | .image.tag
      | select(type == "string" and length > 0)
    ] | unique
  ')"
if [[ "$(printf '%s' "${active_tags}" | jq 'length')" != "1" ]]; then
  echo "Expected exactly one active deployment tag for ${DO_APP_SERVICE_NAME}; refusing registry pruning." >&2
  exit 1
fi
active_tag="$(printf '%s' "${active_tags}" | jq -r '.[0]')"

all_manifests="$(load_all_manifests)"
collected="$(printf '%s' "${all_manifests}" | jq 'length')"

ordered_manifests="$(printf '%s' "${all_manifests}" | jq -c 'sort_by(.updated_at) | reverse')"
invalid_count="$(printf '%s' "${ordered_manifests}" | jq '
  [.[] | select(
    ((.digest | type) != "string")
    or ((try (.digest | test("^sha256:[0-9a-f]{64}$")) catch false) | not)
    or ((.updated_at | type) != "string")
    or (.updated_at == "")
    or (((.tags // []) | type) != "array")
  )] | length
')"
if (( invalid_count > 0 )); then
  echo "DOCR returned ${invalid_count} malformed manifests; refusing registry pruning." >&2
  exit 1
fi
if [[ "$(printf '%s' "${ordered_manifests}" | jq 'map(.digest) | unique | length')" != "${collected}" ]]; then
  echo "DOCR manifest pagination returned duplicate digests; refusing registry pruning." >&2
  exit 1
fi

active_matches="$(printf '%s' "${ordered_manifests}" | jq -c --arg active_tag "${active_tag}" \
  '[.[] | select(((.tags // []) | index($active_tag)) != null)]')"
if [[ "$(printf '%s' "${active_matches}" | jq 'length')" != "1" ]]; then
  echo "Expected active tag ${active_tag} to resolve to exactly one manifest; refusing registry pruning." >&2
  exit 1
fi
active_digest="$(printf '%s' "${active_matches}" | jq -r '.[0].digest')"
active_updated_at="$(printf '%s' "${active_matches}" | jq -r '.[0].updated_at')"
protected_digests="$(printf '%s' "${ordered_manifests}" | jq -c \
  --arg active_digest "${active_digest}" \
  --arg active_updated_at "${active_updated_at}" \
  --argjson rollback_count "${DOCR_RETAIN_ROLLBACK_MANIFESTS}" '
    ([.[] | select(.digest == $active_digest or .updated_at == $active_updated_at) | .digest]
      + ([.[] | select(.digest != $active_digest and .updated_at != $active_updated_at) | .digest][: $rollback_count]))
    | unique
  ')"
candidates="$(printf '%s' "${ordered_manifests}" | jq -c --argjson protected "${protected_digests}" \
  '[.[] | select(.digest as $digest | ($protected | index($digest)) == null)]')"
candidate_count="$(printf '%s' "${candidates}" | jq 'length')"
echo "DOCR has ${collected} manifests; preserving active digest ${active_digest:0:19}, its deployment batch, and ${DOCR_RETAIN_ROLLBACK_MANIFESTS} recent manifests."

fresh_app_json="$(api_get "${DO_API}/apps/${app_id}")"
fresh_deployment_id="$(printf '%s' "${fresh_app_json}" | jq -r '.app.active_deployment.id // empty')"
fresh_active_tags="$(printf '%s' "${fresh_app_json}" | jq -c \
  --arg service "${DO_APP_SERVICE_NAME}" \
  --arg repository "${DOCR_REPOSITORY_NAME}" '
    [.app.active_deployment.spec.services[]?
      | select(.name == $service)
      | select(.image.repository == $repository)
      | .image.tag
      | select(type == "string" and length > 0)
    ] | unique
  ')"
if [[ "${fresh_deployment_id}" != "${active_deployment_id}" ]] \
  || [[ "$(printf '%s' "${fresh_active_tags}" | jq 'length')" != "1" ]] \
  || [[ "$(printf '%s' "${fresh_active_tags}" | jq -r '.[0]')" != "${active_tag}" ]]; then
  echo "The active App Platform deployment changed during cleanup planning; refusing registry pruning." >&2
  exit 1
fi
fresh_manifests="$(load_all_manifests)"
fresh_active_digests="$(printf '%s' "${fresh_manifests}" | jq -c --arg active_tag "${active_tag}" \
  '[.[] | select(((.tags // []) | index($active_tag)) != null) | .digest] | unique')"
if [[ "$(printf '%s' "${fresh_active_digests}" | jq 'length')" != "1" ]] \
  || [[ "$(printf '%s' "${fresh_active_digests}" | jq -r '.[0]')" != "${active_digest}" ]]; then
  echo "The active DOCR digest changed during cleanup planning; refusing registry pruning." >&2
  exit 1
fi

if (( candidate_count == 0 )); then
  echo "No stale manifest is outside the protected set; garbage collecting only unreferenced blobs."
else
  while IFS=$'\t' read -r digest tags updated_at; do
    [[ -n "${digest}" ]] || continue
    echo "Deleting stale DOCR manifest ${digest:0:19} (${tags:-untagged}, ${updated_at})."
    status_code="$(curl --retry 3 --retry-all-errors -sS -o /dev/null -w '%{http_code}' \
      -X DELETE -H "${auth_header}" \
      "${DO_API}/registries/${registry_path}/repositories/${repository_path}/digests/${digest}")"
    if [[ "${status_code}" != "204" ]]; then
      echo "Manifest deletion failed with HTTP ${status_code}; stopping before garbage collection." >&2
      exit 1
    fi
  done < <(printf '%s' "${candidates}" | jq -r '.[] | [.digest, ((.tags // []) | join(",")), .updated_at] | @tsv')
fi

set +e
post_code="$(curl -sS -o "${post_gc_file}" -w '%{http_code}' -X POST -H "${auth_header}" \
  "${DO_API}/registries/${registry_path}/garbage-collection")"
post_exit=$?
set -e
if (( post_exit == 0 )) && [[ "${post_code}" == "201" ]]; then
  gc_uuid="$(jq -r '.garbage_collection.uuid // empty' "${post_gc_file}")"
else
  recovery_code="$(active_gc_status)"
  if [[ "${recovery_code}" != "200" ]]; then
    echo "Could not start or recover DOCR garbage collection (curl ${post_exit}, HTTP ${post_code})." >&2
    exit 1
  fi
  gc_uuid="$(jq -r '.garbage_collection.uuid // empty' "${active_gc_file}")"
fi
test -n "${gc_uuid}"
echo "Started DOCR garbage collection ${gc_uuid}; waiting for write access to return."
wait_for_gc "${gc_uuid}"
