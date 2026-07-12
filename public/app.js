const $ = (selector) => document.querySelector(selector)

const productImages = $('#productImages')
const dropzone = $('#dropzone')
const sourceSection = $('#sourceSection')
const sourceGrid = $('#sourceGrid')
const sourceRequirement = $('#sourceRequirement')
const addPhotosButton = $('#addPhotosButton')
const generateButton = $('#generateButton')
const uploadView = $('#uploadView')
const studioView = $('#studioView')
const newStoryButton = $('#newStoryButton')
const computeBadge = $('#computeBadge')
const queuePopover = $('#queuePopover')
const queuePopoverClose = $('#queuePopoverClose')
const queueDetailsList = $('#queueDetailsList')
const queueDetailsNote = $('#queueDetailsNote')
const capacityButton = $('#capacityButton')
const capacityState = $('#capacityState')
const amdModeState = $('#amdModeState')
const amdModeInput = $('#amdModeInput')
const amdModeOption = $('#amdModeOption')
const computeNote = $('#computeNote')
const aspect = $('#aspect')
const durationSeconds = $('#durationSeconds')
const renderResolution = $('#renderResolution')
const brief = $('#brief')
const storyStyleState = $('#storyStyleState')
const activityList = $('#activityList')
const elapsedTime = $('#elapsedTime')
const jobWarning = $('#jobWarning')
const cancelJobButton = $('#cancelJobButton')
const storyFrame = $('#storyFrame')
const storyImage = $('#storyImage')
const storyCaption = $('#storyCaption')
const shotNumber = $('#shotNumber')
const framePreparing = $('#framePreparing')
const generatedVideo = $('#generatedVideo')
const storyTitle = $('#storyTitle')
const jobStatus = $('#jobStatus')
const stageKicker = $('#stageKicker')
const playButton = $('#playButton')
const playbackProgress = $('#playbackProgress')
const playbackTime = $('#playbackTime')
const fullscreenButton = $('#fullscreenButton')
const timeline = $('#timeline')
const jobId = $('#jobId')
const jobMode = $('#jobMode')
const queueState = $('#queueState')
const workerState = $('#workerState')
const gpuState = $('#gpuState')
const gpuLoadState = $('#gpuLoadState')
const billingState = $('#billingState')
const releasePolicyState = $('#releasePolicyState')
const outputState = $('#outputState')
const exportVideoButton = $('#exportVideoButton')
const exportStoryboardButton = $('#exportStoryboardButton')
const releaseGpuButton = $('#releaseGpuButton')
const exportStatus = $('#exportStatus')
const toast = $('#toast')

const fallbackStoryLimits = Object.freeze({ minImages: 1, maxImages: 8 })
let storyLimits = { ...fallbackStoryLimits }
const maxImageBytes = 4_000_000
const labels = ['Front', 'Angle', 'Side', 'Back', 'Detail', 'Texture', 'Scale', 'Hero']
const terminalStates = new Set(['ready', 'failed', 'cancelled'])
const supportedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'])
const renderResolutionOptions = {
  fast: { label: 'Fast', dimensions: { '9:16': [384, 672], '1:1': [384, 384], '16:9': [672, 384] } },
  standard: { label: 'Standard', dimensions: { '9:16': [544, 960], '1:1': [544, 544], '16:9': [960, 544] } },
  detail: { label: 'Detail', dimensions: { '9:16': [640, 1120], '1:1': [640, 640], '16:9': [1120, 640] } },
}

let config = {}
let sources = []
let currentJob = null
let pollTimer = null
let elapsedTimer = null
let playbackFrame = 0
let playbackStartedAt = 0
let playbackOffset = 0
let toastTimer = null
let activeShotIndex = 0
let queueSnapshot = null
const expandedActivitySteps = new Set()

function showToast(message, duration = 4200) {
  clearTimeout(toastTimer)
  toast.textContent = message
  toast.hidden = false
  toastTimer = setTimeout(() => { toast.hidden = true }, duration)
}

function formatTime(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0))
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`
}

function formatPrecisePercent(value) {
  const safe = Math.max(0, Math.min(100, Number(value) || 0))
  return `${safe.toFixed(1)}%`
}

function formatClock(value = Date.now()) {
  const date = value ? new Date(value) : new Date()
  if (Number.isNaN(date.getTime())) return '--:--:--'
  return date.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatElapsedSince(value) {
  const started = value ? new Date(value).getTime() : 0
  if (!started || Number.isNaN(started)) return '0s'
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

function formatDurationMs(value) {
  const seconds = Math.max(0, Math.floor((Number(value) || 0) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m`
}

function formatJobCount(count) {
  const safe = Math.max(0, Number(count) || 0)
  return `${safe} job${safe === 1 ? '' : 's'}`
}

