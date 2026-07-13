import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
  buildAmdWorkerCloudInit,
  createDigitalOceanGpuOrchestrator,
} from '../lib/digitalocean-gpu-orchestrator.mjs'

const createdAt = '2026-07-11T18:00:00Z'

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

test('builds cloud-init without placing the worker token in shell commands', () => {
  const persistentBootstrap = readFileSync(path.join(process.cwd(), 'scripts', 'bootstrap-persistent-amd.sh'), 'utf8')
  const cloudInit = buildAmdWorkerCloudInit({
    workerToken: 'control-secret',
    uploadUrl: 'https://rukter.ai/api/amd-story-assets',
  })
  assert.match(cloudInit, /^#cloud-config/)
  assert.ok(!cloudInit.includes('control-secret'))
  assert.match(cloudInit, /bootstrap\.sh/)
  const encodedEnvironment = cloudInit.match(/content: (\S+)/)?.[1]
  assert.ok(encodedEnvironment)
  const environment = Buffer.from(encodedEnvironment, 'base64').toString('utf8')
  assert.match(environment, /ROCM_WORKER_IMAGE=rocm\/pytorch:latest/)
  assert.match(environment, /WAN_IDENTITY_CLIP_FALLBACK_THRESHOLD=0\.90/)
  assert.match(environment, /WAN_HUMAN_CONTAMINATION_THRESHOLD=0\.225/)
  assert.match(environment, /WAN_HUMAN_CONTAMINATION_MARGIN=0\.012/)
  assert.match(environment, /WAN_HUMAN_CONTAMINATION_SOURCE_DELTA=0\.020/)
  assert.match(persistentBootstrap, /WAN_HUMAN_CONTAMINATION_SOURCE_DELTA=0\.020/)
  assert.match(environment, /WAN_COLOR_DISTRIBUTION_THRESHOLD=0\.48/)
  assert.match(persistentBootstrap, /WAN_COLOR_DISTRIBUTION_THRESHOLD=0\.48/)
  assert.match(environment, /WAN_EDGE_INTRUSION_THRESHOLD=0\.0025/)
  assert.match(persistentBootstrap, /WAN_EDGE_INTRUSION_THRESHOLD=0\.0025/)
  assert.match(environment, /WAN_NUM_FRAMES=81/)
  assert.match(environment, /WAN_INFERENCE_STEPS=32/)
  assert.match(environment, /WAN_STORY_INFERENCE_STEP_BUDGET_PER_PASS=120/)
  assert.match(environment, /WAN_OCR_LANGUAGES=eng\+tha/)
  assert.match(environment, /STORY_PIPELINE_TIMEOUT_SECONDS=6600/)
  assert.match(environment, /WAN_GUIDANCE_SCALE=4\.5/)
  assert.match(environment, /WAN_IDENTITY_RETRY_GUIDANCE_SCALE=3\.5/)
  assert.match(environment, /WAN_BACKGROUND_TRIM_TOLERANCE=18/)
  assert.match(environment, /WAN_BACKGROUND_TRIM_PADDING_RATIO=0\.06/)
})

test('validates an AMD GPU lease request without creating a billed Droplet', async () => {
  const requests = []
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET' })
    if (url.includes('/account/keys')) return json({ ssh_keys: [{ name: 'rukter-key', fingerprint: 'aa:bb' }] })
    if (url.includes('/droplets?')) return json({ droplets: [] })
    throw new Error(`Unexpected request: ${url}`)
  }
  const orchestrator = createDigitalOceanGpuOrchestrator({
    token: 'do-token',
    workerToken: 'control-token',
    publicUrl: 'https://rukter.ai',
    sshKeyName: 'rukter-key',
    vpcUuid: '00000000-0000-4000-8000-000000000001',
    fetchImpl,
  })
  const result = await orchestrator.startLease({ dryRun: true })
  assert.equal(result.status, 'validated')
  assert.equal(result.size, 'gpu-mi300x1-192gb-devcloud')
  assert.equal(result.image, 'amddevelopercloud-pytorch2100rocm724')
  assert.ok(!requests.some((request) => request.method === 'POST'))
})

