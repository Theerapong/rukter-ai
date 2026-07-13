const $ = (selector) => document.querySelector(selector)
const refreshButton = $('#refreshButton')
const lastUpdated = $('#lastUpdated')
const statusAlert = $('#statusAlert')
const workerState = $('#workerState')
const workerNote = $('#workerNote')
const utilizationValue = $('#utilizationValue')
const vramValue = $('#vramValue')
const temperatureValue = $('#temperatureValue')
const memoryNote = $('#memoryNote')
const powerNote = $('#powerNote')
const lifecycleBadge = $('#lifecycleBadge')
const workerFacts = $('#workerFacts')
const queueFacts = $('#queueFacts')
let pollTimer

function valueOrDash(value, suffix = '') {
  return Number.isFinite(Number(value)) ? `${Number(value)}${suffix}` : '—'
}

function setFacts(target, rows) {
  target.replaceChildren(...rows.flatMap(([label, value]) => {
    const dt = document.createElement('dt')
    dt.textContent = label
    const dd = document.createElement('dd')
    dd.textContent = value
    return [dt, dd]
  }))
}

function render(status) {
  const telemetry = status.worker?.gpuTelemetry || {}
  const workerReady = status.worker?.reachable && status.worker?.available
  const workerBusy = status.worker?.activeJobPresent || status.worker?.pipelineProcessPresent
  workerState.textContent = workerReady ? (workerBusy ? 'Rendering' : 'Ready') : 'Unavailable'
  workerNote.textContent = status.worker?.reason || 'Worker status verified by the AMD orchestrator.'
  utilizationValue.textContent = valueOrDash(telemetry.utilizationPct, '%')
  vramValue.textContent = valueOrDash(telemetry.vramPct, '%')
  temperatureValue.textContent = valueOrDash(telemetry.temperatureC, ' °C')
  memoryNote.textContent = `Power ${valueOrDash(telemetry.powerWatts, ' W')}`
  powerNote.textContent = `ROCm sample ${telemetry.sampledAt ? new Date(telemetry.sampledAt).toLocaleTimeString() : 'not available'}`
  lifecycleBadge.textContent = status.policy?.alwaysOn ? 'Always-on' : 'Retained'
  lifecycleBadge.className = `status-pill ${workerReady ? 'status-pill-good' : 'status-pill-warn'}`
  setFacts(workerFacts, [
    ['Device', status.capacity?.size || 'AMD MI300X'],
    ['Region', status.capacity?.region || '—'],
    ['Worker version', status.worker?.workerVersion || '—'],
    ['GPU billing', status.capacity?.billing || '—'],
    ['Auto shutdown', status.policy?.autoShutdown === false ? 'Disabled' : 'Not verified'],
    ['Worker updates', status.worker?.updatePending ? 'Pending' : 'Clear'],
  ])
  setFacts(queueFacts, [
    ['Active sessions', status.users?.activeSessions ?? 0],
    ['Active requests', status.users?.activeRequests ?? 0],
    ['Active GPU jobs', status.users?.activeGpuJobs ?? 0],
    ['Queued GPU jobs', status.users?.queuedGpuJobs ?? 0],
    ['Queue slot', status.queue?.activeSlot || 'idle'],
    ['Queue policy', status.queue?.policy || 'fifo'],
    ['Worker processes', status.worker?.pipelineProcessPresent ? 'Running' : 'Idle'],
  ])
  statusAlert.hidden = !(status.worker?.activeJobPresent || status.worker?.pipelineProcessPresent)
  statusAlert.textContent = statusAlert.hidden ? '' : 'The persistent AMD worker is currently processing a Product Story job. Deployment safety should remain blocked until the job and process settle.'
  lastUpdated.textContent = `Updated ${new Date(status.checkedAt || Date.now()).toLocaleTimeString()} · refreshes every 10s`
}

async function refresh() {
  refreshButton.disabled = true
  try {
    const response = await fetch('/api/gpu-status', { cache: 'no-store' })
    const status = await response.json()
    if (!response.ok) throw new Error(status.error || status.capacity?.reason || 'GPU status unavailable.')
    render(status)
  } catch (error) {
    workerState.textContent = 'Unavailable'
    workerNote.textContent = error instanceof Error ? error.message : String(error)
    statusAlert.hidden = false
    statusAlert.textContent = 'GPU status could not be verified. No lifecycle action was taken.'
    lastUpdated.textContent = 'Status check failed'
  } finally {
    refreshButton.disabled = false
  }
}

refreshButton.addEventListener('click', refresh)
refresh()
pollTimer = window.setInterval(refresh, 10_000)
window.addEventListener('beforeunload', () => window.clearInterval(pollTimer))