function formatBytes(bytes) {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`
}

function formatPhotoCount(count) {
  return `${count} photo${count === 1 ? '' : 's'}`
}

function formatMissingPhotos(count) {
  return `Add ${count} more photo${count === 1 ? '' : 's'}.`
}

function setStoryLimits(value) {
  storyLimits = {
    minImages: Math.max(1, Math.min(8, Number(value?.minImages) || fallbackStoryLimits.minImages)),
    maxImages: Math.max(1, Math.min(8, Number(value?.maxImages) || fallbackStoryLimits.maxImages)),
  }
  if (storyLimits.minImages > storyLimits.maxImages) storyLimits.minImages = storyLimits.maxImages
}

function selectedMode() {
  return document.querySelector('input[name="storyMode"]:checked')?.value || 'fast_story'
}

function selectedStyle() {
  return document.querySelector('input[name="storyStyle"]:checked')?.value || 'cinematic_film'
}

function updateRenderResolutionLabels() {
  for (const option of renderResolution.options) {
    const preset = renderResolutionOptions[option.value]
    if (!preset) continue
    const [width, height] = preset.dimensions[aspect.value] || preset.dimensions['9:16']
    option.textContent = `${preset.label} · ${width} × ${height}`
  }
}

function updateGenerateAvailability() {
  const cinematicUnavailable = selectedMode() === 'amd_cinematic'
    && !config.amdGpuPublicEnabled
  generateButton.disabled = sources.length < storyLimits.minImages || cinematicUnavailable
  generateButton.querySelector('span').textContent = cinematicUnavailable
    ? 'AMD Cinematic is offline'
    : selectedMode() === 'amd_cinematic'
      ? ['available', 'requestable'].includes(config.amdGpuCapacityState)
        ? 'Queue AMD Cinematic Story'
        : 'Join AMD Render Queue'
      : 'Direct Product Story'
}

function renderCapacity(capacity = config) {
  const state = capacity.state || capacity.amdGpuCapacityState || 'unavailable'
  const available = state === 'available' && (capacity.available ?? true)
  const requestable = state === 'requestable' || capacity.requestable === true
  const publicEnabled = capacity.publicEnabled ?? capacity.amdGpuPublicEnabled ?? false
  const persistent = capacity.persistentLease === true
    || capacity.lifecycle === 'persistent'
    || capacity.amdGpuPersistent === true
  const canStart = (available || requestable) && publicEnabled
  const canQueue = publicEnabled
  const reason = capacity.reason || capacity.amdGpuAvailabilityReason || ''
  config.amdGpuCapacityState = state
  config.amdGpuAvailabilityReason = reason
  config.amdGpuPublicEnabled = publicEnabled
  config.amdGpuPersistent = persistent
  amdModeState.textContent = persistent ? 'Persistent' : canStart ? requestable ? 'On demand' : 'Available' : canQueue ? 'Queue' : available || requestable ? 'Owner locked' : 'Offline'
  amdModeInput.disabled = !canQueue
  amdModeOption.classList.toggle('is-disabled', !canQueue)
  amdModeState.title = canStart
    ? persistent
      ? 'The persistent AMD GPU remains online after each Product Story job.'
      : 'AMD GPU starts on demand and is destroyed after the job.'
    : canQueue
      ? 'The FIFO queue accepts the job and waits without GPU billing until capacity returns.'
      : reason || 'AMD Cinematic is unavailable.'
  capacityState.textContent = persistent ? 'Online' : canStart ? requestable ? 'On demand' : 'Ready' : canQueue ? 'Queue ready' : available || requestable ? 'Locked' : 'Unavailable'
  capacityButton.classList.toggle('is-ready', canStart || canQueue)
  computeBadge.classList.toggle('is-safe', canStart || canQueue)
  computeBadge.querySelector('span').textContent = canStart
    ? persistent ? 'AMD GPU persistent' : requestable ? 'AMD GPU on demand' : 'AMD GPU ready on demand'
    : canQueue
      ? 'AMD FIFO queue ready'
    : available
      ? 'AMD GPU owner locked'
      : requestable
        ? 'AMD capacity unconfirmed'
        : 'AMD capacity unavailable'
  computeNote.textContent = canStart
    ? persistent
      ? 'The persistent MI300X is already online and remains running between jobs. AMD credits continue while the Droplet is active.'
      : requestable
      ? 'AMD Cinematic jobs enter one FIFO queue. Billing starts only when this job provisions the MI300X and stops when the Droplet is destroyed.'
      : 'AMD Cinematic jobs render one at a time. Waiting jobs do not start GPU billing.'
    : canQueue
      ? `${reason || 'AMD capacity is temporarily unavailable.'} The job can wait in FIFO order with no GPU billing.`
    : requestable
      ? `${reason} The owner safety switch is off.`
      : reason || 'AMD Cinematic is unavailable. Checking capacity never starts GPU billing.'
  if (!canQueue && selectedMode() === 'amd_cinematic') document.querySelector('input[value="fast_story"]').checked = true
  updateGenerateAvailability()
}

async function checkGpuCapacity() {
  capacityButton.disabled = true
  capacityButton.classList.add('is-checking')
  capacityState.textContent = 'Checking'
  computeBadge.querySelector('span').textContent = 'Checking AMD capacity'
  try {
    const response = await fetch('/api/gpu-capacity?refresh=1', { cache: 'no-store' })
    const capacity = await response.json()
    renderCapacity(capacity)
    if (!response.ok) throw new Error(capacity.reason || 'AMD capacity check failed.')
    if ((capacity.available || capacity.requestable) && capacity.publicEnabled) {
      amdModeInput.checked = true
      updateGenerateAvailability()
      showToast(capacity.persistentLease
        ? 'Persistent AMD MI300X is online and will remain running after each job.'
        : capacity.requestable
          ? 'AMD on-demand provisioning is ready. Starting the story will request one MI300X.'
          : 'AMD capacity is ready. Start the story to create the GPU Droplet.', 5600)
    } else if (capacity.state === 'available' && capacity.available) {
      showToast('AMD capacity exists, but the owner safety switch is off.', 5600)
    } else if (capacity.state === 'requestable' || capacity.requestable) {
      showToast('AMD on-demand access exists, but the owner safety switch is off. No GPU billing has started.', 5600)
    } else {
      showToast(capacity.reason || 'No AMD MI300X capacity is available right now.', 5600)
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 5600)
  } finally {
    capacityButton.disabled = false
    capacityButton.classList.remove('is-checking')
  }
}

function setView(view) {
  uploadView.hidden = view !== 'upload'
  studioView.hidden = view !== 'studio'
  newStoryButton.hidden = view !== 'studio'
  document.body.dataset.view = view
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('Could not read the image.'))
    reader.readAsDataURL(file)
  })
}

async function normalizeImage(file) {
  if (!supportedTypes.has(file.type)) throw new Error(`${file.name}: choose a JPG, PNG, WebP, AVIF, or GIF image.`)
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const context = canvas.getContext('2d')
  if (!context) {
    bitmap.close()
    throw new Error('This browser could not prepare the product image.')
  }
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Could not prepare the image.')), 'image/jpeg', .88)
  })
  if (blob.size > maxImageBytes) throw new Error(`${file.name}: the prepared image is over 4 MB.`)
  return new File([blob], `${file.name.replace(/\.[^.]+$/, '') || 'product'}.jpg`, {
    type: 'image/jpeg',
    lastModified: file.lastModified,
  })
}

async function addFiles(fileList) {
  const remaining = storyLimits.maxImages - sources.length
  const selected = [...fileList].slice(0, remaining)
  if (!selected.length) {
    showToast(`A Product Story accepts up to ${formatPhotoCount(storyLimits.maxImages)}.`)
    return
  }
  addPhotosButton.disabled = true
  try {
    for (const original of selected) {
      const file = await normalizeImage(original)
      const dataUrl = await readFileAsDataUrl(file)
      sources.push({
        id: crypto.randomUUID(),
        file,
        dataUrl,
        previewUrl: URL.createObjectURL(file),
        label: labels[sources.length],
      })
      renderSources()
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error))
  } finally {
    productImages.value = ''
    addPhotosButton.disabled = false
  }
}

function removeSource(id) {
  const source = sources.find((item) => item.id === id)
  if (source) URL.revokeObjectURL(source.previewUrl)
  sources = sources.filter((item) => item.id !== id)
  sources.forEach((item, index) => { item.label = labels[index] })
  renderSources()
}

function renderSources() {
  sourceSection.hidden = sources.length === 0
  dropzone.hidden = sources.length > 0
  sourceGrid.replaceChildren(...sources.map((source, index) => {
    const tile = document.createElement('figure')
    tile.className = 'source-tile'
    const image = document.createElement('img')
    image.src = source.previewUrl
    image.alt = `${source.label} product view`
    const label = document.createElement('span')
    label.textContent = `${String(index + 1).padStart(2, '0')} ${source.label}`
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.ariaLabel = `Remove ${source.label} photo`
    remove.title = 'Remove photo'
    remove.textContent = '×'
    remove.addEventListener('click', () => removeSource(source.id))
    tile.append(image, label, remove)
    return tile
  }))
  const ready = sources.length >= storyLimits.minImages
  sourceRequirement.textContent = ready
    ? `${sources.length} source photo${sources.length === 1 ? '' : 's'} ready${sources.length === storyLimits.maxImages ? ' · maximum reached' : ''}.`
    : formatMissingPhotos(storyLimits.minImages - sources.length)
  sourceRequirement.classList.toggle('is-ready', ready)
  updateGenerateAvailability()
  addPhotosButton.hidden = sources.length >= storyLimits.maxImages
}

async function uploadSource(source) {
  const response = await fetch('/api/product-image', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: source.file.name, type: source.file.type, dataUrl: source.dataUrl }),
    signal: AbortSignal.timeout(15_000),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload?.url) throw new Error(payload?.error || `${source.file.name} could not be uploaded.`)
  return { ...payload, id: source.id, label: source.label, name: source.file.name, type: source.file.type, size: source.file.size }
}

function initialActivity() {
  return [
    ['source_upload', 'Source upload'],
    ['vision_analysis', 'Fireworks vision brief'],
    ['storyboard', 'Video prompt direction'],
    ['gpu_queue', 'AMD render queue'],
    ['gpu_provision', 'AMD GPU provision'],
    ['motion_shots', 'Text-guided video generation'],
    ['identity_check', 'Product identity check'],
    ['video_composition', 'Video composition'],
    ['release_gpu', 'Release GPU'],
  ].map(([id, label]) => ({ id, label, status: 'pending', detail: 'Waiting', progress: 0 }))
}

function statusMarker(step, index) {
  if (step.status === 'completed') return '✓'
  if (step.status === 'skipped') return '–'
  if (step.status === 'failed' || step.status === 'cancelled') return '!'
  return String(index + 1)
}

function appendTraceFact(list, label, value) {
  const term = document.createElement('dt')
  term.textContent = label
  const detail = document.createElement('dd')
  detail.textContent = value
  list.append(term, detail)
}

function appendTraceList(container, label, items) {
  if (!items?.length) return
  const heading = document.createElement('b')
  heading.textContent = label
  const list = document.createElement('ul')
  for (const value of items) {
    const item = document.createElement('li')
    item.textContent = value
    list.append(item)
  }
  container.append(heading, list)
}

function activityTrace(step, job) {
  const ai = job?.aiDirection
  const prompts = ai?.prompts || []
  if (!ai || !['vision_analysis', 'storyboard', 'motion_shots'].includes(step.id)) return null

  const details = document.createElement('details')
  details.className = 'activity-trace'
  details.open = expandedActivitySteps.has(step.id)
  const summary = document.createElement('summary')
  summary.textContent = step.id === 'vision_analysis'
    ? 'Model evidence'
    : step.id === 'storyboard'
      ? `${prompts.length} directed prompts`
      : 'Generation runtime'
  details.append(summary)

  const body = document.createElement('div')
  body.className = 'activity-trace-body'
  const facts = document.createElement('dl')
  if (step.id === 'vision_analysis') {
    appendTraceFact(facts, 'Provider', ai.provider)
    appendTraceFact(facts, 'Active model', ai.modelId.replace('accounts/fireworks/models/', ''))
    appendTraceFact(facts, 'Input', `${ai.sourceCount} product view${ai.sourceCount === 1 ? '' : 's'}`)
    if (ai.inferenceDurationMs) appendTraceFact(facts, 'Inference', `${(ai.inferenceDurationMs / 1000).toFixed(1)}s · ${ai.inferenceAttempts || 1} attempt${ai.inferenceAttempts === 1 ? '' : 's'}`)
    appendTraceFact(facts, 'Role', ai.role)
    body.append(facts)
    const summaryText = document.createElement('p')
    summaryText.className = 'trace-summary'
    summaryText.textContent = ai.summary
    body.append(summaryText)
    appendTraceList(body, 'What the model sees', ai.observations)
    appendTraceList(body, 'Seller verification needed', ai.needsReview)
    if (ai.confidence) appendTraceList(body, 'Confidence', [ai.confidence])
  } else if (step.id === 'storyboard') {
    const isGeneratedVideo = ai.generation?.task === 'text_guided_image_to_video'
    appendTraceFact(facts, 'Prompt source', `${ai.provider} product evidence`)
    appendTraceFact(facts, isGeneratedVideo ? 'Video model' : 'Preview engine', ai.generation?.model || 'Source Motion Preview')
    appendTraceFact(facts, 'Task', isGeneratedVideo ? 'Text + source image to video' : 'Source-photo motion direction')
    body.append(facts)
    for (const prompt of prompts) {
      const promptBlock = document.createElement('div')
      promptBlock.className = 'trace-prompt'
      const label = document.createElement('b')
      label.textContent = `Shot ${prompt.shot} · ${prompt.sourceLabel}`
      const text = document.createElement('p')
      text.textContent = prompt.prompt
      promptBlock.append(label, text)
      body.append(promptBlock)
    }
  } else {
    const isGeneratedVideo = ai.generation?.task === 'text_guided_image_to_video'
    appendTraceFact(facts, isGeneratedVideo ? 'Model' : 'Engine', ai.generation?.model || 'Source Motion Preview')
    appendTraceFact(facts, 'Task', isGeneratedVideo ? 'Text-guided image-to-video' : 'Source-photo animation')
    appendTraceFact(facts, 'Compute', ai.generation?.runtime || 'Browser')
    appendTraceFact(facts, 'Backend', ai.generation?.backend || 'Canvas')
    body.append(facts)
    const note = document.createElement('p')
    note.className = 'trace-summary'
    note.textContent = isGeneratedVideo
      ? 'Each prompt conditions a real product view. Generated frames are accepted only after product identity checks.'
      : 'The browser animates source pixels only. No generative video model or AMD GPU is used in Motion Preview.'
    body.append(note)
  }
  details.append(body)
  details.addEventListener('toggle', () => {
    if (details.open) expandedActivitySteps.add(step.id)
    else expandedActivitySteps.delete(step.id)
  })
  return details
}

function activeRuntimeLog(step, job, progressValue) {
  const lines = []
  const currentShot = Math.max(0, Number(job?.currentShot) || 0)
  const totalShots = Math.max(0, Number(job?.totalShots) || 0)
  lines.push(`[${formatClock()}] client poll OK - refreshing every 650ms`)
  lines.push(`progress=${formatPrecisePercent(progressValue)} status=${job?.status || step.status || 'active'}`)
  lines.push(`stage=${step.id} active_for=${formatElapsedSince(step.startedAt || job?.updatedAt)}`)
  if (currentShot && totalShots) lines.push(`shot=${currentShot}/${totalShots}`)
  if (job?.gpu?.status) lines.push(`gpu=${job.gpu.status} billing=${job.gpu.billing || 'unknown'}`)
  if (job?.queue?.state && job.queue.state !== 'not_required') {
    lines.push(`queue=${job.queue.state} ahead=${Number(job.queue.jobsAhead) || 0}`)
  }
  if (job?.updatedAt) lines.push(`server_updated=${formatClock(job.updatedAt)}`)
  if (step.detail) lines.push(`detail=${step.detail}`)

  const log = document.createElement('div')
  log.className = 'step-runtime-log'
  const label = document.createElement('span')
  label.textContent = 'Live console'
  const code = document.createElement('code')
  code.textContent = lines.join('\n')
  log.append(label, code)
  return log
}

function renderActivity(activity = initialActivity(), job = null) {
  activityList.replaceChildren(...activity.map((step, index) => {
    const isActive = step.status === 'active'
    const progressValue = isActive ? Math.max(0, Math.min(100, Number(step.progress) || 0)) : null
    const progressText = isActive ? formatPrecisePercent(progressValue) : ''
    const item = document.createElement('li')
    item.className = `activity-step is-${step.status || 'pending'}`
    if (isActive) item.setAttribute('aria-current', 'step')
    const marker = document.createElement('span')
    marker.className = 'step-marker'
    marker.textContent = statusMarker(step, index)
    const head = document.createElement('div')
    head.className = 'activity-step-head'
    const title = document.createElement('strong')
    title.textContent = step.label
    head.append(title)
    if (isActive) {
      const status = document.createElement('span')
      status.className = 'activity-status'
      status.textContent = `In progress ${progressText}`
      head.append(status)
    }
    const detail = document.createElement('p')
    detail.className = 'step-detail'
    detail.textContent = isActive
      ? `${step.detail} · ${progressText}`
      : step.detail
    const copy = document.createElement('div')
    copy.className = 'activity-step-copy'
    copy.append(head, detail)
    if (isActive) {
      const progress = document.createElement('div')
      progress.className = 'step-progress'
      progress.setAttribute('aria-label', `Current step progress ${progressText}`)
      const progressFill = document.createElement('span')
      progressFill.style.width = `${progressValue}%`
      progress.append(progressFill)
      copy.append(progress)
      copy.append(activeRuntimeLog(step, job, progressValue))
    }
    const trace = activityTrace(step, job)
    if (trace) copy.append(trace)
    item.append(marker, copy)
    return item
  }))
}

function renderTimeline(plan) {
  timeline.replaceChildren(...(plan?.shots || []).map((shot, index) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `timeline-shot${index === activeShotIndex ? ' is-active' : ''}`
    button.ariaLabel = `Preview shot ${index + 1}`
    const image = document.createElement('img')
    image.src = shot.sourceUrl
    image.alt = ''
    const label = document.createElement('span')
    label.textContent = String(index + 1).padStart(2, '0')
    button.append(image, label)
    button.addEventListener('click', () => {
      pauseStory()
      playbackOffset = shot.startSeconds
      showShot(index, false)
      updatePlayback(playbackOffset)
    })
    return button
  }))
}

function showShot(index, animate = true) {
  const shots = currentJob?.plan?.shots || []
  if (!shots.length) return
  activeShotIndex = Math.max(0, Math.min(shots.length - 1, index))
  const shot = shots[activeShotIndex]
  storyImage.src = shot.sourceUrl
  storyCaption.textContent = shot.caption
  shotNumber.textContent = `${String(activeShotIndex + 1).padStart(2, '0')} / ${String(shots.length).padStart(2, '0')}`
  storyFrame.style.setProperty('--shot-duration', `${shot.durationSeconds}s`)
  for (const className of [...storyFrame.classList]) {
    if (className.startsWith('motion-')) storyFrame.classList.remove(className)
  }
  storyFrame.classList.add('is-ready')
  if (animate) {
    void storyFrame.offsetWidth
    storyFrame.classList.add(`motion-${shot.motion}`)
  }
  timeline.querySelectorAll('.timeline-shot').forEach((button, buttonIndex) => button.classList.toggle('is-active', buttonIndex === activeShotIndex))
}

function firstStoryPoster(job = currentJob) {
  return job?.plan?.shots?.[0]?.sourceUrl || job?.request?.sourceImages?.[0]?.url || ''
}

function setGeneratedVideo(job) {
  const videoUrl = job?.output?.videoUrl || ''
  if (!videoUrl) {
    if (generatedVideo.getAttribute('src')) {
      generatedVideo.removeAttribute('src')
      generatedVideo.load()
    }
    generatedVideo.removeAttribute('poster')
    generatedVideo.hidden = true
    return
  }
  const poster = firstStoryPoster(job)
  if (poster) generatedVideo.poster = poster
  else generatedVideo.removeAttribute('poster')
  if (generatedVideo.getAttribute('src') !== videoUrl) {
    generatedVideo.src = videoUrl
    generatedVideo.load()
  }
  generatedVideo.hidden = false
}

function friendlyStatus(status) {
  return ({
    queued: 'Queued',
    analyzing: 'Understanding product',
    waiting_for_gpu: 'Waiting in AMD queue',
    gpu_starting: 'Starting AMD GPU',
    generating: 'Directing story',
    cancelling: 'Releasing AMD GPU',
    ready: 'Story ready',
    failed: 'Job failed',
    cancelled: 'Cancelled',
  })[status] || status
}

function friendlyQueue(queue) {
  if (!queue || queue.state === 'not_required') return 'Not required'
  if (queue.state === 'complete') return 'Complete'
  if (queue.state === 'cancelled') return 'Cancelled'
  if (queue.state === 'failed') return 'Ended'
  if (queue.state === 'active') return 'Rendering now'
  if (queue.state === 'checking_capacity' || queue.state === 'capacity_wait') return 'Next · waiting for capacity'
  if (queue.position) return `#${queue.position} · ${queue.jobsAhead} ahead`
  return 'Preparing'
}

