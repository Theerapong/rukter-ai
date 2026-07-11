function joinUrl(base, path) {
  return `${String(base || '').replace(/\/$/, '')}${path}`
}

async function readJson(response, fallback) {
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload) throw new Error(payload?.error || `${fallback} (${response.status}).`)
  return payload
}

async function wait(ms, signal) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason || new Error('AMD GPU job cancelled.'))
    }, { once: true })
  })
}

export async function runAmdStoryJob({
  orchestratorUrl,
  token = '',
  story,
  sourceImages,
  signal,
  fetchImpl = fetch,
  onEvent = () => {},
  pollIntervalMs = 5_000,
  maxWaitMs = 50 * 60_000,
} = {}) {
  if (!orchestratorUrl) throw new Error('AMD GPU orchestrator is not configured.')
  const headers = {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }
  let lease = null
  try {
    onEvent({ type: 'lease_request', detail: 'Requesting an AMD GPU lease' })
    lease = await readJson(await fetchImpl(joinUrl(orchestratorUrl, '/v1/leases'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ purpose: 'product_story', ttlSeconds: 3000, releasePolicy: 'destroy' }),
      signal,
    }), 'Could not provision AMD GPU')

    const provisioningStartedAt = Date.now()
    while (lease.status !== 'ready' && Date.now() - provisioningStartedAt < maxWaitMs) {
      onEvent({
        type: 'lease_progress',
        detail: lease.phase === 'worker_booting' ? 'AMD MI300X is active; installing and verifying the ROCm worker' : 'Starting AMD MI300X Droplet',
        lease,
      })
      await wait(pollIntervalMs, signal)
      lease = await readJson(await fetchImpl(joinUrl(orchestratorUrl, `/v1/leases/${encodeURIComponent(lease.id)}`), {
        headers,
        signal,
      }), 'Could not read AMD GPU lease status')
    }
    if (lease.status !== 'ready') throw new Error('AMD GPU worker did not become ready before the lease timeout.')

    onEvent({ type: 'lease_ready', detail: lease.gpuDevice || 'AMD GPU ready', lease })
    const workerUrl = lease.workerUrl
    if (!workerUrl) throw new Error('AMD GPU lease did not return a worker URL.')

    const submitted = await readJson(await fetchImpl(joinUrl(workerUrl, '/v1/story-jobs'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ story, sourceImages }),
      signal,
    }), 'Could not submit AMD Product Story')
    const jobId = submitted.jobId
    if (!jobId) throw new Error('AMD worker did not return a job ID.')

    const startedAt = Date.now()
    while (Date.now() - startedAt < maxWaitMs) {
      await wait(pollIntervalMs, signal)
      const status = await readJson(await fetchImpl(joinUrl(workerUrl, `/v1/story-jobs/${encodeURIComponent(jobId)}`), {
        headers,
        signal,
      }), 'Could not read AMD Product Story status')
      onEvent({ type: 'job_progress', detail: status.detail || status.status, progress: status.progress, worker: status })
      if (status.status === 'ready') return { ...status, lease }
      if (status.status === 'failed') throw new Error(status.error || 'AMD Product Story generation failed.')
    }
    throw new Error('AMD Product Story generation timed out.')
  } finally {
    if (lease?.id) {
      onEvent({ type: 'lease_release', detail: 'Releasing AMD GPU to stop billing' })
      const releaseResponse = await fetchImpl(joinUrl(orchestratorUrl, `/v1/leases/${encodeURIComponent(lease.id)}/release`), {
        method: 'POST',
        headers,
        body: JSON.stringify({ policy: 'destroy' }),
      }).catch(() => null)
      if (!releaseResponse?.ok) {
        onEvent({ type: 'lease_release_failed', detail: 'AMD GPU release failed; TTL reaper and manual release are required' })
        throw new Error(`AMD GPU release failed${releaseResponse ? ` (${releaseResponse.status})` : ''}.`)
      }
      onEvent({ type: 'lease_released', detail: 'AMD GPU released' })
    }
  }
}
