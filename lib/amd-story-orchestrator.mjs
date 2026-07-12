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
    const finish = (callback, value) => {
      signal?.removeEventListener('abort', onAbort)
      callback(value)
    }
    const timer = setTimeout(() => finish(resolve), ms)
    const onAbort = () => {
      clearTimeout(timer)
      finish(reject, signal.reason || new Error('AMD GPU job cancelled.'))
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
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
  let workerUrl = ''
  let workerJobId = ''
  let workerCompleted = false
  try {
    onEvent({ type: 'lease_request', detail: 'Requesting an AMD GPU lease' })
    lease = await readJson(await fetchImpl(joinUrl(orchestratorUrl, '/v1/leases'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ purpose: 'product_story', ttlSeconds: 1800, releasePolicy: 'destroy' }),
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
    workerUrl = lease.workerUrl
    if (!workerUrl) throw new Error('AMD GPU lease did not return a worker URL.')

    const submitted = await readJson(await fetchImpl(joinUrl(workerUrl, '/v1/story-jobs'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ story, sourceImages }),
      signal,
    }), 'Could not submit AMD Product Story')
    workerJobId = submitted.jobId
    if (!workerJobId) throw new Error('AMD worker did not return a job ID.')

    const startedAt = Date.now()
    while (Date.now() - startedAt < maxWaitMs) {
      await wait(pollIntervalMs, signal)
      const status = await readJson(await fetchImpl(joinUrl(workerUrl, `/v1/story-jobs/${encodeURIComponent(workerJobId)}`), {
        headers,
        signal,
      }), 'Could not read AMD Product Story status')
      onEvent({ type: 'job_progress', detail: status.detail || status.status, progress: status.progress, worker: status })
      if (status.status === 'ready') {
        workerCompleted = true
        return { ...status, lease }
      }
      if (status.status === 'failed') throw new Error(status.error || 'AMD Product Story generation failed.')
      if (status.status === 'cancelled') throw new Error('AMD Product Story generation was cancelled.')
    }
    throw new Error('AMD Product Story generation timed out.')
  } finally {
    if (!workerCompleted && workerUrl && workerJobId) {
      await fetchImpl(joinUrl(workerUrl, `/v1/story-jobs/${encodeURIComponent(workerJobId)}/cancel`), {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null)
    }
    if (lease?.id) {
      onEvent({
        type: 'lease_release',
        detail: lease.releasePolicy === 'retain_after_job'
          ? 'Applying persistent AMD GPU retention policy'
          : 'Releasing AMD GPU to stop billing',
        lease,
      })
      const releaseResponse = await fetchImpl(joinUrl(orchestratorUrl, `/v1/leases/${encodeURIComponent(lease.id)}/release`), {
        method: 'POST',
        headers,
        body: JSON.stringify({ policy: 'destroy' }),
      }).catch(() => null)
      if (!releaseResponse?.ok) {
        onEvent({ type: 'lease_release_failed', detail: 'AMD GPU release failed; TTL reaper and manual release are required' })
        throw new Error(`AMD GPU release failed${releaseResponse ? ` (${releaseResponse.status})` : ''}.`)
      }
      const releasedLease = await releaseResponse.json().catch(() => null)
      if (releasedLease?.status === 'retained' || releasedLease?.releasePolicy === 'retain_after_job') {
        onEvent({ type: 'lease_retained', detail: 'Persistent AMD GPU retained online for the next job', lease: releasedLease })
      } else {
        onEvent({ type: 'lease_released', detail: 'AMD GPU released', lease: releasedLease })
      }
    }
  }
}