function friendlyGpuLoad(telemetry) {
  if (!telemetry?.available) return 'No sample'
  const values = []
  if (Number.isFinite(telemetry.utilizationPct)) values.push(`${Math.round(telemetry.utilizationPct)}% compute`)
  if (Number.isFinite(telemetry.vramPct)) values.push(`${Math.round(telemetry.vramPct)}% VRAM`)
  if (Number.isFinite(telemetry.powerWatts)) values.push(`${Math.round(telemetry.powerWatts)} W`)
  return values.join(' · ') || 'Sampled'
}

function queueStateDetail(value) {
  return ({
    preparing: 'Reserved while story prompts are prepared',
    waiting: 'Waiting for the single AMD render slot',
    checking_capacity: 'First in queue, checking AMD capacity',
    capacity_wait: 'First in queue, waiting for AMD capacity',
    active: 'This job owns the AMD render slot',
    complete: 'Queue finished',
    cancelled: 'Removed from queue',
    failed: 'Queue ended after failure',
    not_required: 'No AMD queue required',
  })[value] || value || 'Unknown'
}

function billingDetail(job = currentJob) {
  const billing = job?.gpu?.billing || 'inactive'
  if (billing === 'persistent_active' || job?.gpu?.releasePolicy === 'retain_after_job') return 'Persistent GPU online'
  if (billing === 'active_for_job') return 'Active for this job'
  if (billing === 'possibly_active') return 'Release required'
  return 'Inactive'
}

