variable "app_name" {
  type        = string
  description = "DigitalOcean App Platform app name."
  default     = "rukter-ai-launch-agent"
}

variable "region" {
  type        = string
  description = "DigitalOcean App Platform region."
  default     = "sgp"
}

variable "image_repository" {
  type        = string
  description = "DigitalOcean Container Registry repository name used by App Platform."
  default     = "rukter-ai-launch-agent"
}

variable "image_tag" {
  type        = string
  description = "DigitalOcean Container Registry image tag deployed by App Platform."
  default     = "latest"
}

variable "container_port" {
  type        = number
  description = "Internal port exposed by the Node server."
  default     = 3017
}

variable "instance_count" {
  type        = number
  description = "DigitalOcean App Platform instance count."
  default     = 1
}

variable "instance_size_slug" {
  type        = string
  description = "DigitalOcean App Platform instance size slug."
  default     = "basic-xxs"
}

variable "app_commit_sha" {
  type        = string
  description = "Git commit deployed into the app."
  default     = "unknown"
}

variable "deploy_timestamp" {
  type        = string
  description = "Human-readable deploy id injected by CI."
  default     = "manual"
}

variable "fireworks_api_key" {
  type        = string
  description = "Optional Fireworks API key mounted into the DigitalOcean app as a secret env var."
  sensitive   = true
  default     = ""
}

variable "rukter_mcp_access_token" {
  type        = string
  description = "Optional Rukter MCP access token mounted into the DigitalOcean app as a secret env var."
  sensitive   = true
  default     = ""
}

variable "amd_3d_worker_url" {
  type        = string
  description = "Optional AMD GPU reconstruction worker endpoint. Leave empty for truthful 2.5D previews."
  default     = ""
}

variable "amd_3d_worker_token" {
  type        = string
  description = "Optional bearer token for the AMD GPU reconstruction worker."
  sensitive   = true
  default     = ""
}

variable "amd_gpu_orchestrator_url" {
  type        = string
  description = "Optional zero-idle AMD GPU lease orchestrator endpoint for Product Story jobs."
  default     = ""
}

variable "amd_gpu_orchestrator_token" {
  type        = string
  description = "Optional bearer token for the AMD GPU lease orchestrator."
  sensitive   = true
  default     = ""
}

variable "amd_gpu_digitalocean_token" {
  type        = string
  description = "Scoped DigitalOcean token used only to create, inspect, and destroy ephemeral AMD GPU Droplets."
  sensitive   = true
  default     = ""
}

variable "amd_gpu_region" {
  type        = string
  description = "AMD Developer Cloud region used for Product Story workers."
  default     = "atl1"
}

variable "amd_gpu_size" {
  type        = string
  description = "Single-GPU AMD Developer Cloud size slug."
  default     = "gpu-mi300x1-192gb-devcloud"
}

variable "amd_gpu_capacity_state" {
  type        = string
  description = "Current operator-verified AMD GPU capacity state shown in the public UI."
  default     = "unavailable"
}

variable "amd_gpu_availability_reason" {
  type        = string
  description = "Public explanation shown while AMD Cinematic cannot start."
  default     = "AMD Developer Cloud currently reports no MI300X capacity in ATL1, NYC2, or TOR1. No GPU billing has started."
}

variable "amd_gpu_image" {
  type        = string
  description = "ROCm-ready AMD GPU image slug."
  default     = "amddevelopercloud-pytorch2100rocm724"
}

variable "amd_gpu_vpc_uuid" {
  type        = string
  description = "Optional region-matched VPC UUID used by AMD Developer Cloud GPU provisioning."
  default     = ""
}

variable "amd_gpu_ssh_key_fingerprint" {
  type        = string
  description = "Registered SSH key fingerprint attached to every ephemeral AMD GPU worker."
  default     = ""
}

variable "amd_gpu_ssh_key_name" {
  type        = string
  description = "Fallback registered SSH key name used when the fingerprint is unavailable."
  default     = ""
}

variable "amd_gpu_lease_ttl_seconds" {
  type        = number
  description = "Hard maximum lifetime for an AMD GPU worker before the TTL reaper destroys it."
  default     = 1800
}

variable "amd_gpu_queue_max_size" {
  type        = number
  description = "Maximum number of active and waiting AMD Cinematic jobs accepted by the single FIFO render queue."
  default     = 25
}

variable "amd_gpu_capacity_poll_ms" {
  type        = number
  description = "Delay between capacity retries for the first queued job; retries do not create a billed GPU."
  default     = 30000
}

variable "amd_gpu_worker_source_base_url" {
  type        = string
  description = "Public source URL used by cloud-init to bootstrap the AMD cinematic worker."
  default     = "https://rukter.ai/amd-worker"
}

variable "amd_gpu_public_enabled" {
  type        = bool
  description = "Explicit safety switch for public AMD Cinematic jobs. Keep false until lease destroy and TTL reaping are verified."
  default     = false
}

variable "extra_environment" {
  type        = map(string)
  description = "Additional plain environment variables for the DigitalOcean app service."
  default     = {}
}
