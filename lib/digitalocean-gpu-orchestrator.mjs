import { randomUUID } from 'node:crypto'

const apiBase = 'https://api.digitalocean.com/v2'
const defaultTag = 'rukter-product-story-ephemeral'
const defaultTtlSeconds = 50 * 60

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(minimum, Math.min(maximum, Math.round(parsed)))
}

function encodeEnvironment(values) {
  const content = Object.entries(values)
    .map(([key, value]) => `${key}=${String(value).replace(/[\r\n]/g, '')}`)
    .join('\n')
  return Buffer.from(`${content}\n`).toString('base64')
}

export function buildAmdWorkerCloudInit({
  workerToken,
  uploadUrl,
  sourceBaseUrl = 'https://raw.githubusercontent.com/Theerapong/rukter-ai/main/amd-worker',
  modelId = 'Wan-AI/Wan2.2-TI2V-5B-Diffusers',
} = {}) {
  if (!workerToken || !uploadUrl) throw new Error('AMD worker bootstrap requires a token and output upload URL.')
  const environment = encodeEnvironment({
    WORKER_TOKEN: workerToken,
    OUTPUT_UPLOAD_URL: uploadUrl,
    RUKTER_WORKER_SOURCE_BASE: sourceBaseUrl,
    STORY_PIPELINE_COMMAND: '/opt/rukter/run_story_pipeline.sh',
    WAN_MODEL_ID: modelId,
    WAN_IDENTITY_THRESHOLD: '0.42',
    WAN_FPS: '16',
    WAN_NUM_FRAMES: '49',
    WAN_INFERENCE_STEPS: '16',
    PORT: '8080',
  })
  const bootstrapUrl = `${sourceBaseUrl.replace(/\/$/, '')}/bootstrap.sh`
  return `#cloud-config
write_files:
  - path: /etc/rukter-amd-worker.env
    permissions: '0600'
    encoding: b64
    content: ${environment}
runcmd:
  - [bash, -lc, "mkdir -p /opt/rukter"]
  - [bash, -lc, "curl -fsSL '${bootstrapUrl}' -o /opt/rukter/bootstrap.sh"]
  - [bash, -lc, "chmod 700 /opt/rukter/bootstrap.sh && /opt/rukter/bootstrap.sh"]
`
}

function publicIpv4(droplet) {
  return droplet?.networks?.v4?.find((network) => network.type === 'public')?.ip_address || ''
}

function safeDropletId(value) {
  const id = String(value || '')
  if (!/^\d+$/.test(id)) throw new Error('Invalid AMD GPU lease ID.')
  return id
}

async function wait(ms, signal) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason || new Error('AMD GPU provisioning cancelled.'))
    }, { once: true })
  })
}