function activeSlotDetail(job = currentJob, snapshot = queueSnapshot) {
  const queue = job?.queue || {}
  if (snapshot?.activeSlot === 'this_job' || queue.state === 'active') return 'This job'
  if (snapshot?.activeSlot === 'other_job' || Number(queue.jobsAhead) > 0) return 'Another anonymous job'
  if (snapshot?.activeSlot === 'idle') return 'Idle'
  if (snapshot?.activeJobPresent) return 'Occupied'
  if (queue.state === 'checking_capacity' || queue.state === 'capacity_wait') return 'This job is first'
  return 'No active AMD job'
}

function queueOverviewDetail(snapshot = queueSnapshot) {
  if (!snapshot) return 'Checking'
  return `${formatJobCount(snapshot.queuedJobs)} waiting · ${formatJobCount(snapshot.readyJobs)} ready · ${formatJobCount(snapshot.preparingJobs)} preparing`
}

function queueDetailRows(job = currentJob, snapshot = queueSnapshot) {
  const queue = job?.queue || {}
  const focus = snapshot?.focus || null
  const policy = (snapshot?.policy || queue.policy || 'fifo').toUpperCase()
  const concurrency = snapshot?.concurrency || queue.concurrency || 1
  const rows = [
    ['Policy', `${policy} · ${concurrency} active slot`],
    ['Active slot', activeSlotDetail(job, snapshot)],
    ['Queue total', queueOverviewDetail(snapshot)],
  ]

  if (!job) {
    rows.push(['This job', 'No Product Story selected'])
    rows.push(['Capacity', config.amdGpuPublicEnabled ? 'AMD Cinematic enabled' : 'AMD Cinematic offline'])
    return rows
  }

  rows.push(['This job', queueStateDetail(queue.state || focus?.state)])
  if (job.effectiveMode === 'amd_cinematic') {
    const position = Number(queue.position || focus?.position) || 0
    const jobsAhead = Number(queue.jobsAhead || focus?.jobsAhead) || 0
    rows.push(['Position', position > 0 ? `#${position}` : queue.state === 'active' ? 'Active' : 'Complete'])
    rows.push(['Jobs ahead', formatJobCount(jobsAhead)])
  } else {
    rows.push(['Position', 'Not in AMD queue'])
    rows.push(['Jobs ahead', formatJobCount(0)])
  }
  rows.push(['GPU billing', billingDetail(job)])
  rows.push(['AMD GPU', job.effectiveMode === 'amd_cinematic' ? (job.gpu?.device || job.gpu?.status || 'Not started') : 'Not used'])
  if (job.gpu?.telemetry?.available) rows.push(['GPU load', friendlyGpuLoad(job.gpu.telemetry)])
  if (Number(queue.waitMs) > 0) rows.push(['Wait time', formatDurationMs(queue.waitMs)])
  if (queue.enqueuedAt) rows.push(['Enqueued', formatClock(queue.enqueuedAt)])
  if (queue.startedAt) rows.push(['Slot started', formatClock(queue.startedAt)])
  if (snapshot?.checkedAt) rows.push(['Updated', formatClock(snapshot.checkedAt)])
  return rows
}

