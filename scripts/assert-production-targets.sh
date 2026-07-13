#!/usr/bin/env bash
set -euo pipefail

production_mode="${RUKTER_AI_DEPLOYMENT_PRODUCTION:-false}"

case "${production_mode}" in
  false)
    exit 0
    ;;
  true)
    ;;
  *)
    echo "RUKTER_AI_DEPLOYMENT_PRODUCTION must be true or false." >&2
    exit 2
    ;;
esac

require_exact_target() {
  local name="$1"
  local actual="$2"
  local expected="$3"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "Production deployment requires ${name}=${expected}; refusing override." >&2
    exit 2
  fi
}

# Require each variable independently. Do not let one pinned fallback conceal a
# project/group variable that would redirect another production script.
require_exact_target RUKTER_AI_PUBLIC_URL "${RUKTER_AI_PUBLIC_URL:-}" "https://rukter.ai"
require_exact_target DEPLOYMENT_EDGE_GATE_PUBLIC_URL "${DEPLOYMENT_EDGE_GATE_PUBLIC_URL:-}" "https://rukter.ai"
require_exact_target DEPLOYMENT_EDGE_GATE_API_URL "${DEPLOYMENT_EDGE_GATE_API_URL:-}" "https://api.cloudflare.com/client/v4"
require_exact_target DEPLOYMENT_EDGE_GATE_ZONE_NAME "${DEPLOYMENT_EDGE_GATE_ZONE_NAME:-}" "rukter.ai"
require_exact_target DEPLOYMENT_DRAIN_DIGITALOCEAN_API_URL "${DEPLOYMENT_DRAIN_DIGITALOCEAN_API_URL:-}" "https://api.digitalocean.com/v2"
require_exact_target AMD_GPU_DIGITALOCEAN_API_URL "${AMD_GPU_DIGITALOCEAN_API_URL:-}" "https://api.digitalocean.com/v2"
require_exact_target AMD_GPU_PERSISTENT_TAG "${AMD_GPU_PERSISTENT_TAG:-}" "rukter-product-story-persistent"
require_exact_target AMD_GPU_WORKER_SOURCE_BASE_URL "${AMD_GPU_WORKER_SOURCE_BASE_URL:-}" "https://rukter.ai/amd-worker"
require_exact_target AMD_GPU_ORCHESTRATOR_URL "${AMD_GPU_ORCHESTRATOR_URL:-}" "http://127.0.0.1:3017"
