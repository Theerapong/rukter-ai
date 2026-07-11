import assert from 'node:assert/strict'
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
  const cloudInit = buildAmdWorkerCloudInit({
    workerToken: 'control-secret',
    uploadUrl: 'https://rukter.ai/api/amd-story-assets',
  })
  assert.match(cloudInit, /^#cloud-config/)
  assert.ok(!cloudInit.includes('control-secret'))
  assert.match(cloudInit, /bootstrap\.sh/)
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
    fetchImpl,
  })
  const result = await orchestrator.startLease({ dryRun: true })
  assert.equal(result.status, 'validated')
  assert.equal(result.size, 'gpu-mi300x1-192gb-devcloud')
  assert.equal(result.image, 'gpu-amd-base')
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
      return json({ droplet: { id: 123, status: 'active', created_at: createdAt, networks: { v4: [{ type: 'public', ip_address: '203.0.113.10' }] } } })
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
  assert.equal(createPayload.image, 'gpu-amd-base')
  assert.deepEqual(createPayload.tags, ['rukter-product-story-ephemeral'])
  assert.ok(requests.some((request) => request.method === 'DELETE'))
})

test('reaper destroys an expired tagged GPU lease', async () => {
  const requests = []
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET' })
    if (url.includes('/droplets?')) return json({ droplets: [{ id: 456, created_at: createdAt }] })
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
  assert.equal(capacity.available, true)
  assert.equal(capacity.state, 'requestable')
  assert.equal(capacity.capacitySource, 'developer_cloud_entitlement')
  assert.match(capacity.reason, /create request/i)
})

test('retries Developer Cloud capacity across size aliases and regions', async () => {
  const createRequests = []
  const fetchImpl = async (url, options = {}) => {
    if (url.includes('/droplets?')) return json({ droplets: [] })
    if (url.includes('/sizes?')) return json({ sizes: [] })
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
})

test('adopts an existing portal-created MI300X lease without creating another Droplet', async () => {
  const requests = []
  const createdAt = '2026-07-11T20:16:05Z'
  const existing = {
    id: 583920869,
    status: 'active',
    created_at: createdAt,
    region: { slug: 'atl1' },
    size: { slug: 'gpu-mi300x1-192gb-devcloud' },
  }
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET' })
    if (url.includes('/droplets?')) return json({ droplets: [existing] })
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
  const lease = await orchestrator.startLease()
  assert.equal(lease.id, '583920869')
  assert.equal(lease.adopted, true)
  assert.equal(lease.size, 'gpu-mi300x1-192gb-devcloud')
  assert.ok(!requests.some((request) => request.method === 'POST'))
})