function queueDetailNote(job = currentJob, snapshot = queueSnapshot) {
  if (snapshot?.error) return snapshot.error
  const privacy = snapshot?.privacy || 'Queue details show anonymous job counts only.'
  if (job?.queue?.note) return `${job.queue.note} ${privacy}`
  if (snapshot?.activeSlot === 'other_job') return `Another Product Story job is using the single AMD render slot. ${privacy}`
  if (snapshot?.queuedJobs > 0) return `There are queued Product Story jobs waiting for the AMD render slot. ${privacy}`
  if (!config.amdGpuPublicEnabled) return `AMD Cinematic is offline for public jobs. ${privacy}`
  return `No other AMD Product Story job is waiting in this queue snapshot. ${privacy}`
}

function renderQueueDetails() {
  queueDetailsList.replaceChildren(...queueDetailRows().map(([label, value]) => {
    const row = document.createElement('div')
    const term = document.createElement('dt')
    const detail = document.createElement('dd')
    term.textContent = label
    detail.textContent = value
    row.append(term, detail)
    return row
  }))
  queueDetailsNote.textContent = queueDetailNote()
}

async function refreshQueueDetails() {
  const query = currentJob?.id ? `?jobId=${encodeURIComponent(currentJob.id)}` : ''
  try {
    const response = await fetch(`/api/story-queue${query}`, { cache: 'no-store', signal: AbortSignal.timeout(5_000) })
    const snapshot = await response.json()
    if (!response.ok) throw new Error(snapshot.error || 'Could not read AMD queue.')
    queueSnapshot = snapshot
  } catch (error) {
    queueSnapshot = { error: error instanceof Error ? error.message : String(error) }
  }
  if (!queuePopover.hidden) renderQueueDetails()
}

function setQueuePopoverOpen(open) {
  queuePopover.hidden = !open
  computeBadge.setAttribute('aria-expanded', String(open))
  queueState.setAttribute('aria-expanded', String(open))
  if (open) {
    renderQueueDetails()
    void refreshQueueDetails()
  }
}

function toggleQueuePopover(event) {
  event?.preventDefault()
  event?.stopPropagation()
  setQueuePopoverOpen(queuePopover.hidden)
}

function renderJobNotice(job) {
  jobWarning.replaceChildren()
  jobWarning.classList.toggle('is-error', Boolean(job.error))
  if (job.error) {
    const title = document.createElement('strong')
    title.textContent = 'Job stopped'
    const message = document.createElement('p')
    message.textContent = job.error
    jobWarning.append(title, message)
    jobWarning.hidden = false
    return
  }
  if (!job.warning) {
    jobWarning.hidden = true
    return
  }

  const title = document.createElement('strong')
  const message = document.createElement('p')
  if (job.warning.startsWith('Vision provider fallback:')) {
    title.textContent = 'Vision fallback used'
    message.textContent = 'The video is still running. Product analysis used local evidence because the remote vision model timed out.'
    const details = document.createElement('details')
    const summary = document.createElement('summary')
    summary.textContent = 'Technical detail'
    const code = document.createElement('code')
    code.textContent = job.warning.replace(/^Vision provider fallback:\s*/, '')
    details.append(summary, code)
    jobWarning.append(title, message, details)
  } else {
    title.textContent = 'Notice'
    message.textContent = job.warning
    jobWarning.append(title, message)
  }
  jobWarning.hidden = false
}

