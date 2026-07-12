export function createSerialJobQueue({
  runJob,
  onChange = () => {},
  onError = () => {},
  maxSize = 25,
} = {}) {
  if (typeof runJob !== 'function') throw new TypeError('Serial job queue requires a runJob function.')

  const capacity = Math.max(1, Math.min(100, Number(maxSize) || 25))
  const pending = []
  let activeId = ''
  let drainPromise = null

  function snapshot() {
    return {
      policy: 'fifo',
      concurrency: 1,
      capacity,
      activeId,
      pending: pending.map((entry) => ({ ...entry })),
      size: pending.length + (activeId ? 1 : 0),
    }
  }

  function notify() {
    onChange(snapshot())
  }

  function position(id) {
    const normalizedId = String(id || '')
    if (activeId === normalizedId) {
      return { state: 'active', position: 0, jobsAhead: 0, ready: true }
    }
    const index = pending.findIndex((entry) => entry.id === normalizedId)
    if (index < 0) return null
    const entry = pending[index]
    const jobsAhead = index + (activeId ? 1 : 0)
    return {
      state: entry.ready ? 'waiting' : 'preparing',
      position: jobsAhead + 1,
      jobsAhead,
      ready: entry.ready,
      reservedAt: entry.reservedAt,
      readyAt: entry.readyAt,
    }
  }

  function schedule() {
    if (drainPromise || !pending[0]?.ready) return
    drainPromise = Promise.resolve()
      .then(drain)
      .finally(() => {
        drainPromise = null
        if (pending[0]?.ready) schedule()
      })
  }

  async function drain() {
    while (!activeId && pending[0]?.ready) {
      const entry = pending.shift()
      activeId = entry.id
      notify()
      try {
        await runJob(activeId)
      } catch (error) {
        await onError(error, activeId)
      } finally {
        activeId = ''
        notify()
      }
    }
  }

  function reserve(id) {
    const normalizedId = String(id || '').trim()
    if (!normalizedId) throw new TypeError('Serial job queue requires a non-empty job id.')
    const existing = position(normalizedId)
    if (existing) return { accepted: true, duplicate: true, ...existing }
    if (pending.length + (activeId ? 1 : 0) >= capacity) {
      return { accepted: false, code: 'queue_full', capacity }
    }
    pending.push({
      id: normalizedId,
      ready: false,
      reservedAt: new Date().toISOString(),
      readyAt: null,
    })
    notify()
    return { accepted: true, duplicate: false, ...position(normalizedId) }
  }

  function markReady(id) {
    const entry = pending.find((candidate) => candidate.id === String(id || ''))
    if (!entry) return false
    if (!entry.ready) {
      entry.ready = true
      entry.readyAt = new Date().toISOString()
      notify()
    }
    schedule()
    return true
  }

  function cancel(id) {
    const index = pending.findIndex((entry) => entry.id === String(id || ''))
    if (index < 0) return false
    pending.splice(index, 1)
    notify()
    schedule()
    return true
  }

  async function whenIdle() {
    while (drainPromise) await drainPromise
  }

  return {
    reserve,
    markReady,
    cancel,
    position,
    snapshot,
    whenIdle,
  }
}
