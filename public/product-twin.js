const $ = (selector) => document.querySelector(selector)

const productImages = $('#productImages')
const dropzone = $('#dropzone')
const uploadView = $('#uploadView')
const processingView = $('#processingView')
const workspaceView = $('#workspaceView')
const processingStep = $('#processingStep')
const processingProgress = $('#processingProgress')
const processingSources = $('#processingSources')
const processingSteps = [...document.querySelectorAll('[data-step]')]
const cancelButton = $('#cancelButton')
const newButton = $('#newButton')
const headerActions = $('#headerActions')
const computeStatus = $('#computeStatus')
const exportButton = $('#exportButton')
const saveButton = $('#saveButton')
const inspectorExportButton = $('#inspectorExportButton')
const inspectorSaveButton = $('#inspectorSaveButton')
const twinCanvas = $('#twinCanvas')
const twinLoader = $('#twinLoader')
const resetViewButton = $('#resetViewButton')
const wireframeButton = $('#wireframeButton')
const stageProductName = $('#stageProductName')
const stageTruthNote = $('#stageTruthNote')
const twinModeLabel = $('#twinModeLabel')
const sourceCount = $('#sourceCount')
const sourceStrip = $('#sourceStrip')
const reconstructionList = $('#reconstructionList')
const visualEvidenceList = $('#visualEvidenceList')
const evidenceCount = $('#evidenceCount')
const amdEvidenceList = $('#amdEvidenceList')
const modelTab = $('#modelTab')
const evidenceTab = $('#evidenceTab')
const modelPanel = $('#modelPanel')
const evidencePanel = $('#evidencePanel')
const notesDialog = $('#notesDialog')
const notesButton = $('#notesButton')
const brief = $('#brief')
const channel = $('#channel')
const market = $('#market')
const toast = $('#toast')

const maxImageBytes = 4_000_000
const maxSourceViews = 6
const maxVideoBytes = 750_000_000
const maxVideoDurationSeconds = 90
const supportedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'])
const supportedVideoTypes = new Set(['video/quicktime', 'video/mp4'])
const sourceLabels = ['Front', 'Left', 'Back', 'Right', 'Detail A', 'Detail B']
const orbitLabels = ['Orbit 0°', 'Orbit 60°', 'Orbit 120°', 'Orbit 180°', 'Orbit 240°', 'Orbit 300°']
const processingLabels = ['Preparing source views', 'Isolating the product', 'Extracting visual evidence', 'Rendering the twin preview']
const sessionKey = 'rukter-ai-product-twin-v1'

let config = {}
let latestBuild = null
let preparedSources = []
let abortController = null
let progressTimer = null
let toastTimer = null
let viewerCleanup = () => {}

function cleanText(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || fallback
}

function list(value) {
  return Array.isArray(value) ? value.filter(Boolean) : []
}

function showToast(message, duration = 3600) {
  window.clearTimeout(toastTimer)
  toast.textContent = message
  toast.hidden = false
  toastTimer = window.setTimeout(() => { toast.hidden = true }, duration)
}