function renderJob(job) {
  currentJob = job
  renderActivity(job.activity, job)
  jobId.textContent = job.id.replace('story_', '').slice(0, 10)
  jobId.title = job.id
  jobStatus.textContent = friendlyStatus(job.status)
  storyTitle.textContent = job.plan?.title || 'Directing your product'
  stageKicker.textContent = job.effectiveMode === 'amd_cinematic' ? 'AMD Cinematic' : 'Motion Preview'
  jobMode.textContent = job.effectiveMode === 'amd_cinematic' ? 'AMD Cinematic' : 'Motion Preview'
  storyStyleState.textContent = job.plan?.styleLabel || 'Cinematic Product Film'
  queueState.textContent = friendlyQueue(job.queue)
  queueState.title = job.queue?.note || 'Show AMD queue details'
  const waitingForGpu = ['preparing', 'waiting', 'checking_capacity', 'capacity_wait'].includes(job.queue?.state)
  workerState.textContent = job.effectiveMode === 'amd_cinematic'
    ? waitingForGpu ? 'AMD FIFO queue' : (job.gpu?.device || 'AMD worker')
    : 'Browser compositor'
  gpuState.textContent = waitingForGpu ? 'Not started' : job.gpu?.status ? job.gpu.status.replaceAll('_', ' ') : 'Offline'
  gpuLoadState.textContent = waitingForGpu || job.effectiveMode !== 'amd_cinematic'
    ? 'No sample'
    : friendlyGpuLoad(job.gpu?.telemetry)
  const gpuBillingActive = job.gpu?.billing === 'active_for_job'
  const gpuBillingPersistent = job.gpu?.billing === 'persistent_active' || job.gpu?.releasePolicy === 'retain_after_job'
  const gpuBillingUncertain = job.gpu?.billing === 'possibly_active'
  billingState.textContent = gpuBillingPersistent ? 'Persistent' : gpuBillingActive ? 'Active for job' : gpuBillingUncertain ? 'Release required' : 'Inactive'
  billingState.classList.toggle('active', gpuBillingActive || gpuBillingPersistent || gpuBillingUncertain)
  billingState.classList.toggle('safe', !gpuBillingActive && !gpuBillingPersistent && !gpuBillingUncertain)
  releasePolicyState.textContent = gpuBillingPersistent ? 'Keep online' : 'Destroy after job'
  outputState.textContent = job.output?.status === 'ready' ? `${job.output.width} × ${job.output.height}` : 'Waiting'
  computeBadge.classList.toggle('is-active', gpuBillingActive || gpuBillingPersistent || gpuBillingUncertain)
  computeBadge.classList.toggle('is-safe', waitingForGpu || gpuBillingPersistent || job.gpu?.status === 'released')
  computeBadge.querySelector('span').textContent = gpuBillingActive || gpuBillingPersistent || gpuBillingUncertain
    ? gpuBillingUncertain ? 'Release GPU' : gpuBillingPersistent ? 'AMD GPU persistent' : 'AMD GPU active'
    : waitingForGpu
      ? job.queue?.position ? `AMD queue #${job.queue.position}` : 'AMD queue next'
    : job.gpu?.status === 'released' ? 'AMD GPU released' : 'AMD GPU offline'
  if (!queuePopover.hidden) renderQueueDetails()
  renderJobNotice(job)
  releaseGpuButton.disabled = gpuBillingPersistent || (!gpuBillingActive && !gpuBillingUncertain && !['ready', 'releasing'].includes(job.gpu?.status))
  releaseGpuButton.textContent = gpuBillingPersistent ? 'Persistent GPU stays online' : 'Release GPU now'
  cancelJobButton.disabled = terminalStates.has(job.status)
  const ready = job.status === 'ready' && Boolean(job.plan)
  exportVideoButton.disabled = !ready
  exportStoryboardButton.disabled = !ready

  if (job.plan) {
    storyFrame.dataset.aspect = job.plan.aspect
    framePreparing.hidden = true
    playbackOffset = Math.min(playbackOffset, job.plan.durationSeconds || playbackOffset)
    updatePlayback(playbackOffset)
    if (!timeline.children.length) renderTimeline(job.plan)
    if (!storyImage.src) showShot(0, false)
    if (job.output?.videoUrl) {
      setGeneratedVideo(job)
      storyImage.hidden = true
    } else {
      setGeneratedVideo(null)
      storyImage.hidden = false
    }
  }
  if (gpuBillingPersistent && !ready) {
    exportStatus.textContent = waitingForGpu
      ? 'The persistent MI300X remains online while this job waits. AMD credits continue.'
      : terminalStates.has(job.status)
        ? 'This job ended. The persistent MI300X remains online for testing; AMD credits continue.'
        : 'The persistent MI300X is rendering this job and will remain online afterward. AMD credits continue.'
  } else if (waitingForGpu) {
    exportStatus.textContent = job.queue?.note || 'Waiting in FIFO order. GPU billing has not started.'
  } else if (gpuBillingActive && !ready) {
    exportStatus.textContent = 'The AMD GPU is rendering this job. Per-job billing is active until the lease is released.'
  }
  if (ready) exportStatus.textContent = job.output?.videoUrl
    ? gpuBillingPersistent
      ? 'AMD video output is ready. The persistent MI300X remains online for the next job.'
      : 'AMD video output is ready. The GPU lease has been released.'
    : 'Interactive preview is ready. Export renders the exact source photos in your browser.'
}

