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
const capacityButton = $('#capacityButton')
const capacityState = $('#capacityState')
const amdModeState = $('#amdModeState')
const amdModeInput = $('#amdModeInput')
const amdModeOption = $('#amdModeOption')
const computeNote = $('#computeNote')
const aspect = $('#aspect')
const market = $('#market')
const brief = $('#brief')
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
const workerState = $('#workerState')
const gpuState = $('#gpuState')
const billingState = $('#billingState')
const outputState = $('#outputState')
const exportVideoButton = $('#exportVideoButton')
const exportStoryboardButton = $('#exportStoryboardButton')
const releaseGpuButton = $('#releaseGpuButton')
const exportStatus = $('#exportStatus')
const toast = $('#toast')

const minImages = 3
const maxImages = 8
const maxImageBytes = 4_000_000
const labels = ['Front', 'Angle', 'Side', 'Back', 'Detail', 'Texture', 'Scale', 'Hero']
const terminalStates = new Set(['ready', 'failed', 'cancelled'])
const supportedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'])

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

function formatBytes(bytes) {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`
}

function selectedMode() {
  return document.querySelector('input[name="storyMode"]:checked')?.value || 'fast_story'
}

function updateGenerateAvailability() {
  const cinematicUnavailable = selectedMode() === 'amd_cinematic' && !config.amdGpuPublicEnabled
  generateButton.disabled = sources.length < minImages || cinematicUnavailable
  generateButton.querySelector('span').textContent = cinematicUnavailable
    ? 'AMD Cinematic is offline'
    : selectedMode() === 'amd_cinematic'
      ? 'Start AMD GPU & Direct Story'
      : 'Direct Product Story'
}

function renderCapacity(capacity = config) {
  const available = capacity.available === true || capacity.amdGpuCapacityState === 'available'
  const publicEnabled = capacity.publicEnabled ?? capacity.amdGpuPublicEnabled ?? false
  const canStart = available && publicEnabled
  const reason = capacity.reason || capacity.amdGpuAvailabilityReason || ''
  config.amdGpuCapacityState = available ? 'available' : (capacity.state || 'unavailable')
  config.amdGpuAvailabilityReason = reason
  config.amdGpuPublicEnabled = canStart
  amdModeState.textContent = canStart ? 'Available' : available ? 'Owner locked' : 'No capacity'
  amdModeInput.disabled = !canStart
  amdModeOption.classList.toggle('is-disabled', !canStart)
  amdModeState.title = canStart
    ? 'AMD GPU starts on demand and is destroyed after the job.'
    : reason || 'AMD Cinematic is unavailable.'
  capacityState.textContent = canStart ? 'Ready' : available ? 'Locked' : 'Unavailable'
  capacityButton.classList.toggle('is-ready', canStart)
  computeBadge.classList.toggle('is-safe', canStart)
  computeBadge.querySelector('span').textContent = canStart ? 'AMD GPU ready on demand' : available ? 'AMD GPU owner locked' : 'AMD capacity unavailable'
  computeNote.textContent = canStart
    ? 'Select AMD Cinematic, then start the job. Billing begins only after the Droplet request and stops when it is destroyed.'
    : reason || 'AMD Cinematic is unavailable. Checking capacity never starts GPU billing.'
  if (!canStart && selectedMode() === 'amd_cinematic') document.querySelector('input[value="fast_story"]').checked = true
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
    if (capacity.available && capacity.publicEnabled) {
      amdModeInput.checked = true
      updateGenerateAvailability()
      showToast('AMD capacity is ready. Start the story to create the GPU Droplet.', 5600)
    } else if (capacity.available) {
      showToast('AMD capacity exists, but the owner safety switch is off.', 5600)
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
  const remaining = maxImages - sources.length
  const selected = [...fileList].slice(0, remaining)
  if (!selected.length) {
    showToast(`A Product Story accepts up to ${maxImages} photos.`)
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
  const ready = sources.length >= minImages
  sourceRequirement.textContent = ready
    ? `${sources.length} source photos ready${sources.length === maxImages ? ' · maximum reached' : ''}.`
    : `Add ${minImages - sources.length} more photo${minImages - sources.length === 1 ? '' : 's'}.`
  sourceRequirement.classList.toggle('is-ready', ready)
  updateGenerateAvailability()
  addPhotosButton.hidden = sources.length >= maxImages
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
    ['vision_analysis', 'Vision analysis'],
    ['storyboard', 'Storyboard'],
    ['gpu_provision', 'GPU provision'],
    ['motion_shots', 'Motion shots'],
    ['identity_check', 'Identity check'],
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

function renderActivity(activity = initialActivity()) {
  activityList.replaceChildren(...activity.map((step, index) => {
    const item = document.createElement('li')
    item.className = `activity-step is-${step.status || 'pending'}`
    const marker = document.createElement('span')
    marker.className = 'step-marker'
    marker.textContent = statusMarker(step, index)
    const title = document.createElement('strong')
    title.textContent = step.label
    const detail = document.createElement('p')
    detail.textContent = step.status === 'active' && step.progress
      ? `${step.detail} · ${Math.round(step.progress)}%`
      : step.detail
    item.append(marker, title, detail)
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

function friendlyStatus(status) {
  return ({ queued: 'Queued', analyzing: 'Understanding product', gpu_starting: 'Starting AMD GPU', generating: 'Directing story', ready: 'Story ready', failed: 'Job failed', cancelled: 'Cancelled' })[status] || status
}

function renderJob(job) {
  currentJob = job
  renderActivity(job.activity)
  jobId.textContent = job.id.replace('story_', '').slice(0, 10)
  jobId.title = job.id
  jobStatus.textContent = friendlyStatus(job.status)
  storyTitle.textContent = job.plan?.title || 'Directing your product'
  stageKicker.textContent = job.effectiveMode === 'amd_cinematic' ? 'AMD Cinematic' : 'Motion Preview'
  jobMode.textContent = job.effectiveMode === 'amd_cinematic' ? 'AMD Cinematic' : 'Motion Preview'
  workerState.textContent = job.effectiveMode === 'amd_cinematic' ? (job.gpu?.device || 'AMD worker') : 'Browser compositor'
  gpuState.textContent = job.gpu?.status ? job.gpu.status.replaceAll('_', ' ') : 'Offline'
  const gpuBillingActive = job.gpu?.billing === 'active_for_job'
  const gpuBillingUncertain = job.gpu?.billing === 'possibly_active'
  billingState.textContent = gpuBillingActive ? 'Active for job' : gpuBillingUncertain ? 'Release required' : 'Inactive'
  billingState.classList.toggle('active', gpuBillingActive || gpuBillingUncertain)
  billingState.classList.toggle('safe', !gpuBillingActive && !gpuBillingUncertain)
  outputState.textContent = job.output?.status === 'ready' ? `${job.output.width} × ${job.output.height}` : 'Waiting'
  computeBadge.classList.toggle('is-active', gpuBillingActive || gpuBillingUncertain)
  computeBadge.classList.toggle('is-safe', job.gpu?.status === 'released')
  computeBadge.querySelector('span').textContent = gpuBillingActive || gpuBillingUncertain
    ? gpuBillingUncertain ? 'Release GPU' : 'AMD GPU active'
    : job.gpu?.status === 'released' ? 'AMD GPU released' : 'AMD GPU offline'
  jobWarning.hidden = !job.warning && !job.error
  jobWarning.textContent = job.error || job.warning || ''
  releaseGpuButton.disabled = !gpuBillingActive && !gpuBillingUncertain && !['ready', 'releasing'].includes(job.gpu?.status)
  cancelJobButton.disabled = terminalStates.has(job.status)
  const ready = job.status === 'ready' && Boolean(job.plan)
  exportVideoButton.disabled = !ready
  exportStoryboardButton.disabled = !ready

  if (job.plan) {
    storyFrame.dataset.aspect = job.plan.aspect
    framePreparing.hidden = true
    if (job.output?.videoUrl) {
      generatedVideo.src = job.output.videoUrl
      generatedVideo.hidden = false
      storyImage.hidden = true
    } else {
      generatedVideo.hidden = true
      storyImage.hidden = false
      if (!timeline.children.length) renderTimeline(job.plan)
      if (!storyImage.src) showShot(0, false)
    }
  }
  if (ready) exportStatus.textContent = job.output?.videoUrl
    ? 'AMD video output is ready. The GPU lease has been released.'
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
  if (sources.length < minImages) return
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
      aspect: aspect.value,
      durationSeconds: 15,
      brief: brief.value,
      channel: 'DTC',
      market: market.value,
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
    activeShotIndex = 0
    renderTimeline(null)
    framePreparing.hidden = false
    storyImage.removeAttribute('src')
    generatedVideo.hidden = true
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
  playbackOffset = 0
  activeShotIndex = 0
  timeline.replaceChildren()
  renderActivity()
  computeBadge.classList.remove('is-active', 'is-safe')
  computeBadge.querySelector('span').textContent = config.amdGpuCapacityState === 'unavailable' ? 'AMD capacity unavailable' : 'AMD GPU offline'
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
  const dimensions = plan.aspect === '9:16' ? [720, 1280] : plan.aspect === '1:1' ? [900, 900] : [1280, 720]
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
    showToast('AMD GPU released; billing stopped')
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error))
  } finally {
    releaseGpuButton.textContent = 'Release GPU now'
  }
}

async function loadConfig() {
  try {
    const response = await fetch('/api/config')
    config = await response.json()
    renderCapacity(config)
  } catch {
    amdModeState.textContent = 'Offline'
    amdModeInput.disabled = true
    amdModeOption.classList.add('is-disabled')
    updateGenerateAvailability()
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
computeBadge.addEventListener('click', checkGpuCapacity)
document.querySelectorAll('input[name="storyMode"]').forEach((input) => input.addEventListener('change', updateGenerateAvailability))
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
loadConfig()
