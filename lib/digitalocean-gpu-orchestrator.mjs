import { randomUUID } from 'node:crypto'

const apiBase = 'https://api.digitalocean.com/v2'
const defaultTag = 'rukter-product-story-ephemeral'
const defaultPersistentTag = 'rukter-product-story-persistent'
const defaultTtlSeconds = 30 * 60
const defaultAmdDeveloperCloudImage = 'amddevelopercloud-pytorch2100rocm724'

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
    WAN_IDENTITY_CLIP_FALLBACK_THRESHOLD: '0.90',
    WAN_HUMAN_CONTAMINATION_THRESHOLD: '0.225',
    WAN_HUMAN_CONTAMINATION_MARGIN: '0.012',
    WAN_FPS: '16',
    WAN_NUM_FRAMES: '81',
    WAN_INFERENCE_STEPS: '32',
    WAN_STORY_INFERENCE_STEP_BUDGET_PER_PASS: '120',
    WAN_GUIDANCE_SCALE: '4.5',
    WAN_IDENTITY_RETRY_GUIDANCE_SCALE: '3.5',
    WAN_BACKGROUND_TRIM_TOLERANCE: '18',
    WAN_BACKGROUND_TRIM_PADDING_RATIO: '0.06',
    WAN_OCR_LANGUAGES: 'eng+tha',
    STORY_PIPELINE_TIMEOUT_SECONDS: '6600',
    ROCM_WORKER_IMAGE: 'rocm/pytorch:latest',
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
  image = defaultAmdDeveloperCloudImage,
  vpcUuid = '',
  sshKeyFingerprint = '',
  sshKeyName = '',
  tag = defaultTag,
  persistentTag = defaultPersistentTag,
  alwaysOnPersistent = false,
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

  function lifecycleFor(droplet) {
    const tags = new Set(Array.isArray(droplet?.tags) ? droplet.tags : [])
    if (persistentTag && tags.has(persistentTag)) return 'persistent'
    if (tag && tags.has(tag)) return 'ephemeral'
    return 'unmanaged'
  }

  function releasePolicyFor(droplet) {
    return lifecycleFor(droplet) === 'persistent' ? 'retain_after_job' : 'destroy_after_job'
  }

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

  async function listTaggedLeases(tagName) {
    if (!tagName) return []
    const payload = await request(`/droplets?tag_name=${encodeURIComponent(tagName)}&per_page=200`)
    return Array.isArray(payload.droplets) ? payload.droplets : []
  }

  async function listLeases() {
    return listTaggedLeases(tag)
  }

  async function listPersistentLeases() {
    return listTaggedLeases(persistentTag)
  }

  async function listLeaseCandidates() {
    const [persistent, ephemeral] = await Promise.all([listPersistentLeases(), listLeases()])
    const candidates = new Map()
    for (const droplet of [...persistent, ...ephemeral]) {
      if (!droplet?.id || candidates.has(String(droplet.id))) continue
      candidates.set(String(droplet.id), droplet)
    }
    return [...candidates.values()].sort((left, right) => {
      const leftPersistent = lifecycleFor(left) === 'persistent' ? 1 : 0
      const rightPersistent = lifecycleFor(right) === 'persistent' ? 1 : 0
      return rightPersistent - leftPersistent
    })
  }

  async function checkCapacity({ refresh = false } = {}) {
    if (!refresh && capacityCache && now() - capacityCache.checkedAtMs < capacityCacheMs) {
      return capacityCache.value
    }
    const existing = await listLeaseCandidates()
    if (existing.length) {
      const droplet = existing[0]
      const lifecycle = lifecycleFor(droplet)
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
        persistentLease: lifecycle === 'persistent',
        lifecycle,
        releasePolicy: releasePolicyFor(droplet),
        billing: lifecycle === 'persistent' ? 'persistent_active' : 'inactive',
        reason: droplet.status === 'active'
          ? lifecycle === 'persistent'
            ? 'The persistent AMD Instinct MI300X worker is online and remains available between Product Story jobs.'
            : 'An AMD Instinct MI300X worker is online and ready to accept a Product Story job.'
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
    const available = listedCapacity
    const checkedAt = new Date(now()).toISOString()
    const value = {
      state: listedCapacity ? 'available' : developerCloudEntitlement ? 'requestable' : 'unavailable',
      available,
      requestable: !listedCapacity && developerCloudEntitlement,
      region: selectedRegion,
      configuredRegion: region,
      size,
      availableRegions,
      checkedAt,
      capacitySource: listedCapacity ? 'sizes_api' : developerCloudEntitlement ? 'developer_cloud_entitlement' : 'sizes_api',
      persistentLease: false,
      lifecycle: 'none',
      releasePolicy: 'destroy_after_job',
      billing: 'inactive',
      reason: listedCapacity
        ? `AMD Instinct MI300X capacity is available in ${selectedRegion.toUpperCase()}. The GPU starts only when the story job begins.`
        : developerCloudEntitlement
          ? 'AMD Developer Cloud is configured for on-demand MI300X provisioning. Capacity is confirmed when the story job starts; no GPU billing has started.'
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
    const payload = await request(`/droplets/${id}`)
    const lifecycle = lifecycleFor(payload.droplet)
    if (lifecycle === 'persistent') {
      return {
        id,
        status: 'retained',
        billing: 'persistent_active',
        lifecycle,
        persistent: true,
        releasePolicy: 'retain_after_job',
      }
    }
    if (lifecycle !== 'ephemeral') {
      throw new Error('Refusing to destroy an unmanaged AMD GPU Droplet.')
    }
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
    return { id, status: 'released', billing: 'inactive', lifecycle, persistent: false, releasePolicy: 'destroy_after_job' }
  }

  async function reapExpiredLeases({ excludeLeaseIds = [] } = {}) {
    const droplets = await listLeases()
    const released = []
    const excluded = new Set(excludeLeaseIds.map((id) => String(id)))
    for (const droplet of droplets) {
      if (lifecycleFor(droplet) === 'persistent' || excluded.has(String(droplet.id))) {
        excluded.add(String(droplet.id))
        continue
      }
      const createdAt = new Date(droplet.created_at).getTime()
      if (!Number.isFinite(createdAt) || now() - createdAt < leaseTtlSeconds * 1000) continue
      await releaseLease(droplet.id)
      released.push(String(droplet.id))
    }
    return { checked: droplets.length, released, protected: [...excluded], ttlSeconds: leaseTtlSeconds }
  }

  async function dropletRequest({ selectedRegion = region, selectedSize = size, lifecycle = 'ephemeral' } = {}) {
    const sshKey = await resolveSshKey()
    const persistent = lifecycle === 'persistent'
    const name = persistent ? 'rukter-product-story-persistent' : `rukter-story-${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const userData = buildAmdWorkerCloudInit({
      workerToken,
      uploadUrl: `${String(publicUrl || '').replace(/\/$/, '')}/api/amd-story-assets`,
      sourceBaseUrl: workerSourceBaseUrl || `${String(publicUrl || '').replace(/\/$/, '')}/amd-worker`,
    })
    return {
      name,
      region: selectedRegion,
      size: selectedSize,
      image,
      ssh_keys: [sshKey],
      backups: false,
      ipv6: false,
      monitoring: true,
      tags: [persistent ? persistentTag : tag],
      user_data: userData,
      ...(vpcUuid ? { vpc_uuid: vpcUuid } : {}),
    }
  }

  async function startLease({ dryRun = false, signal, persistent = alwaysOnPersistent } = {}) {
    await reapExpiredLeases()
    const existing = persistent ? await listPersistentLeases() : await listLeaseCandidates()
    if (persistent && existing.length > 1) {
      throw new Error(`Expected one persistent AMD GPU Droplet tagged ${persistentTag}; found ${existing.length}.`)
    }
    if (existing.length) {
      const droplet = existing[0]
      const lifecycle = lifecycleFor(droplet)
      const existingRegion = droplet?.region?.slug || region
      const existingSize = droplet?.size_slug || droplet?.size?.slug || size
      return {
        id: safeDropletId(droplet.id),
        status: 'provisioning',
        phase: droplet.status === 'active' ? 'worker_booting' : 'droplet_starting',
        region: existingRegion,
        size: existingSize,
        createdAt: droplet.created_at,
        expiresAt: lifecycle === 'persistent' ? null : new Date(new Date(droplet.created_at).getTime() + leaseTtlSeconds * 1000).toISOString(),
        releasePolicy: releasePolicyFor(droplet),
        lifecycle,
        persistent: lifecycle === 'persistent',
        adopted: true,
      }
    }
    const capacity = dryRun ? null : await checkCapacity({ refresh: true })
    if (capacity && !capacity.available && !capacity.requestable) throw new Error(capacity.reason)
    const lifecycle = persistent ? 'persistent' : 'ephemeral'
    const createRequest = await dropletRequest({ selectedRegion: capacity?.region || region, lifecycle })
    if (dryRun) {
      return {
        status: 'validated',
        region: createRequest.region,
        size: createRequest.size,
        image: createRequest.image,
        tag: persistent ? persistentTag : tag,
        ttlSeconds: persistent ? null : leaseTtlSeconds,
        persistent,
        releasePolicy: persistent ? 'retain_after_job' : 'destroy_after_job',
        sshKeyConfigured: createRequest.ssh_keys.length === 1,
        cloudInitBytes: Buffer.byteLength(createRequest.user_data),
      }
    }

    const candidateRegions = [...new Set([
      capacity?.region,
      region,
      'nyc2',
      'tor1',
    ].filter(Boolean))]
    const candidateSizes = [...new Set([
      size,
      ...(capacity?.requestable ? [] : [size.replace(/-devcloud$/, '')]),
    ].filter(Boolean))]
    let created = null
    let acceptedRequest = null
    const capacityErrors = []
    for (const candidateRegion of candidateRegions) {
      for (const candidateSize of candidateSizes) {
        const candidateRequest = {
          ...createRequest,
          region: candidateRegion,
          size: candidateSize,
        }
        if (candidateRegion !== region) delete candidateRequest.vpc_uuid
        try {
          created = await request('/droplets', {
            method: 'POST',
            body: JSON.stringify(candidateRequest),
            signal,
          })
          acceptedRequest = candidateRequest
          break
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (!/unavailable|capacity|region/i.test(message)) throw error
          capacityErrors.push(`${candidateRegion}/${candidateSize}: ${message}`)
        }
      }
      if (created) break
    }
    if (!created || !acceptedRequest) {
      throw new Error(`AMD MI300X capacity is unavailable in ${candidateRegions.map((value) => value.toUpperCase()).join(', ')}. ${capacityErrors.at(-1) || ''}`.trim())
    }
    const dropletId = safeDropletId(created.droplet?.id)
    return {
      id: dropletId,
      status: 'provisioning',
      phase: 'droplet_starting',
      region: acceptedRequest.region,
      size: acceptedRequest.size,
      createdAt: created.droplet?.created_at || new Date(now()).toISOString(),
      expiresAt: persistent ? null : new Date(now() + leaseTtlSeconds * 1000).toISOString(),
      releasePolicy: persistent ? 'retain_after_job' : 'destroy_after_job',
      lifecycle,
      persistent,
    }
  }

  async function inspectLease(leaseId, { signal } = {}) {
    const id = safeDropletId(leaseId)
    const payload = await request(`/droplets/${id}`, { signal })
    const droplet = payload.droplet
    const lifecycle = lifecycleFor(droplet)
    const ip = publicIpv4(droplet)
    const base = {
      id,
      status: 'provisioning',
      phase: droplet?.status === 'active' ? 'worker_booting' : 'droplet_starting',
      region: droplet?.region?.slug || region,
      size: droplet?.size_slug || droplet?.size?.slug || size,
      createdAt: droplet?.created_at,
      expiresAt: lifecycle === 'persistent' ? null : new Date(new Date(droplet?.created_at).getTime() + leaseTtlSeconds * 1000).toISOString(),
      releasePolicy: releasePolicyFor(droplet),
      lifecycle,
      persistent: lifecycle === 'persistent',
    }
    if (droplet?.status !== 'active' || !ip) return base
    const workerUrl = `http://${ip}:8080`
    const healthResponse = await fetchImpl(`${workerUrl}/health`, {
      headers: workerToken ? { authorization: `Bearer ${workerToken}` } : {},
      signal: AbortSignal.timeout(8_000),
    }).catch(() => null)
    const health = healthResponse?.ok ? await healthResponse.json().catch(() => null) : null
    if (health?.status !== 'ok' || health?.available !== true || health?.acceptingJobs === false) return base
    return {
      ...base,
      status: 'ready',
      phase: 'worker_ready',
      workerUrl,
      gpuDevice: health.device || 'AMD Instinct MI300X',
      rocmVersion: health.rocmVersion || '',
      gpuTelemetry: health.gpuTelemetry || null,
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

  async function ensurePersistentLease(options = {}) {
    return createLease({ ...options, persistent: true })
  }

  return { startLease, inspectLease, createLease, ensurePersistentLease, releaseLease, reapExpiredLeases, listLeases, listPersistentLeases, checkCapacity, leaseTtlSeconds }
}