async function pollJob(id) {
  clearTimeout(pollTimer)
  try {
    const response = await fetch(`/api/story-jobs/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10_000) })
    const job = await response.json()
    if (!response.ok) throw new Error(job.error || 'Could not read Product Story status.')
    renderJob(job)
    if (!terminalStates.has(job.status)) pollTimer = setTimeout(() => pollJob(id), 650)
    else if (job.status === 'ready') showToast('Product Story ready')
    else if (job.status === 'failed') showToast(job.error || 'Product Story failed.')
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error))
    pollTimer = setTimeout(() => pollJob(id), 1800)
  }
}

async function createStory() {
  if (sources.length < storyLimits.minImages) return
  generateButton.disabled = true
  generateButton.querySelector('span').textContent = 'Uploading source views…'
  try {
    const uploaded = []
    for (let index = 0; index < sources.length; index += 1) {
      generateButton.querySelector('span').textContent = `Uploading ${index + 1} of ${sources.length}…`
      uploaded.push(await uploadSource(sources[index]))
    }
    const payload = {
      mode: selectedMode(),
      style: selectedStyle(),
      aspect: aspect.value,
      durationSeconds: Number(durationSeconds.value) || 8,
      renderResolution: renderResolution.value,
      brief: brief.value,
      channel: 'DTC',
      productImage: { ...uploaded[0], dataUrl: sources[0].dataUrl },
      sourceImages: uploaded,
    }
    const response = await fetch('/api/story-jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    })
    const job = await response.json().catch(() => null)
    if (!response.ok || !job?.id) throw new Error(job?.error || 'Could not start Product Story.')
    currentJob = job
    history.replaceState(null, '', `${location.pathname}?job=${encodeURIComponent(job.id)}`)
    activeShotIndex = 0
    renderTimeline(null)
    framePreparing.hidden = false
    storyImage.removeAttribute('src')
    setGeneratedVideo(null)
    setView('studio')
    window.scrollTo(0, 0)
    renderJob(job)
    startElapsedTimer(job.createdAt)
    pollJob(job.id)
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 5200)
  } finally {
    updateGenerateAvailability()
  }
}

function startElapsedTimer(createdAt) {
  clearInterval(elapsedTimer)
  const started = new Date(createdAt).getTime()
  const update = () => { elapsedTime.textContent = formatTime((Date.now() - started) / 1000) }
  update()
  elapsedTimer = setInterval(update, 1000)
}

function shotForTime(seconds) {
  const shots = currentJob?.plan?.shots || []
  return Math.max(0, shots.findIndex((shot) => seconds >= shot.startSeconds && seconds < shot.endSeconds))
}

function updatePlayback(seconds) {
  const duration = currentJob?.plan?.durationSeconds || 15
  const safe = Math.max(0, Math.min(duration, seconds))
  playbackProgress.style.width = `${(safe / duration) * 100}%`
  playbackTime.textContent = `${formatTime(safe)} / ${formatTime(duration)}`
}

function playbackTick(now) {
  const duration = currentJob?.plan?.durationSeconds || 15
  const seconds = playbackOffset + (now - playbackStartedAt) / 1000
  if (seconds >= duration) {
    playbackOffset = 0
    updatePlayback(duration)
    pauseStory()
    showShot(0, false)
    return
  }
  const shotIndex = shotForTime(seconds)
  if (shotIndex !== activeShotIndex) showShot(shotIndex, true)
  updatePlayback(seconds)
  playbackFrame = requestAnimationFrame(playbackTick)
}

function playStory() {
  if (!currentJob?.plan || currentJob.output?.videoUrl) {
    if (currentJob?.output?.videoUrl) generatedVideo.play()
    return
  }
  playbackStartedAt = performance.now()
  playButton.classList.add('is-playing')
  showShot(shotForTime(playbackOffset), true)
  playbackFrame = requestAnimationFrame(playbackTick)
}

function pauseStory() {
  cancelAnimationFrame(playbackFrame)
  if (playButton.classList.contains('is-playing')) {
    playbackOffset += (performance.now() - playbackStartedAt) / 1000
    playbackOffset = Math.min(currentJob?.plan?.durationSeconds || 15, playbackOffset)
  }
  playButton.classList.remove('is-playing')
  generatedVideo.pause()
}

function resetStory() {
  clearTimeout(pollTimer)
  clearInterval(elapsedTimer)
  pauseStory()
  currentJob = null
  queueSnapshot = null
  setQueuePopoverOpen(false)
  history.replaceState(null, '', location.pathname)
  playbackOffset = 0
  activeShotIndex = 0
  timeline.replaceChildren()
  renderActivity()
  computeBadge.classList.remove('is-active')
  renderCapacity(config)
  setView('upload')
  window.scrollTo(0, 0)
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function exportStoryboard() {
  if (!currentJob?.plan) return
  const payload = {
    ...currentJob.plan,
    job: {
      id: currentJob.id,
      mode: currentJob.effectiveMode,
      gpu: { status: currentJob.gpu.status, billing: currentJob.gpu.billing, releasePolicy: currentJob.gpu.releasePolicy },
      queue: currentJob.queue,
    },
  }
  downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), 'rukter-product-story.json')
  showToast('Storyboard JSON exported')
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('A source photo could not be loaded for export.'))
    image.src = url
  })
}

function drawCover(context, image, width, height, progress, motion) {
  const baseScale = Math.max(width / image.naturalWidth, height / image.naturalHeight)
  const motionScale = motion === 'push-in' ? 1 + progress * .1 : motion === 'hero-hold' ? 1.07 - progress * .04 : 1.08
  const drawWidth = image.naturalWidth * baseScale * motionScale
  const drawHeight = image.naturalHeight * baseScale * motionScale
  let x = (width - drawWidth) / 2
  let y = (height - drawHeight) / 2
  if (motion === 'pan-left') x += width * (.035 - progress * .07)
  if (motion === 'pan-right') x += width * (-.035 + progress * .07)
  if (motion === 'parallax-rise') y += height * (.025 - progress * .05)
  context.drawImage(image, x, y, drawWidth, drawHeight)
}

function wrapCanvasText(context, text, maxWidth) {
  const words = String(text || '').split(/\s+/)
  const lines = []
  let line = ''
  for (const word of words) {
    const test = line ? `${line} ${word}` : word
    if (context.measureText(test).width > maxWidth && line) {
      lines.push(line)
      line = word
    } else line = test
  }
  if (line) lines.push(line)
  return lines.slice(0, 4)
}

async function exportBrowserVideo() {
  if (!currentJob?.plan || !window.MediaRecorder) {
    showToast('Video export is not supported in this browser.')
    return
  }
  if (currentJob.output?.videoUrl) {
    window.open(currentJob.output.videoUrl, '_blank', 'noopener')
    return
  }
  exportVideoButton.disabled = true
  exportStoryboardButton.disabled = true
  const plan = currentJob.plan
  const dimensions = [
    Number(plan.output?.width) || (plan.aspect === '9:16' ? 720 : plan.aspect === '1:1' ? 900 : 1280),
    Number(plan.output?.height) || (plan.aspect === '9:16' ? 1280 : plan.aspect === '1:1' ? 900 : 720),
  ]
  const canvas = document.createElement('canvas')
  canvas.width = dimensions[0]
  canvas.height = dimensions[1]
  const context = canvas.getContext('2d')
  const images = await Promise.all(plan.shots.map((shot) => loadImage(shot.sourceUrl)))
  const stream = canvas.captureStream(30)
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm'
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 })
  const chunks = []
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
  const completed = new Promise((resolve) => { recorder.onstop = resolve })
  recorder.start(250)
  const startedAt = performance.now()

  await new Promise((resolve) => {
    const draw = (now) => {
      const seconds = (now - startedAt) / 1000
      const shotIndex = Math.min(plan.shots.length - 1, Math.max(0, shotForPlanTime(plan, seconds)))
      const shot = plan.shots[shotIndex]
      const localProgress = Math.max(0, Math.min(1, (seconds - shot.startSeconds) / shot.durationSeconds))
      context.fillStyle = '#111111'
      context.fillRect(0, 0, canvas.width, canvas.height)
      drawCover(context, images[shotIndex], canvas.width, canvas.height, localProgress, shot.motion)
      const gradient = context.createLinearGradient(0, canvas.height * .48, 0, canvas.height)
      gradient.addColorStop(0, 'rgba(0,0,0,0)')
      gradient.addColorStop(1, 'rgba(0,0,0,.78)')
      context.fillStyle = gradient
      context.fillRect(0, canvas.height * .45, canvas.width, canvas.height * .55)
      const inset = canvas.width * .075
      context.fillStyle = '#ffffff'
      context.font = `800 ${Math.round(canvas.width * .055)}px Archivo, Arial`
      const lines = wrapCanvasText(context, shot.caption, canvas.width - inset * 2)
      const lineHeight = canvas.width * .062
      lines.forEach((line, index) => context.fillText(line, inset, canvas.height - inset - (lines.length - index - 1) * lineHeight))
      context.fillStyle = '#ef233c'
      context.fillRect(inset, canvas.height - inset - lines.length * lineHeight - 18, 42, 5)
      exportStatus.textContent = `Rendering video in your browser · ${Math.min(100, Math.round((seconds / plan.durationSeconds) * 100))}%`
      if (seconds >= plan.durationSeconds) resolve()
      else requestAnimationFrame(draw)
    }
    requestAnimationFrame(draw)
  })

  recorder.stop()
  await completed
  stream.getTracks().forEach((track) => track.stop())
  downloadBlob(new Blob(chunks, { type: 'video/webm' }), 'rukter-product-story.webm')
  exportStatus.textContent = 'Video exported. Product pixels were preserved from the source photos.'
  exportVideoButton.disabled = false
  exportStoryboardButton.disabled = false
  showToast('Product Story video exported')
}

function shotForPlanTime(plan, seconds) {
  const index = plan.shots.findIndex((shot) => seconds >= shot.startSeconds && seconds < shot.endSeconds)
  return index < 0 ? plan.shots.length - 1 : index
}

async function cancelJob() {
  if (!currentJob || terminalStates.has(currentJob.status)) return
  cancelJobButton.disabled = true
  const response = await fetch(`/api/story-jobs/${encodeURIComponent(currentJob.id)}/cancel`, { method: 'POST' })
  const job = await response.json()
  if (!response.ok) showToast(job.error || 'Could not cancel the job.')
  else renderJob(job)
}

async function releaseGpu() {
  if (!currentJob) return
  releaseGpuButton.disabled = true
  releaseGpuButton.textContent = 'Releasing…'
  try {
    const response = await fetch(`/api/story-jobs/${encodeURIComponent(currentJob.id)}/release-gpu`, { method: 'POST' })
    const job = await response.json()
    if (!response.ok) throw new Error(job.error || 'Could not release AMD GPU.')
    renderJob(job)
    showToast(job.gpu?.releasePolicy === 'retain_after_job'
      ? 'Persistent AMD GPU retained online'
      : 'AMD GPU released; billing stopped')
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error))
  } finally {
    releaseGpuButton.textContent = currentJob?.gpu?.releasePolicy === 'retain_after_job'
      ? 'Persistent GPU stays online'
      : 'Release GPU now'
  }
}

async function loadConfig() {
  try {
    const response = await fetch('/api/config')
    config = await response.json()
    setStoryLimits(config.storyLimits)
    renderSources()
    if (config.amdGpuPublicEnabled) await checkGpuCapacity()
    else renderCapacity(config)
  } catch {
    amdModeState.textContent = 'Offline'
    amdModeInput.disabled = true
    amdModeOption.classList.add('is-disabled')
    updateGenerateAvailability()
  }
}

async function resumeStoryFromUrl() {
  const id = new URLSearchParams(location.search).get('job')
  if (!id) return
  try {
    const response = await fetch(`/api/story-jobs/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10_000) })
    const job = await response.json()
    if (!response.ok) throw new Error(job.error || 'Could not resume Product Story.')
    currentJob = job
    activeShotIndex = 0
    renderTimeline(null)
    framePreparing.hidden = false
    setGeneratedVideo(null)
    setView('studio')
    renderJob(job)
    startElapsedTimer(job.createdAt)
    if (!terminalStates.has(job.status)) pollJob(job.id)
  } catch (error) {
    history.replaceState(null, '', location.pathname)
    showToast(error instanceof Error ? error.message : String(error), 5200)
  }
}