function formatBytes(bytes) {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1000))} KB`
}

function setView(name) {
  uploadView.hidden = name !== 'upload'
  processingView.hidden = name !== 'processing'
  workspaceView.hidden = name !== 'workspace'
  const active = name === 'workspace'
  newButton.hidden = !active
  headerActions.hidden = !active
  notesButton.hidden = active
  document.body.dataset.view = name
}

function setActionBusy(busy) {
  for (const button of [newButton, exportButton, saveButton, inspectorExportButton, inspectorSaveButton]) {
    button.disabled = busy
  }
}

function updateProcessing(index) {
  const safeIndex = Math.max(0, Math.min(processingLabels.length - 1, index))
  processingStep.textContent = processingLabels[safeIndex]
  processingProgress.style.width = `${((safeIndex + 1) / processingLabels.length) * 100}%`
  processingSteps.forEach((node, nodeIndex) => {
    node.classList.toggle('is-active', nodeIndex === safeIndex)
    node.classList.toggle('is-complete', nodeIndex < safeIndex)
    const marker = node.querySelector('span')
    if (marker) marker.textContent = nodeIndex < safeIndex ? '✓' : String(nodeIndex + 1)
  })
}

function startProcessing(sources) {
  setView('processing')
  processingSources.replaceChildren(...sources.map((source) => {
    const figure = document.createElement('figure')
    const image = document.createElement('img')
    image.src = source.previewUrl
    image.alt = `${source.label} source view`
    const caption = document.createElement('figcaption')
    caption.textContent = source.label
    figure.append(image, caption)
    return figure
  }))
  let step = 0
  updateProcessing(step)
  progressTimer = window.setInterval(() => {
    step = Math.min(step + 1, processingLabels.length - 1)
    updateProcessing(step)
  }, 3900)
}

function stopProcessing() {
  window.clearInterval(progressTimer)
  progressTimer = null
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('Could not read the image.'))
    reader.readAsDataURL(file)
  })
}

async function normalizeProductImage(file) {
  if (!supportedImageTypes.has(file.type)) throw new Error(`${file.name}: choose a JPG, PNG, WebP, AVIF, or GIF image.`)
  const bitmap = await createImageBitmap(file)
  const maxSide = 1800
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
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
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Could not prepare the image.')), 'image/jpeg', 0.88)
  })
  if (blob.size > maxImageBytes) throw new Error(`${file.name}: the prepared image is over 4 MB.`)
  const name = `${file.name.replace(/\.[^.]+$/, '') || 'product'}.jpg`
  return new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified })
}

function waitForMediaEvent(media, eventName, errorMessage) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      media.removeEventListener(eventName, onReady)
      media.removeEventListener('error', onError)
    }
    const onReady = () => { cleanup(); resolve() }
    const onError = () => { cleanup(); reject(new Error(errorMessage)) }
    media.addEventListener(eventName, onReady, { once: true })
    media.addEventListener('error', onError, { once: true })
  })
}

function canvasToJpegFile(canvas, name, lastModified) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Could not extract a frame from the orbit video.'))
        return
      }
      if (blob.size > maxImageBytes) {
        reject(new Error(`${name}: the prepared video frame is over 4 MB.`))
        return
      }
      resolve(new File([blob], name, { type: 'image/jpeg', lastModified }))
    }, 'image/jpeg', 0.88)
  })
}

async function extractOrbitVideoFrames(file) {
  if (!supportedVideoTypes.has(file.type) && !/\.(?:mov|mp4)$/i.test(file.name)) {
    throw new Error(`${file.name}: choose a MOV or MP4 orbit video.`)
  }
  if (file.size > maxVideoBytes) throw new Error(`${file.name}: orbit video must be under 750 MB.`)

  const objectUrl = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.preload = 'metadata'
  video.muted = true
  video.playsInline = true
  video.src = objectUrl
  try {
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
      await waitForMediaEvent(video, 'loadedmetadata', `${file.name}: this browser could not read the video.`)
    }
    const duration = Number(video.duration)
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(`${file.name}: video duration is invalid.`)
    if (duration > maxVideoDurationSeconds) throw new Error(`${file.name}: keep the orbit video under 90 seconds.`)

    const maxSide = 1800
    const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('This browser could not prepare orbit video frames.')

    const baseName = file.name.replace(/\.[^.]+$/, '') || 'product-orbit'
    const frames = []
    const positions = Array.from({ length: maxSourceViews }, (_, index) => 0.08 + index * (0.84 / maxSourceViews))
    for (let index = 0; index < positions.length; index += 1) {
      const targetTime = Math.min(Math.max(0, duration - 0.05), duration * positions[index])
      if (Math.abs(video.currentTime - targetTime) > 0.01) {
        video.currentTime = targetTime
        await waitForMediaEvent(video, 'seeked', `${file.name}: could not seek to an orbit frame.`)
      }
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      frames.push(await canvasToJpegFile(canvas, `${baseName}-frame-${index + 1}.jpg`, file.lastModified))
    }
    return {
      files: frames,
      labels: orbitLabels,
      capture: {
        kind: 'orbit_video',
        name: file.name,
        type: file.type || 'video/quicktime',
        size: file.size,
        durationMs: Math.round(duration * 1000),
        extractedFrameCount: frames.length,
      },
    }
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(objectUrl)
  }
}

async function prepareSourceFiles(fileList) {
  const selected = [...fileList]
  const videos = selected.filter((file) => supportedVideoTypes.has(file.type) || /\.(?:mov|mp4)$/i.test(file.name))
  if (videos.length > 1) throw new Error('Choose one orbit video at a time.')
  if (videos.length && selected.length > 1) throw new Error('Upload the orbit video by itself. Frames are extracted automatically.')
  if (videos.length === 1) return extractOrbitVideoFrames(videos[0])
  const imageFiles = selected.slice(0, maxSourceViews)
  return {
    files: await Promise.all(imageFiles.map(normalizeProductImage)),
    labels: sourceLabels,
    capture: {
      kind: imageFiles.length > 1 ? 'multi_photo' : 'single_photo',
      extractedFrameCount: imageFiles.length,
    },
  }
}

async function readApiResponse(response, fallback) {
  const contentType = response.headers.get('content-type') || ''
  const body = await response.text()
  if (!contentType.includes('application/json')) throw new Error(`${fallback} (${response.status}).`)
  let payload
  try { payload = body ? JSON.parse(body) : {} } catch { throw new Error(`${fallback}: invalid response.`) }
  if (!response.ok) throw new Error(payload.error || fallback)
  return payload
}

async function uploadSource(source, signal) {
  const response = await fetch('/api/product-image', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: source.file.name, type: source.file.type, dataUrl: source.dataUrl }),
    signal,
  })
  const uploaded = await readApiResponse(response, 'Product image upload failed')
  return { ...uploaded, label: source.label }
}

function appendDefinition(listNode, term, value) {
  const wrapper = document.createElement('div')
  const dt = document.createElement('dt')
  const dd = document.createElement('dd')
  dt.textContent = term
  dd.textContent = cleanText(String(value ?? ''), 'Not recorded')
  wrapper.append(dt, dd)
  listNode.append(wrapper)
}

function renderSourceStrip(payload) {
  const twin = payload.productTwin || {}
  const views = list(twin.sourceViews)
  const count = views.length || preparedSources.length || Math.max(1, Number(twin.sourceCount) || 1)
  sourceCount.textContent = `${count} source view${count === 1 ? '' : 's'}`
  const nodes = preparedSources.map((source, index) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = index === 0 ? 'source-view is-selected' : 'source-view'
    button.setAttribute('aria-label', `Inspect ${source.label} source view`)
    const image = document.createElement('img')
    image.src = source.previewUrl
    image.alt = ''
    const label = document.createElement('span')
    label.textContent = source.label
    button.append(image, label)
    button.addEventListener('click', () => {
      sourceStrip.querySelectorAll('button').forEach((node) => node.classList.toggle('is-selected', node === button))
      window.dispatchEvent(new CustomEvent('rukter:twin-source', { detail: { index, count: preparedSources.length } }))
    })
    return button
  })
  sourceStrip.replaceChildren(...nodes)
}

function renderEvidence(payload) {
  const twin = payload.productTwin || {}
  const evidence = list(twin.visualEvidence)
  evidenceCount.textContent = String(evidence.length)
  visualEvidenceList.replaceChildren(...evidence.map((item) => {
    const node = document.createElement('li')
    node.className = item.status === 'observed' ? 'is-observed' : 'is-unverified'
    const marker = document.createElement('i')
    marker.textContent = item.status === 'observed' ? '✓' : '−'
    const copy = document.createElement('div')
    const label = document.createElement('span')
    const value = document.createElement('strong')
    label.textContent = cleanText(item.label, 'Visual evidence')
    value.textContent = cleanText(item.value, 'Not verifiable')
    copy.append(label, value)
    node.append(marker, copy)
    return node
  }))

  const amd = payload.amdEvidence || {}
  amdEvidenceList.replaceChildren()
  appendDefinition(amdEvidenceList, 'Compute', amd.amdComputeVerified ? 'AMD verified' : 'Fallback only')
  appendDefinition(amdEvidenceList, 'Vision model', cleanText(amd.visionModel, amd.model).replace('accounts/fireworks/models/', ''))
  appendDefinition(amdEvidenceList, 'Response', amd.responseDurationMs ? `${Math.round(amd.responseDurationMs)} ms` : 'Not recorded')
  appendDefinition(amdEvidenceList, 'Platform', cleanText(amd.runtimePlatform, 'linux/amd64'))
}

function renderReconstruction(payload) {
  const twin = payload.productTwin || {}
  const reconstruction = twin.reconstruction || {}
  const capture = twin.sourceCapture || {}
  twinModeLabel.textContent = cleanText(twin.label, '2.5D Product Twin Preview')
  const hasModel = twin.preview?.kind === 'model' && Boolean(twin.preview?.modelUrl)
  twinModeLabel.closest('.mode-line')?.classList.toggle('is-verified', hasModel)
  reconstructionList.replaceChildren()
  appendDefinition(reconstructionList, 'Capture', capture.kind === 'orbit_video' ? 'Orbit video' : capture.kind === 'multi_photo' ? 'Multiple photos' : 'Single photo')
  if (capture.kind === 'orbit_video') {
    const duration = Number(capture.durationMs || 0)
    appendDefinition(reconstructionList, 'Video', `${duration > 0 ? `${(duration / 1000).toFixed(1)} s · ` : ''}${capture.extractedFrameCount || twin.sourceCount || 0} keyframes`)
  }
  appendDefinition(reconstructionList, 'Status', cleanText(reconstruction.status, 'preview_only').replaceAll('_', ' '))
  appendDefinition(reconstructionList, 'Provider', cleanText(reconstruction.provider, 'Rukter browser preview'))
  appendDefinition(reconstructionList, 'Output', hasModel ? cleanText(reconstruction.modelFormat, 'GLB').toUpperCase() : 'Interactive 2.5D')
  appendDefinition(reconstructionList, 'Geometry', hasModel ? (reconstruction.status === 'verified' ? 'Verified from multiple views' : 'Reconstructed mesh') : 'Not verified')
}

function setInspectorTab(tab) {
  const evidenceActive = tab === 'evidence'
  modelTab.setAttribute('aria-selected', String(!evidenceActive))
  evidenceTab.setAttribute('aria-selected', String(evidenceActive))
  modelPanel.hidden = evidenceActive
  evidencePanel.hidden = !evidenceActive
}

async function activateTwinViewer(payload) {
  viewerCleanup()
  const THREE = await import('/vendor/three.module.min.js')
  const twin = payload.productTwin || {}
  const hasModel = twin.preview?.kind === 'model' && Boolean(twin.preview?.modelUrl)
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0xe8e7e4)
  const camera = new THREE.PerspectiveCamera(31, 1, 0.1, 100)
  camera.position.set(0, 0.15, 7.4)
  const renderer = new THREE.WebGLRenderer({
    canvas: twinCanvas,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.12
  renderer.shadowMap.enabled = true

  const group = new THREE.Group()
  scene.add(group)
  let previewWireframe = null
  const modelMaterials = []
  if (hasModel) {
    const inferredFormat = new URL(twin.preview.modelUrl, window.location.href).pathname.split('.').at(-1) || 'glb'
    const modelFormat = cleanText(twin.reconstruction?.modelFormat, inferredFormat).toLowerCase()
    let model
    if (modelFormat === 'usdz' || modelFormat === 'usd' || modelFormat === 'usdc' || modelFormat === 'usda') {
      const { USDLoader } = await import('/vendor/loaders/USDLoader.js')
      model = await new USDLoader().loadAsync(twin.preview.modelUrl)
    } else {
      const { GLTFLoader } = await import('/vendor/loaders/GLTFLoader.js')
      model = (await new GLTFLoader().loadAsync(twin.preview.modelUrl)).scene
    }
    const initialBounds = new THREE.Box3().setFromObject(model)
    const size = initialBounds.getSize(new THREE.Vector3())
    const center = initialBounds.getCenter(new THREE.Vector3())
    const scale = 3.55 / Math.max(size.x, size.y, size.z, 0.001)
    model.scale.setScalar(scale)
    model.position.copy(center).multiplyScalar(-scale)
    model.traverse((child) => {
      if (!child.isMesh) return
      child.castShadow = true
      child.receiveShadow = true
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
        if (material) modelMaterials.push(material)
      }
    })
    group.add(model)
  } else {
    const asset = list(payload.productAssets)[0] || {}
    const textureUrl = asset.dataUrl || asset.url || preparedSources[0]?.previewUrl
    const texture = await new THREE.TextureLoader().loadAsync(textureUrl)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())

    const productGeometry = new THREE.PlaneGeometry(4.35, 4.35, 18, 18)
    for (let layer = 12; layer >= 1; layer -= 1) {
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: 0.055,
        alphaTest: 0.025,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
      const mesh = new THREE.Mesh(productGeometry, material)
      mesh.position.z = -layer * 0.018
      group.add(mesh)
    }
    const face = new THREE.Mesh(productGeometry, new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      alphaTest: 0.02,
      side: THREE.DoubleSide,
    }))
    face.position.z = 0.015
    group.add(face)

    previewWireframe = new THREE.LineSegments(
      new THREE.WireframeGeometry(productGeometry),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22 }),
    )
    previewWireframe.position.z = 0.035
    previewWireframe.visible = false
    group.add(previewWireframe)
  }

  const pedestal = new THREE.Mesh(
    new THREE.CylinderGeometry(1.52, 1.7, 0.24, 64),
    new THREE.MeshStandardMaterial({ color: 0x262626, roughness: 0.76, metalness: 0.12 }),
  )
  pedestal.position.set(0, -1.87, -0.2)
  pedestal.receiveShadow = true
  group.add(pedestal)

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(18, 18),
    new THREE.MeshStandardMaterial({ color: 0xdeddd9, roughness: 0.94 }),
  )
  floor.rotation.x = -Math.PI / 2
  floor.position.y = -2
  floor.receiveShadow = true
  scene.add(floor)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8d8b86, 2.4))
  const key = new THREE.DirectionalLight(0xffffff, 3.6)
  key.position.set(4, 6, 4)
  key.castShadow = true
  scene.add(key)
  const rim = new THREE.DirectionalLight(0xef233c, 1.1)
  rim.position.set(-4, 2, -2)
  scene.add(rim)

  let disposed = false
  let frame = 0
  let dragging = false
  let targetX = 0
  let targetY = 0
  let lastX = 0
  let lastY = 0

  const resize = () => {
    const width = Math.max(1, twinCanvas.clientWidth)
    const height = Math.max(1, twinCanvas.clientHeight)
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.position.z = camera.aspect < 0.85 ? 11.6 : camera.aspect < 1.2 ? 9.4 : 8
    camera.updateProjectionMatrix()
  }
  const observer = new ResizeObserver(resize)
  observer.observe(twinCanvas)
  resize()

  const onPointerDown = (event) => {
    dragging = true
    lastX = event.clientX
    lastY = event.clientY
    twinCanvas.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event) => {
    if (!dragging) return
    targetY = Math.max(-0.68, Math.min(0.68, targetY + (event.clientX - lastX) * 0.006))
    targetX = Math.max(-0.2, Math.min(0.2, targetX + (event.clientY - lastY) * 0.003))
    lastX = event.clientX
    lastY = event.clientY
  }
  const onPointerUp = () => { dragging = false }
  const onReset = () => { targetX = 0; targetY = 0 }
  const onWireframe = () => {
    const enabled = wireframeButton.getAttribute('aria-pressed') !== 'true'
    if (previewWireframe) previewWireframe.visible = enabled
    modelMaterials.forEach((material) => { material.wireframe = enabled; material.needsUpdate = true })
    wireframeButton.setAttribute('aria-pressed', String(enabled))
  }
  const onSource = (event) => {
    const count = Math.max(1, Number(event.detail?.count) || 1)
    const index = Math.max(0, Number(event.detail?.index) || 0)
    targetY = count === 1 ? 0 : ((index / Math.max(1, count - 1)) - 0.5) * 1.1
  }
  twinCanvas.addEventListener('pointerdown', onPointerDown)
  twinCanvas.addEventListener('pointermove', onPointerMove)
  twinCanvas.addEventListener('pointerup', onPointerUp)
  twinCanvas.addEventListener('pointercancel', onPointerUp)
  resetViewButton.addEventListener('click', onReset)
  wireframeButton.addEventListener('click', onWireframe)
  window.addEventListener('rukter:twin-source', onSource)

  const draw = (time) => {
    if (disposed) return
    group.rotation.y += (targetY - group.rotation.y) * 0.075
    group.rotation.x += (targetX - group.rotation.x) * 0.075
    group.position.y = 0.16 + Math.sin(time * 0.00075) * 0.035
    renderer.render(scene, camera)
    frame = requestAnimationFrame(draw)
  }
  frame = requestAnimationFrame(draw)
  twinCanvas.classList.add('is-ready')

  viewerCleanup = () => {
    disposed = true
    cancelAnimationFrame(frame)
    observer.disconnect()
    twinCanvas.removeEventListener('pointerdown', onPointerDown)
    twinCanvas.removeEventListener('pointermove', onPointerMove)
    twinCanvas.removeEventListener('pointerup', onPointerUp)
    twinCanvas.removeEventListener('pointercancel', onPointerUp)
    resetViewButton.removeEventListener('click', onReset)
    wireframeButton.removeEventListener('click', onWireframe)
    window.removeEventListener('rukter:twin-source', onSource)
    const geometries = new Set()
    const materials = new Set()
    const textures = new Set()
    scene.traverse((child) => {
      if (child.geometry) geometries.add(child.geometry)
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
        if (!material) continue
        materials.add(material)
        for (const value of Object.values(material)) if (value?.isTexture) textures.add(value)
      }
    })
    geometries.forEach((geometry) => geometry.dispose())
    materials.forEach((material) => material.dispose())
    textures.forEach((texture) => texture.dispose())
    renderer.dispose()
    wireframeButton.setAttribute('aria-pressed', 'false')
    twinCanvas.classList.remove('is-ready')
  }
}

async function showWorkspace(payload) {
  latestBuild = payload
  const twin = payload.productTwin || {}
  const analysis = payload.kit?.productAnalysis || {}
  stageProductName.textContent = cleanText(analysis.productType, 'Product Twin')
  stageTruthNote.textContent = cleanText(twin.truthNote, 'Depth and unseen surfaces are not verified from one photo.')
  const amdVerified = Boolean(payload.amdEvidence?.amdComputeVerified)
  const hasModel = twin.preview?.kind === 'model' && Boolean(twin.preview?.modelUrl)
  computeStatus.classList.toggle('is-verified', amdVerified)
  computeStatus.lastChild.textContent = amdVerified
    ? (hasModel ? ' AMD GPU reconstruction verified' : ' AMD vision verified')
    : (hasModel ? ' Imported reconstruction' : ' Local preview · AMD not verified')
  renderSourceStrip(payload)
  renderReconstruction(payload)
  renderEvidence(payload)
  setInspectorTab('model')
  twinLoader.hidden = false
  setView('workspace')
  setActionBusy(true)
  await activateTwinViewer(payload)
  twinLoader.hidden = true
  setActionBusy(false)
  try { sessionStorage.setItem(sessionKey, JSON.stringify(payload)) } catch {}
  showToast(hasModel ? '3D Product Twin ready' : `${twin.label || 'Product Twin preview'} ready`)
}

function importedModelPayload(searchParams) {
  const rawModelUrl = searchParams.get('model')
  if (!rawModelUrl) return null
  let modelUrl
  try {
    const url = new URL(rawModelUrl, window.location.href)
    if (url.protocol !== 'https:' && url.origin !== window.location.origin) return null
    modelUrl = url.href
  } catch {
    return null
  }
  const extension = new URL(modelUrl).pathname.split('.').at(-1)?.toLowerCase()
  const format = ['glb', 'gltf', 'usdz', 'usd', 'usdc', 'usda'].includes(extension) ? extension : 'glb'
  const frameCount = Math.max(2, Math.min(999, Number(searchParams.get('frames')) || 6))
  const productName = cleanText(searchParams.get('name'), 'Imported Product Twin')
  return {
    mode: 'imported_model',
    kit: { productAnalysis: { productType: productName, visibleDetails: [], needsReview: [] } },
    productAssets: [],
    productTwin: {
      schema: 'rukter.product_twin.v1',
      mode: 'imported_model_3d',
      label: 'Imported 3D Product Twin',
      truthNote: 'This textured mesh was reconstructed from an orbit capture. AMD verification is recorded separately.',
      sourceCount: frameCount,
      sourceViews: [],
      sourceCapture: { kind: 'orbit_video', extractedFrameCount: frameCount },
      preview: { kind: 'model', imageUrl: '', modelUrl },
      reconstruction: {
        status: 'completed',
        provider: 'RealityKit Object Capture',
        modelFormat: format,
        durationMs: null,
        evidenceId: '',
      },
      visualEvidence: [{ id: 'mesh', label: 'Geometry', value: 'Textured mesh reconstructed from orbit video frames', status: 'observed' }],
    },
    amdEvidence: { amdComputeVerified: false, runtimePlatform: 'macOS reconstruction evidence' },
  }
}

async function buildFromFiles(fileList) {
  if (!fileList?.length) return
  abortController?.abort()
  abortController = new AbortController()
  const controller = abortController
  try {
    const prepared = await prepareSourceFiles(fileList)
    preparedSources.forEach((source) => URL.revokeObjectURL(source.previewUrl))
    preparedSources = await Promise.all(prepared.files.map(async (file, index) => ({
      file,
      label: prepared.labels[index] || `View ${index + 1}`,
      dataUrl: await readFileAsDataUrl(file),
      previewUrl: URL.createObjectURL(file),
    })))
    startProcessing(preparedSources)
    const uploaded = await Promise.all(preparedSources.map((source) => uploadSource(source, controller.signal)))
    updateProcessing(1)
    const input = {
      brief: brief.value.trim(),
      channel: channel.value,
      market: market.value.trim() || 'Thailand and Southeast Asia',
      productImage: { ...uploaded[0], dataUrl: preparedSources[0].dataUrl },
      sourceImages: uploaded,
      capture: prepared.capture,
    }
    const response = await fetch('/api/launch-kit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: controller.signal,
    })
    updateProcessing(2)
    const payload = await readApiResponse(response, 'Product Twin generation failed')
    payload.input = { ...input, productImage: uploaded[0], sourceImages: uploaded, capture: prepared.capture }
    updateProcessing(3)
    await new Promise((resolve) => window.setTimeout(resolve, 420))
    stopProcessing()
    await showWorkspace(payload)
  } catch (error) {
    stopProcessing()
    twinLoader.hidden = true
    setActionBusy(false)
    setView('upload')
    if (error?.name !== 'AbortError') showToast(error instanceof Error ? error.message : String(error), 5200)
  } finally {
    if (abortController === controller) abortController = null
  }
}

function resetBuild() {
  abortController?.abort()
  abortController = null
  stopProcessing()
  viewerCleanup()
  viewerCleanup = () => {}
  latestBuild = null
  preparedSources.forEach((source) => URL.revokeObjectURL(source.previewUrl))
  preparedSources = []
  productImages.value = ''
  sourceStrip.replaceChildren()
  visualEvidenceList.replaceChildren()
  twinLoader.hidden = true
  sessionStorage.removeItem(sessionKey)
  setView('upload')
  setActionBusy(false)
}

async function exportTwin() {
  if (!latestBuild) return
  setActionBusy(true)
  try {
    const response = await fetch('/api/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        exportKind: 'product-twin',
        kit: latestBuild.kit,
        productAssets: latestBuild.productAssets,
        productTwin: latestBuild.productTwin,
      }),
    })
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Export failed.')
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'rukter-product-twin.zip'
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    showToast('Product Twin package exported')
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 4800)
  } finally {
    setActionBusy(false)
  }
}

async function saveToRukter() {
  if (!latestBuild) return
  if (saveButton.dataset.draftUrl) {
    window.open(saveButton.dataset.draftUrl, '_blank', 'noopener,noreferrer')
    return
  }
  setActionBusy(true)
  saveButton.textContent = 'Saving...'
  inspectorSaveButton.textContent = 'Saving...'
  try {
    const response = await fetch('/api/rukter-draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: latestBuild.input,
        kit: latestBuild.kit,
        productAssets: latestBuild.productAssets,
        draftPayload: latestBuild.draftPayload,
        experienceId: 'object-gallery',
        productTwin: latestBuild.productTwin,
      }),
    })
    const body = await response.json().catch(() => ({}))
    if (response.status === 401 && body.connectUrl) {
      window.location.assign(body.connectUrl)
      return
    }
    if (!response.ok) throw new Error(body.error || 'Could not save to Rukter.')
    const draftUrl = body.dashboardUrl || config.dashboardUrl || 'https://store-4.rukter.com/dashboard/theme'
    saveButton.dataset.draftUrl = draftUrl
    saveButton.textContent = 'Open in Rukter'
    inspectorSaveButton.textContent = 'Open in Rukter'
    showToast('Editable Rukter draft saved')
  } catch (error) {
    saveButton.textContent = 'Save to Rukter'
    inspectorSaveButton.textContent = 'Save to Rukter'
    showToast(error instanceof Error ? error.message : String(error), 4800)
  } finally {
    setActionBusy(false)
  }
}

productImages.addEventListener('change', () => buildFromFiles(productImages.files))
dropzone.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('is-dragging') })
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-dragging'))
dropzone.addEventListener('drop', (event) => {
  event.preventDefault()
  dropzone.classList.remove('is-dragging')
  buildFromFiles(event.dataTransfer?.files || [])
})
cancelButton.addEventListener('click', resetBuild)
newButton.addEventListener('click', resetBuild)
exportButton.addEventListener('click', exportTwin)
inspectorExportButton.addEventListener('click', exportTwin)
saveButton.addEventListener('click', saveToRukter)
inspectorSaveButton.addEventListener('click', saveToRukter)
modelTab.addEventListener('click', () => setInspectorTab('model'))
evidenceTab.addEventListener('click', () => setInspectorTab('evidence'))
notesButton.addEventListener('click', () => notesDialog.showModal())

async function initialize() {
  setView('upload')
  try {
    const response = await fetch('/api/config')
    config = response.ok ? await response.json() : {}
  } catch { config = {} }
  const searchParams = new URLSearchParams(window.location.search)
  const importedModel = importedModelPayload(searchParams)
  if (importedModel) {
    await showWorkspace(importedModel)
    return
  }
  const returningFromRukter = searchParams.get('mcp') === 'connected'
  if (returningFromRukter) showToast('Rukter connected. Create or reopen a Product Twin to save it.')
}

initialize()