export function createDigitalOceanGpuOrchestrator({
  token,
  workerToken,
  publicUrl,
  region = 'atl1',
  size = 'gpu-mi300x1-192gb-devcloud',
  image = 'gpu-amd-base',
  sshKeyFingerprint = '',
  sshKeyName = '',
  tag = defaultTag,
  ttlSeconds = defaultTtlSeconds,
  workerSourceBaseUrl,
  fetchImpl = fetch,
  pollIntervalMs = 10_000,
  bootTimeoutMs = 15 * 60_000,
  capacityCacheMs = 30_000,
  now = () => Date.now(),
} = {}) {
  const leaseTtlSeconds = boundedInteger(ttlSeconds, defaultTtlSeconds, 300, defaultTtlSeconds)
  let capacityCache = null

  async function request(path, options = {}) {
    if (!token) throw new Error('AMD GPU DigitalOcean token is not configured.')
    const response = await fetchImpl(`${apiBase}${path}`, {
      ...options,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
      signal: options.signal || AbortSignal.timeout(30_000),
    })
    const payload = response.status === 204 ? {} : await response.json().catch(() => null)
    if (!response.ok) throw new Error(payload?.message || payload?.id || `DigitalOcean API returned ${response.status}.`)
    return payload || {}
  }

  async function listLeases() {
    const payload = await request(`/droplets?tag_name=${encodeURIComponent(tag)}&per_page=200`)
    return Array.isArray(payload.droplets) ? payload.droplets : []
  }

  async function checkCapacity({ refresh = false } = {}) {
    if (!refresh && capacityCache && now() - capacityCache.checkedAtMs < capacityCacheMs) {
      return capacityCache.value
    }
    const existing = await listLeases()
    if (existing.length) {
      const droplet = existing[0]
      const existingRegion = droplet?.region?.slug || region
      const existingSize = droplet?.size_slug || droplet?.size?.slug || size
      const checkedAt = new Date(now()).toISOString()
      const value = {
        state: droplet.status === 'active' ? 'available' : 'provisioning',
        available: true,
        region: existingRegion,
        configuredRegion: region,
        size: existingSize,
        availableRegions: [existingRegion],
        checkedAt,
        existingLease: true,
        reason: droplet.status === 'active'
          ? 'An AMD Instinct MI300X worker is online and ready to accept a Product Story job.'
          : 'An AMD Instinct MI300X worker is being provisioned for Product Story jobs.',
      }
      capacityCache = { checkedAtMs: now(), value }
      return value
    }
    const payload = await request('/sizes?per_page=200')
    const sizes = Array.isArray(payload.sizes) ? payload.sizes : []
    const configuredSize = sizes.find((candidate) => candidate.slug === size)
    const availableRegions = Array.isArray(configuredSize?.regions) ? configuredSize.regions : []
    const selectedRegion = availableRegions.includes(region) ? region : (availableRegions[0] || region)
    const listedCapacity = configuredSize?.available === true && availableRegions.length > 0
    const developerCloudEntitlement = size.endsWith('-devcloud') && configuredSize?.available !== false
    const available = listedCapacity || developerCloudEntitlement
    const checkedAt = new Date(now()).toISOString()
    const value = {
      state: listedCapacity ? 'available' : developerCloudEntitlement ? 'requestable' : 'unavailable',
      available,
      region: selectedRegion,
      configuredRegion: region,
      size,
      availableRegions,
      checkedAt,
      capacitySource: listedCapacity ? 'sizes_api' : developerCloudEntitlement ? 'developer_cloud_entitlement' : 'sizes_api',
      reason: listedCapacity
        ? `AMD Instinct MI300X capacity is available in ${selectedRegion.toUpperCase()}. The GPU starts only when the story job begins.`
        : developerCloudEntitlement
          ? `AMD Developer Cloud access is configured in ${selectedRegion.toUpperCase()}. Starting an AMD Cinematic story requests an MI300X; billing begins only if DigitalOcean accepts the create request.`
        : 'AMD Developer Cloud currently reports no MI300X capacity. No GPU billing has started.',
    }
    capacityCache = { checkedAtMs: now(), value }
    return value
  }

  async function resolveSshKey() {
    const payload = await request('/account/keys?per_page=200')
    const keys = Array.isArray(payload.ssh_keys) ? payload.ssh_keys : []
    const key = keys.find((candidate) => sshKeyFingerprint && candidate.fingerprint === sshKeyFingerprint)
      || keys.find((candidate) => sshKeyName && candidate.name === sshKeyName)
    if (!key) throw new Error('The configured AMD GPU SSH key was not found in DigitalOcean.')
    return key.fingerprint || key.id
  }

  async function releaseLease(leaseId) {
    const id = safeDropletId(leaseId)
    if (!token) throw new Error('AMD GPU DigitalOcean token is not configured.')
    const response = await fetchImpl(`${apiBase}/droplets/${id}`, {
      method: 'DELETE',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok && response.status !== 404) {
      const payload = await response.json().catch(() => null)
      throw new Error(payload?.message || `DigitalOcean API returned ${response.status}.`)
    }
    capacityCache = null
    return { id, status: 'released', billing: 'inactive', releasePolicy: 'destroy_after_job' }
  }

  async function reapExpiredLeases() {
    const droplets = await listLeases()
    const released = []
    for (const droplet of droplets) {
      const createdAt = new Date(droplet.created_at).getTime()
      if (!Number.isFinite(createdAt) || now() - createdAt < leaseTtlSeconds * 1000) continue
      await releaseLease(droplet.id)
      released.push(String(droplet.id))
    }
    return { checked: droplets.length, released, ttlSeconds: leaseTtlSeconds }
  }

  async function dropletRequest(selectedRegion = region) {
    const sshKey = await resolveSshKey()
    const name = `rukter-story-${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const userData = buildAmdWorkerCloudInit({
      workerToken,
      uploadUrl: `${String(publicUrl || '').replace(/\/$/, '')}/api/amd-story-assets`,
      sourceBaseUrl: workerSourceBaseUrl || `${String(publicUrl || '').replace(/\/$/, '')}/amd-worker`,
    })
    return {
      name,
      region: selectedRegion,
      size,
      image,
      ssh_keys: [sshKey],
      backups: false,
      ipv6: false,
      monitoring: false,
      tags: [tag],
      user_data: userData,
    }
  }

  async function startLease({ dryRun = false, signal } = {}) {
    await reapExpiredLeases()
    const existing = await listLeases()
    if (existing.length) {
      const droplet = existing[0]
      const existingRegion = droplet?.region?.slug || region
      const existingSize = droplet?.size_slug || droplet?.size?.slug || size
      return {
        id: safeDropletId(droplet.id),
        status: 'provisioning',
        phase: droplet.status === 'active' ? 'worker_booting' : 'droplet_starting',
        region: existingRegion,
        size: existingSize,
        createdAt: droplet.created_at,
        expiresAt: new Date(new Date(droplet.created_at).getTime() + leaseTtlSeconds * 1000).toISOString(),
        releasePolicy: 'destroy_after_job',
        adopted: true,
      }
    }
    const capacity = dryRun ? null : await checkCapacity({ refresh: true })
    if (capacity && !capacity.available) throw new Error(capacity.reason)
    const createRequest = await dropletRequest(capacity?.region || region)
    if (dryRun) {
      return {
        status: 'validated',
        region: createRequest.region,
        size: createRequest.size,
        image: createRequest.image,
        tag,
        ttlSeconds: leaseTtlSeconds,
        sshKeyConfigured: createRequest.ssh_keys.length === 1,
        cloudInitBytes: Buffer.byteLength(createRequest.user_data),
      }
    }

    const created = await request('/droplets', {
      method: 'POST',
      body: JSON.stringify(createRequest),
      signal,
    })
    const dropletId = safeDropletId(created.droplet?.id)
    return {
      id: dropletId,
      status: 'provisioning',
      phase: 'droplet_starting',
      region: createRequest.region,
      size,
      createdAt: created.droplet?.created_at || new Date(now()).toISOString(),
      expiresAt: new Date(now() + leaseTtlSeconds * 1000).toISOString(),
      releasePolicy: 'destroy_after_job',
    }
  }

  async function inspectLease(leaseId, { signal } = {}) {
    const id = safeDropletId(leaseId)
    const payload = await request(`/droplets/${id}`, { signal })
    const droplet = payload.droplet
    const ip = publicIpv4(droplet)
    const base = {
      id,
      status: 'provisioning',
      phase: droplet?.status === 'active' ? 'worker_booting' : 'droplet_starting',
      region: droplet?.region?.slug || region,
      size: droplet?.size_slug || droplet?.size?.slug || size,
      createdAt: droplet?.created_at,
      expiresAt: new Date(new Date(droplet?.created_at).getTime() + leaseTtlSeconds * 1000).toISOString(),
      releasePolicy: 'destroy_after_job',
    }
    if (droplet?.status !== 'active' || !ip) return base
    const workerUrl = `http://${ip}:8080`
    const healthResponse = await fetchImpl(`${workerUrl}/health`, {
      headers: workerToken ? { authorization: `Bearer ${workerToken}` } : {},
      signal: AbortSignal.timeout(8_000),
    }).catch(() => null)
    const health = healthResponse?.ok ? await healthResponse.json().catch(() => null) : null
    if (health?.status !== 'ok' || health?.available !== true) return base
    return {
      ...base,
      status: 'ready',
      phase: 'worker_ready',
      workerUrl,
      gpuDevice: health.device || 'AMD Instinct MI300X',
      rocmVersion: health.rocmVersion || '',
    }
  }

  async function createLease(options = {}) {
    const lease = await startLease(options)
    if (lease.status === 'validated') return lease
    const startedAt = now()
    try {
      while (now() - startedAt < bootTimeoutMs) {
        await wait(pollIntervalMs, options.signal)
        const current = await inspectLease(lease.id, { signal: options.signal })
        if (current.status === 'ready') return current
      }
      throw new Error('AMD GPU worker did not become ready before the boot timeout.')
    } catch (error) {
      await releaseLease(lease.id).catch(() => {})
      throw error
    }
  }

  return { startLease, inspectLease, createLease, releaseLease, reapExpiredLeases, listLeases, checkCapacity, leaseTtlSeconds }
}