productImages.addEventListener('change', () => addFiles(productImages.files))
addPhotosButton.addEventListener('click', () => productImages.click())
dropzone.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('is-dragging') })
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-dragging'))
dropzone.addEventListener('drop', (event) => {
  event.preventDefault()
  dropzone.classList.remove('is-dragging')
  addFiles(event.dataTransfer.files)
})
generateButton.addEventListener('click', createStory)
capacityButton.addEventListener('click', checkGpuCapacity)
computeBadge.addEventListener('click', toggleQueuePopover)
queueState.addEventListener('click', toggleQueuePopover)
queuePopoverClose.addEventListener('click', (event) => {
  event.stopPropagation()
  setQueuePopoverOpen(false)
})
queuePopover.addEventListener('click', (event) => event.stopPropagation())
document.addEventListener('click', () => setQueuePopoverOpen(false))
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setQueuePopoverOpen(false)
})
document.querySelectorAll('input[name="storyMode"]').forEach((input) => input.addEventListener('change', updateGenerateAvailability))
aspect.addEventListener('change', updateRenderResolutionLabels)
newStoryButton.addEventListener('click', resetStory)
cancelJobButton.addEventListener('click', cancelJob)
releaseGpuButton.addEventListener('click', releaseGpu)
exportStoryboardButton.addEventListener('click', exportStoryboard)
exportVideoButton.addEventListener('click', () => exportBrowserVideo().catch((error) => {
  exportVideoButton.disabled = false
  exportStoryboardButton.disabled = false
  exportStatus.textContent = 'Video export stopped.'
  showToast(error instanceof Error ? error.message : String(error))
}))
playButton.addEventListener('click', () => playButton.classList.contains('is-playing') ? pauseStory() : playStory())
fullscreenButton.addEventListener('click', () => storyFrame.requestFullscreen?.())
window.addEventListener('beforeunload', () => sources.forEach((source) => URL.revokeObjectURL(source.previewUrl)))

renderActivity()
renderSources()
updateRenderResolutionLabels()
loadConfig().then(resumeStoryFromUrl)