test('creates, verifies, and destroys one MI300X lease', async () => {
  const requests = []
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET', body: options.body })
    if (url.includes('/account/keys')) return json({ ssh_keys: [{ name: 'rukter-key', fingerprint: 'aa:bb' }] })
    if (url.includes('/droplets?')) return json({ droplets: [] })
    if (url.includes('/sizes?')) return json({ sizes: [{ slug: 'gpu-mi300x1-192gb-devcloud', available: true, regions: ['atl1'] }] })
    if (url.endsWith('/v2/droplets') && options.method === 'POST') {
      return json({ droplet: { id: 123, created_at: createdAt } }, 202)
    }
    if (url.endsWith('/v2/droplets/123') && options.method === 'DELETE') return new Response(null, { status: 204 })
    if (url.endsWith('/v2/droplets/123')) {
      return json({ droplet: { id: 123, status: 'active', created_at: createdAt, tags: ['rukter-product-story-ephemeral'], networks: { v4: [{ type: 'public', ip_address: '203.0.113.10' }] } } })
    }
    if (url === 'http://203.0.113.10:8080/health') {
      return json({ status: 'ok', available: true, device: 'AMD Instinct MI300X', rocmVersion: '7.2.4' })
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  const orchestrator = createDigitalOceanGpuOrchestrator({
    token: 'do-token',
    workerToken: 'control-token',
    publicUrl: 'https://rukter.ai',
    sshKeyName: 'rukter-key',
    fetchImpl,
    pollIntervalMs: 1,
  })
  const started = await orchestrator.startLease()
  assert.equal(started.status, 'provisioning')
  const ready = await orchestrator.inspectLease(started.id)
  assert.equal(ready.status, 'ready')
  assert.equal(ready.gpuDevice, 'AMD Instinct MI300X')
  await orchestrator.releaseLease(started.id)
  const createPayload = JSON.parse(requests.find((request) => request.method === 'POST').body)
  assert.equal(createPayload.size, 'gpu-mi300x1-192gb-devcloud')
  assert.equal(createPayload.region, 'atl1')
  assert.equal(createPayload.image, 'amddevelopercloud-pytorch2100rocm724')
  assert.equal(createPayload.monitoring, true)
  assert.deepEqual(createPayload.tags, ['rukter-product-story-ephemeral'])
  assert.ok(requests.some((request) => request.method === 'DELETE'))
})

test('creates an always-on persistent MI300X lease instead of an ephemeral lease', async () => {
  let createPayload
  const fetchImpl = async (url, options = {}) => {
    if (url.includes('tag_name=rukter-product-story-ephemeral')) return json({ droplets: [] })
    if (url.includes('tag_name=rukter-product-story-persistent')) return json({ droplets: [] })
    if (url.includes('/sizes?')) return json({ sizes: [{ slug: 'gpu-mi300x1-192gb-devcloud', available: true, regions: ['atl1'] }] })
    if (url.includes('/account/keys')) return json({ ssh_keys: [{ name: 'rukter-key', fingerprint: 'aa:bb' }] })
    if (url.endsWith('/v2/droplets') && options.method === 'POST') {
      createPayload = JSON.parse(options.body)
      return json({ droplet: { id: 321, created_at: createdAt } }, 202)
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  const orchestrator = createDigitalOceanGpuOrchestrator({
    token: 'do-token',
    workerToken: 'control-token',
    publicUrl: 'https://rukter.ai',
    sshKeyName: 'rukter-key',
    fetchImpl,
    alwaysOnPersistent: true,
  })
  const lease = await orchestrator.startLease()
  assert.equal(lease.id, '321')
  assert.equal(lease.persistent, true)
  assert.equal(lease.lifecycle, 'persistent')
  assert.equal(lease.releasePolicy, 'retain_after_job')
  assert.equal(lease.expiresAt, null)
  assert.deepEqual(createPayload.tags, ['rukter-product-story-persistent'])
  assert.equal(createPayload.name, 'rukter-product-story-persistent')
})

test('ensures the persistent MI300X worker is ready for user jobs', async () => {
  const existing = {
    id: 584070698,
    status: 'active',
    created_at: createdAt,
    tags: ['rukter-product-story-persistent'],
    networks: { v4: [{ type: 'public', ip_address: '203.0.113.44' }] },
  }
  const fetchImpl = async (url) => {
    if (url.includes('tag_name=rukter-product-story-ephemeral')) return json({ droplets: [] })
    if (url.includes('tag_name=rukter-product-story-persistent')) return json({ droplets: [existing] })
    if (url.endsWith('/v2/droplets/584070698')) return json({ droplet: existing })
    if (url === 'http://203.0.113.44:8080/health') {
      return json({ status: 'ok', available: true, acceptingJobs: true, device: 'AMD Instinct MI300X VF', rocmVersion: '7.2.4' })
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  const orchestrator = createDigitalOceanGpuOrchestrator({
    token: 'do-token',
    workerToken: 'control-token',
    publicUrl: 'https://rukter.ai',
    fetchImpl,
    pollIntervalMs: 1,
  })
  const lease = await orchestrator.ensurePersistentLease()
  assert.equal(lease.status, 'ready')
  assert.equal(lease.persistent, true)
  assert.equal(lease.releasePolicy, 'retain_after_job')
  assert.equal(lease.workerUrl, 'http://203.0.113.44:8080')
})

test('bootstraps the DigitalOcean metrics agent for GPU Insights', () => {
  const bootstrap = readFileSync(new URL('../amd-worker/bootstrap.sh', import.meta.url), 'utf8')
  assert.match(bootstrap, /repos\.insights\.digitalocean\.com\/install\.sh/)
  assert.match(bootstrap, /systemctl enable --now do-agent/)
  assert.match(bootstrap, /systemctl is-active --quiet do-agent/)
})

test('reaper destroys an expired tagged GPU lease', async () => {
  const requests = []
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET' })
    if (url.includes('/droplets?')) return json({ droplets: [{ id: 456, created_at: createdAt, tags: ['rukter-product-story-ephemeral'] }] })
    if (url.endsWith('/droplets/456') && !options.method) return json({ droplet: { id: 456, created_at: createdAt, tags: ['rukter-product-story-ephemeral'] } })
    if (url.endsWith('/droplets/456') && options.method === 'DELETE') return new Response(null, { status: 204 })
    throw new Error(`Unexpected request: ${url}`)
  }
  const orchestrator = createDigitalOceanGpuOrchestrator({
    token: 'do-token',
    workerToken: 'control-token',
    publicUrl: 'https://rukter.ai',
    fetchImpl,
    ttlSeconds: 3000,
    now: () => new Date('2026-07-11T19:00:00Z').getTime(),
  })
  const result = await orchestrator.reapExpiredLeases()
  assert.deepEqual(result.released, ['456'])
  assert.ok(requests.some((request) => request.method === 'DELETE'))
})

test('reaper preserves a lease attached to an active story job', async () => {
  const requests = []
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET' })
    if (url.includes('/droplets?')) return json({ droplets: [{ id: 456, created_at: createdAt }] })
    throw new Error(`Unexpected request: ${url}`)
  }
  const orchestrator = createDigitalOceanGpuOrchestrator({
    token: 'do-token',
    fetchImpl,
    now: () => new Date('2026-07-11T19:00:00Z').getTime(),
  })
  const result = await orchestrator.reapExpiredLeases({ excludeLeaseIds: ['456'] })
  assert.deepEqual(result.released, [])
  assert.deepEqual(result.protected, ['456'])
  assert.ok(!requests.some((request) => request.method === 'DELETE'))
})

test('checks live MI300X capacity without creating a Droplet', async () => {
  const requests = []
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET' })
    if (url.includes('/droplets?')) return json({ droplets: [] })
    if (url.includes('/sizes?')) return json({ sizes: [{ slug: 'gpu-mi300x1-192gb', available: true, regions: ['atl1'] }] })
    throw new Error(`Unexpected request: ${url}`)
  }
  const orchestrator = createDigitalOceanGpuOrchestrator({
    token: 'do-token',
    region: 'atl1',
    size: 'gpu-mi300x1-192gb',
    fetchImpl,
  })
  const capacity = await orchestrator.checkCapacity({ refresh: true })
  assert.equal(capacity.available, true)
  assert.equal(capacity.state, 'available')
  assert.deepEqual(capacity.availableRegions, ['atl1'])
  assert.ok(!requests.some((request) => request.method === 'POST'))
})

test('selects another live AMD region when the configured region is full', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/droplets?')) return json({ droplets: [] })
    if (url.includes('/sizes?')) return json({ sizes: [{ slug: 'gpu-mi300x1-192gb', available: true, regions: ['nyc2'] }] })
    throw new Error(`Unexpected request: ${url}`)
  }
  const orchestrator = createDigitalOceanGpuOrchestrator({
    token: 'do-token',
    region: 'atl1',
    size: 'gpu-mi300x1-192gb',
    fetchImpl,
  })
  const capacity = await orchestrator.checkCapacity({ refresh: true })
  assert.equal(capacity.available, true)
  assert.equal(capacity.region, 'nyc2')
  assert.equal(capacity.configuredRegion, 'atl1')
})

