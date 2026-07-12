locals {
  runtime_environment = merge({
    NODE_ENV                       = "production"
    PORT                           = tostring(var.container_port)
    RUKTER_AI_DEPLOY_ENV           = "digitalocean"
    RUKTER_AI_COMMIT_SHA           = var.app_commit_sha
    RUKTER_AI_DEPLOY_ID            = var.deploy_timestamp
    RUKTER_MCP_URL                 = "https://rukter.com/mcp"
    RUKTER_DASHBOARD_URL           = "https://store-4.rukter.com/dashboard/theme"
    RUKTER_CANONICAL_URL           = "https://rukter.com"
    FIREWORKS_BASE_URL             = "https://api.fireworks.ai/inference/v1"
    FIREWORKS_MODEL                = "accounts/fireworks/models/deepseek-v4-flash"
    FIREWORKS_MODEL_FALLBACKS      = "accounts/fireworks/models/gpt-oss-20b"
    FIREWORKS_VISION_MODEL         = "accounts/fireworks/models/kimi-k2p6"
    FIREWORKS_REQUEST_TIMEOUT_MS   = "24000"
    FIREWORKS_TOTAL_TIMEOUT_MS     = "27000"
    FIREWORKS_MAX_TOKENS           = "2048"
    RUKTER_AI_HOSTING_PLATFORM     = "digitalocean-app-platform"
    RUKTER_AI_PUBLIC_URL           = "https://rukter.ai"
    AMD_GPU_PUBLIC_ENABLED         = tostring(var.amd_gpu_public_enabled)
    AMD_GPU_REGION                 = var.amd_gpu_region
    AMD_GPU_SIZE                   = var.amd_gpu_size
    AMD_GPU_IMAGE                  = var.amd_gpu_image
    AMD_GPU_VPC_UUID               = var.amd_gpu_vpc_uuid
    AMD_GPU_SSH_KEY_FINGERPRINT    = var.amd_gpu_ssh_key_fingerprint
    AMD_GPU_SSH_KEY_NAME           = var.amd_gpu_ssh_key_name
    AMD_GPU_LEASE_TTL_SECONDS      = tostring(var.amd_gpu_lease_ttl_seconds)
    AMD_GPU_QUEUE_MAX_SIZE         = tostring(var.amd_gpu_queue_max_size)
    AMD_GPU_CAPACITY_POLL_MS       = tostring(var.amd_gpu_capacity_poll_ms)
    AMD_GPU_WORKER_SOURCE_BASE_URL = var.amd_gpu_worker_source_base_url
    AMD_GPU_CAPACITY_STATE         = var.amd_gpu_capacity_state
    AMD_GPU_AVAILABILITY_REASON    = var.amd_gpu_availability_reason
    }, var.amd_3d_worker_url == "" ? {} : {
    AMD_3D_WORKER_URL = var.amd_3d_worker_url
    }, var.amd_gpu_orchestrator_url == "" ? {} : {
    AMD_GPU_ORCHESTRATOR_URL = var.amd_gpu_orchestrator_url
  }, var.extra_environment)

  secret_environment = merge(
    var.fireworks_api_key == "" ? {} : {
      FIREWORKS_API_KEY = var.fireworks_api_key
    },
    var.rukter_mcp_access_token == "" ? {} : {
      RUKTER_MCP_ACCESS_TOKEN = var.rukter_mcp_access_token
    },
    var.amd_3d_worker_token == "" ? {} : {
      AMD_3D_WORKER_TOKEN = var.amd_3d_worker_token
    },
    var.amd_gpu_orchestrator_token == "" ? {} : {
      AMD_GPU_ORCHESTRATOR_TOKEN = var.amd_gpu_orchestrator_token
    },
    var.amd_gpu_digitalocean_token == "" ? {} : {
      AMD_GPU_DIGITALOCEAN_TOKEN = var.amd_gpu_digitalocean_token
    }
  )
}

resource "digitalocean_app" "app" {
  spec {
    name   = var.app_name
    region = var.region

    service {
      name               = "web"
      instance_count     = var.instance_count
      instance_size_slug = var.instance_size_slug
      http_port          = var.container_port

      image {
        registry_type = "DOCR"
        repository    = var.image_repository
        tag           = var.image_tag
      }

      health_check {
        http_path = "/health"
      }

      dynamic "env" {
        for_each = local.runtime_environment
        content {
          key   = env.key
          value = env.value
          scope = "RUN_TIME"
          type  = "GENERAL"
        }
      }

      dynamic "env" {
        for_each = local.secret_environment
        content {
          key   = env.key
          value = env.value
          scope = "RUN_TIME"
          type  = "SECRET"
        }
      }
    }

    alert {
      rule = "DEPLOYMENT_FAILED"
    }

    alert {
      rule = "DOMAIN_FAILED"
    }

    domain {
      name = "rukter.ai"
      type = "PRIMARY"
    }

    domain {
      name = "www.rukter.ai"
      type = "ALIAS"
    }
  }
}