test('reports no MI300X capacity without starting billing', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/droplets?')) return json({ droplets: [] })
    if (url.includes('/sizes?')) return json({ sizes: [{ slug: 'gpu-mi300x1-192gb', available: true, regions: [] }] })
    throw new Error(`Unexpected request: ${url}`)
  }
  const orchestrator = createDigitalOceanGpuOrchestrator({
    token: 'do-token',
    region: 'atl1',
    size: 'gpu-mi300x1-192gb',
    fetchImpl,
  })
  const capacity = await orchestrator.checkCapacity({ refresh: true })
  assert.equal(capacity.available, false)
  assert.match(capacity.reason, /no MI300X capacity/i)
})

test('keeps an unlisted AMD Developer Cloud entitlement requestable', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/droplets?')) return json({ droplets: [] })
    if (url.includes('/sizes?')) return json({ sizes: [] })
    throw new Error(`Unexpected request: ${url}`)
  }
  const orchestrator = createDigitalOceanGpuOrchestrator({
    token: 'do-token',
    region: 'atl1',
    size: 'gpu-mi300x1-192gb-devcloud',
    fetchImpl,
  })
  const capacity = await orchestrator.checkCapacity({ refresh: true })
  assert.equal(capacity.available, false)
  assert.equal(capacity.requestable, true)
  assert.equal(capacity.state, 'requestable')
  assert.equal(capacity.capacitySource, 'developer_cloud_entitlement')
  assert.match(capacity.reason, /on-demand/i)
})

test('creates an entitled Developer Cloud GPU on demand with the official image and VPC contract', async () => {
  let createPayload
  const fetchImpl = async (url, options = {}) => {
    if (url.includes('/droplets?')) return json({ droplets: [] })
    if (url.includes('/sizes?')) return json({ sizes: [] })
    if (url.includes('/account/keys')) return json({ ssh_keys: [{ name: 'rukter-key', id: 57723406 }] })
    if (url.endsWith('/v2/droplets') && options.method === 'POST') {
      createPayload = JSON.parse(options.body)
      return json({ droplet: { id: 987, created_at: createdAt } }, 202)
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  const orchestrator = createDigitalOceanGpuOrchestrator({
    token: 'do-token',
    workerToken: 'control-token',
    publicUrl: 'https://rukter.ai',
    sshKeyName: 'rukter-key',
    vpcUuid: '00000000-0000-4000-8000-000000000001',
    fetchImpl,
  })
  const lease = await orchestrator.startLease()
  assert.equal(lease.id, '987')
  assert.equal(createPayload.image, 'amddevelopercloud-pytorch2100rocm724')
  assert.equal(createPayload.size, 'gpu-mi300x1-192gb-devcloud')
  assert.equal(createPayload.region, 'atl1')
  assert.equal(createPayload.monitoring, true)
  assert.equal(createPayload.vpc_uuid, '00000000-0000-4000-8000-000000000001')
})

test('retries Developer Cloud capacity across size aliases and regions', async () => {
  const createRequests = []
  const fetchImpl = async (url, options = {}) => {
    if (url.includes('/droplets?')) return json({ droplets: [] })
    if (url.includes('/sizes?')) {
      return json({ sizes: [{ slug: 'gpu-mi300x1-192gb-devcloud', available: true, regions: ['atl1'] }] })
    }
    if (url.includes('/account/keys')) return json({ ssh_keys: [{ name: 'rukter-key', fingerprint: 'aa:bb' }] })
    if (url.endsWith('/v2/droplets') && options.method === 'POST') {
      const payload = JSON.parse(options.body)
      createRequests.push(payload)
      if (payload.region === 'nyc2' && payload.size === 'gpu-mi300x1-192gb-devcloud') {
        return json({ droplet: { id: 789, created_at: createdAt } }, 202)
      }
      return json({ message: 'This size is unavailable.' }, 422)
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  const orchestrator = createDigitalOceanGpuOrchestrator({
    token: 'do-token',
    workerToken: 'control-token',
    publicUrl: 'https://rukter.ai',
    sshKeyName: 'rukter-key',
    vpcUuid: '00000000-0000-4000-8000-000000000001',
    fetchImpl,
  })
  const lease = await orchestrator.startLease()
  assert.equal(lease.id, '789')
  assert.equal(lease.region, 'nyc2')
  assert.equal(lease.size, 'gpu-mi300x1-192gb-devcloud')
  assert.deepEqual(
    createRequests.map(({ region, size: requestSize }) => `${region}/${requestSize}`),
    [
      'atl1/gpu-mi300x1-192gb-devcloud',
      'atl1/gpu-mi300x1-192gb',
      'nyc2/gpu-mi300x1-192gb-devcloud',
    ],
  )
  assert.equal(createRequests[0].vpc_uuid, '00000000-0000-4000-8000-000000000001')
  assert.equal(createRequests[2].vpc_uuid, undefined)
})

test('adopts an existing portal-created MI300X lease without creating another Droplet', async () => {
  const requests = []
  const createdAt = '2026-07-11T20:16:05Z'
  const existing = {
    id: 583920869,
    status: 'active',
    created_at: createdAt,
    tags: ['rukter-product-story-persistent'],
    region: { slug: 'atl1' },
    size: { slug: 'gpu-mi300x1-192gb-devcloud' },
  }
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET' })
    if (url.includes('tag_name=rukter-product-story-persistent')) return json({ droplets: [existing] })
    if (url.includes('tag_name=rukter-product-story-ephemeral')) return json({ droplets: [] })
    throw new Error(`Unexpected request: ${url}`)
  }
  const orchestrator = createDigitalOceanGpuOrchestrator({
    token: 'do-token',
    fetchImpl,
    now: () => new Date('2026-07-11T20:20:00Z').getTime(),
  })
  const capacity = await orchestrator.checkCapacity({ refresh: true })
  assert.equal(capacity.available, true)
  assert.equal(capacity.existingLease, true)
  assert.equal(capacity.persistentLease, true)
  assert.equal(capacity.releasePolicy, 'retain_after_job')
  const lease = await orchestrator.startLease()
  assert.equal(lease.id, '583920869')
  assert.equal(lease.adopted, true)
  assert.equal(lease.persistent, true)
  assert.equal(lease.releasePolicy, 'retain_after_job')
  assert.equal(lease.size, 'gpu-mi300x1-192gb-devcloud')
  assert.ok(!requests.some((request) => request.method === 'POST'))
})

test('retains a persistent MI300X lease even when release is requested', async () => {
  const requests = []
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET' })
    if (url.endsWith('/droplets/584070698')) {
      return json({ droplet: { id: 584070698, tags: ['rukter-product-story-persistent'] } })
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  const orchestrator = createDigitalOceanGpuOrchestrator({ token: 'do-token', fetchImpl })
  const inspected = await orchestrator.inspectLease('584070698')
  assert.equal(inspected.lifecycle, 'persistent')
  assert.equal(inspected.releasePolicy, 'retain_after_job')
  const result = await orchestrator.releaseLease('584070698')
  assert.equal(result.status, 'retained')
  assert.equal(result.billing, 'persistent_active')
  assert.equal(result.releasePolicy, 'retain_after_job')
  assert.ok(!requests.some((request) => request.method === 'DELETE'))
})

test('never reaps a persistent Droplet even if it also has the ephemeral tag', async () => {
  const requests = []
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET' })
    if (url.includes('/droplets?')) {
      return json({ droplets: [{
        id: 584070698,
        created_at: createdAt,
        tags: ['rukter-product-story-persistent', 'rukter-product-story-ephemeral'],
      }] })
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  const orchestrator = createDigitalOceanGpuOrchestrator({
    token: 'do-token',
    fetchImpl,
    now: () => new Date('2026-07-11T23:00:00Z').getTime(),
  })
  const result = await orchestrator.reapExpiredLeases()
  assert.deepEqual(result.released, [])
  assert.deepEqual(result.protected, ['584070698'])
  assert.ok(!requests.some((request) => request.method === 'DELETE'))
})

test('refuses to release an unmanaged GPU Droplet', async () => {
  const requests = []
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET' })
    if (url.endsWith('/droplets/999')) return json({ droplet: { id: 999, tags: [] } })
    throw new Error(`Unexpected request: ${url}`)
  }
  const orchestrator = createDigitalOceanGpuOrchestrator({ token: 'do-token', fetchImpl })
  await assert.rejects(() => orchestrator.releaseLease('999'), /unmanaged/i)
  assert.ok(!requests.some((request) => request.method === 'DELETE'))
})
