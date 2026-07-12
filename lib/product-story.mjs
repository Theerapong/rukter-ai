export const productStorySteps = Object.freeze([
  { id: 'source_upload', label: 'Source upload' },
  { id: 'vision_analysis', label: 'Fireworks vision brief' },
  { id: 'storyboard', label: 'Video prompt direction' },
  { id: 'gpu_queue', label: 'AMD render queue' },
  { id: 'gpu_provision', label: 'AMD GPU provision' },
  { id: 'motion_shots', label: 'Text-guided video generation' },
  { id: 'identity_check', label: 'Product identity check' },
  { id: 'video_composition', label: 'Video composition' },
  { id: 'release_gpu', label: 'Release GPU' },
])

const storyModes = new Set(['fast_story', 'amd_cinematic'])
const storyAspects = new Set(['9:16', '1:1', '16:9'])
const storyDurationOptions = Object.freeze([8, 12, 15, 20])
const storyRenderResolutionCatalog = Object.freeze({
  fast: {
    label: 'Fast preview',
    description: 'about half the pixels of standard',
    portrait: [384, 672],
    square: [384, 384],
    landscape: [672, 384],
  },
  standard: {
    label: 'Standard',
    description: 'current AMD worker default',
    portrait: [544, 960],
    square: [544, 544],
    landscape: [960, 544],
  },
  detail: {
    label: 'Detail',
    description: 'slower, more pixels',
    portrait: [640, 1120],
    square: [640, 640],
    landscape: [1120, 640],
  },
})
const storyStyleCatalog = Object.freeze({
  cinematic_film: {
    label: 'Cinematic Product Film',
    direction: 'Deliberate camera movement, dramatic pacing, premium commercial light, and a confident final reveal.',
    motions: ['push-in', 'pan-left', 'parallax-rise', 'pan-right', 'hero-hold'],
  },
  social_commerce: {
    label: 'Social Commerce',
    direction: 'A strong first-frame hook, quick readable beats, energetic camera movement, and a clear product payoff.',
    motions: ['push-in', 'pan-right', 'pan-left', 'push-in', 'hero-hold'],
  },
  luxury_editorial: {
    label: 'Luxury Editorial',
    direction: 'Quiet gallery pacing, tactile close attention to materials, restrained movement, and an art-directed finish.',
    motions: ['hero-hold', 'parallax-rise', 'push-in', 'pan-right', 'hero-hold'],
  },
  technical_demo: {
    label: 'Technical Demo',
    direction: 'Clear evidence-led sequencing, measured camera movement, detail-first framing, and a precise end frame.',
    motions: ['pan-left', 'hero-hold', 'pan-right', 'parallax-rise', 'push-in'],
  },
})
const cinematicCameraCatalog = [
  'slow product-only dolly that keeps the source object centered and fully recognizable',
  'controlled lateral tracking shot with dimensional parallax on the same product and no added props',
  'low-angle orbit with a precise rack focus from material detail to the full product silhouette',
  'restrained studio match move into a premium product-only hero composition',
  'slow final push-in with restrained light and a clean product-only end frame',
]
const maxDirectedStoryShots = 5
const minAmdCinematicStoryShots = 4
const productIdentityPrompt = [
  'Keep the exact product identity, silhouette, proportions, colors, logo, packaging text, hardware, and materials from the reference image.',
  'Animate only camera movement, lighting, and subtle product-safe parallax; do not invent new foreground subjects.',
  'No people, hands, fingers, arms, tools, pens, sticks, utensils, unrelated boxes, extra packaging, lifestyle props, or background clutter.',
  'Natural physical motion, realistic lens behavior, coherent temporal detail, no on-screen text.',
].join(' ')
const productIdentityNegativePrompt = [
  'person',
  'human',
  'hand',
  'hands',
  'fingers',
  'arm',
  'tools',
  'pen',
  'stick',
  'utensil',
  'unrelated box',
  'unrelated packaging',
  'extra object',
  'foreground object',
  'lifestyle scene',
  'scene replacement',
  'background clutter',
  'product redesign',
  'changed logo',
  'changed packaging text',
  'duplicate product',
  'warped geometry',
  'melting',
  'flicker',
  'jitter',
  'floating object',
  'extra handles',
  'extra wheels',
  'watermark',
  'subtitles',
  'typography',
].join(', ')

function cleanText(value, fallback = '', max = 240) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return (text || fallback).slice(0, max)
}

function cleanUrl(value) {
  try {
    const url = new URL(cleanText(value, '', 1200))
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : ''
  } catch {
    return ''
  }
}

function cycleValue(values, index, fallback = '') {
  return Array.isArray(values) && values.length ? values[index % values.length] || fallback : fallback
}

function closestDurationSeconds(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 8
  return storyDurationOptions.reduce((closest, candidate) => (
    Math.abs(candidate - parsed) < Math.abs(closest - parsed) ? candidate : closest
  ), storyDurationOptions[0])
}

function normalizeStoryRenderResolution(value) {
  return Object.hasOwn(storyRenderResolutionCatalog, value) ? value : 'fast'
}

function storyOutputDimensions(aspect, renderResolution) {
  const preset = storyRenderResolutionCatalog[normalizeStoryRenderResolution(renderResolution)]
  if (aspect === '1:1') return { width: preset.square[0], height: preset.square[1] }
  if (aspect === '16:9') return { width: preset.landscape[0], height: preset.landscape[1] }
  return { width: preset.portrait[0], height: preset.portrait[1] }
}

function storyShotCount(normalized) {
  const sourceCount = normalized.sourceImages.length
  if (normalized.mode === 'amd_cinematic') {
    return Math.min(maxDirectedStoryShots, Math.max(minAmdCinematicStoryShots, sourceCount))
  }
  return Math.min(maxDirectedStoryShots, sourceCount)
}

export function normalizeStoryMode(value) {
  return storyModes.has(value) ? value : 'fast_story'
}

export function normalizeStoryStyle(value) {
  return Object.hasOwn(storyStyleCatalog, value) ? value : 'cinematic_film'
}

export function normalizeStoryResolution(value) {
  return normalizeStoryRenderResolution(value)
}

export function shouldSyncAmdQueuePreparation(status) {
  return !['gpu_starting', 'generating', 'cancelling', 'ready', 'failed', 'cancelled'].includes(status)
}

export function normalizeStoryRequest(value = {}) {
  const sourceImages = Array.isArray(value.sourceImages)
    ? value.sourceImages.slice(0, 8).map((image, index) => ({
        id: cleanText(image?.id, `source-${index + 1}`, 80),
        name: cleanText(image?.name, `Product photo ${index + 1}`, 120),
        label: cleanText(image?.label, `View ${index + 1}`, 40),
        type: cleanText(image?.type, 'image/jpeg', 80),
        size: Math.max(0, Number(image?.size) || 0),
        url: cleanUrl(image?.url),
      })).filter((image) => image.url)
    : []
  return {
    mode: normalizeStoryMode(value.mode),
    style: normalizeStoryStyle(value.style),
    aspect: storyAspects.has(value.aspect) ? value.aspect : '9:16',
    durationSeconds: closestDurationSeconds(value.durationSeconds),
    renderResolution: normalizeStoryRenderResolution(value.renderResolution),
    sourceImages,
  }
}

export function createStoryActivity() {
  return productStorySteps.map((step) => ({
    ...step,
    status: 'pending',
    detail: 'Waiting',
    progress: 0,
    startedAt: null,
    completedAt: null,
  }))
}

export function buildProductStoryPlan({ kit = {}, request = {} } = {}) {
  const normalized = normalizeStoryRequest(request)
  if (normalized.sourceImages.length < productStoryLimits.minImages) {
    throw new Error('A Product Story requires at least one source photo.')
  }

  const analysis = kit.productAnalysis || {}
  const hero = kit.hero || {}
  const brandAngle = kit.brandAngle || {}
  const style = storyStyleCatalog[normalized.style]
  const visibleDetails = Array.isArray(analysis.visibleDetails) ? analysis.visibleDetails.filter(Boolean) : []
  const productName = cleanText(analysis.productType, 'Product')
  const totalShots = storyShotCount(normalized)
  const baseDuration = normalized.durationSeconds / totalShots
  const outputDimensions = storyOutputDimensions(normalized.aspect, normalized.renderResolution)
  const captions = [
    cleanText(hero.headline, `Meet the ${productName}`, 90),
    cleanText(visibleDetails[0], `See the ${productName} up close`, 110),
    cleanText(visibleDetails[1], 'Designed to be seen from every angle', 110),
    cleanText(brandAngle.promise, 'Product details preserved from the source photos', 110),
    cleanText(hero.primaryCta, 'Explore the product', 60),
  ]

  const shots = Array.from({ length: totalShots }, (_, index) => {
    const source = normalized.sourceImages[index % normalized.sourceImages.length]
    const motion = cycleValue(style.motions, index, 'hero-hold')
    const caption = cycleValue(captions, index, `Show the ${productName}`)
    const cameraDirection = cycleValue(cinematicCameraCatalog, index, cinematicCameraCatalog.at(-1))
    const startSeconds = Math.round(index * baseDuration * 100) / 100
    const endSeconds = index === totalShots - 1
      ? normalized.durationSeconds
      : Math.round((index + 1) * baseDuration * 100) / 100
    return {
      id: `shot-${index + 1}`,
      index: index + 1,
      sourceId: source.id,
      sourceUrl: source.url,
      sourceLabel: source.label,
      motion,
      caption,
      startSeconds,
      endSeconds,
      durationSeconds: Math.round((endSeconds - startSeconds) * 100) / 100,
      productPixelPolicy: normalized.mode === 'amd_cinematic' ? 'reference_constrained_and_verified' : 'source_preserved',
      cinematicPrompt: `${style.direction} ${cameraDirection}. ${productIdentityPrompt}`,
      negativePrompt: productIdentityNegativePrompt,
      generation: {
        model: normalized.mode === 'amd_cinematic' ? 'Wan2.2-TI2V-5B' : 'Source Motion Preview',
        task: normalized.mode === 'amd_cinematic' ? 'text_guided_image_to_video' : 'source_photo_animation',
        runtime: normalized.mode === 'amd_cinematic' ? 'AMD ROCm' : 'Browser',
        backend: normalized.mode === 'amd_cinematic' ? 'Diffusers' : 'Canvas',
        fps: normalized.mode === 'amd_cinematic' ? 16 : 24,
        durationSeconds: normalized.mode === 'amd_cinematic'
          ? Math.max(2, Math.min(5, Math.round(endSeconds - startSeconds)))
          : Math.max(2, Math.min(5, Math.round(endSeconds - startSeconds))),
        sourceConditioning: 'first_frame',
      },
    }
  })

  return {
    schema: 'rukter.product_story.v1',
    title: `${productName} Product Story`,
    productName,
    mode: normalized.mode,
    style: normalized.style,
    styleLabel: style.label,
    styleDirection: style.direction,
    aspect: normalized.aspect,
    durationSeconds: normalized.durationSeconds,
    renderResolution: normalized.renderResolution,
    renderResolutionLabel: storyRenderResolutionCatalog[normalized.renderResolution].label,
    shots,
    identityGuard: {
      productPixels: normalized.mode === 'amd_cinematic' ? 'reference_constrained_and_verified' : 'source_preserved',
      packagingText: normalized.mode === 'amd_cinematic' ? 'ocr_verified_against_source' : 'source_preserved',
      logo: normalized.mode === 'amd_cinematic' ? 'visual_embedding_verified_against_source' : 'source_preserved',
      generativeProductAlteration: false,
      rejectUnverifiedOutput: normalized.mode === 'amd_cinematic',
    },
    output: {
      width: outputDimensions.width,
      height: outputDimensions.height,
      format: normalized.mode === 'amd_cinematic' ? 'video/mp4' : 'video/webm',
      composition: normalized.mode === 'amd_cinematic' ? 'amd_gpu_multiclip' : 'browser_canvas',
    },
    generatedAt: new Date().toISOString(),
  }
}

export function buildStoryAiTrace({ kit = {}, mode = 'demo_fallback', model = '', sourceCount = 0, plan = null, inferenceMeta = null } = {}) {
  const analysis = kit.productAnalysis || {}
  const modelId = cleanText(model, '', 180)
  const prompts = Array.isArray(plan?.shots)
    ? plan.shots.map((shot) => ({
        shot: Number(shot.index) || 1,
        sourceLabel: cleanText(shot.sourceLabel, 'Product view', 60),
        caption: cleanText(shot.caption, '', 120),
        prompt: cleanText(shot.cinematicPrompt, '', 700),
        negativePrompt: cleanText(shot.negativePrompt, '', 500),
      }))
    : []
  const generation = plan?.shots?.[0]?.generation || null
  return {
    provider: mode === 'fireworks_inference' ? 'Fireworks AI' : 'Local deterministic fallback',
    modelId: modelId || 'No remote model used',
    gemmaActive: /gemma/i.test(modelId),
    role: 'Product image understanding and video prompt direction',
    sourceCount: Math.max(0, Math.min(8, Number(sourceCount) || 0)),
    inferenceDurationMs: Math.max(0, Number(inferenceMeta?.durationMs) || 0),
    inferenceAttempts: Array.isArray(inferenceMeta?.attempts) ? inferenceMeta.attempts.length : 0,
    productType: cleanText(analysis.productType, 'Product', 120),
    summary: cleanText(analysis.summary, 'Product analysis is not available yet.', 500),
    observations: Array.isArray(analysis.visibleDetails)
      ? analysis.visibleDetails.map((detail) => cleanText(detail, '', 240)).filter(Boolean).slice(0, 8)
      : [],
    confidence: cleanText(analysis.confidence, 'Not reported', 240),
    needsReview: Array.isArray(analysis.needsReview)
      ? analysis.needsReview.map((detail) => cleanText(detail, '', 240)).filter(Boolean).slice(0, 8)
      : [],
    prompts,
    generation: generation ? {
      model: cleanText(generation.model, 'Wan2.2-TI2V-5B', 120),
      task: cleanText(generation.task, 'text_guided_image_to_video', 80),
      runtime: cleanText(generation.runtime, 'AMD ROCm', 80),
      backend: cleanText(generation.backend, 'Diffusers', 80),
    } : null,
  }
}

export const productStoryLimits = Object.freeze({
  minImages: 1,
  maxImages: 8,
  minAmdCinematicShots: minAmdCinematicStoryShots,
  maxDirectedShots: maxDirectedStoryShots,
  minDurationSeconds: storyDurationOptions[0],
  maxDurationSeconds: 20,
  durationOptionsSeconds: storyDurationOptions,
  renderResolutions: Object.entries(storyRenderResolutionCatalog).map(([id, value]) => ({
    id,
    label: value.label,
    description: value.description,
    dimensions: {
      '9:16': { width: value.portrait[0], height: value.portrait[1] },
      '1:1': { width: value.square[0], height: value.square[1] },
      '16:9': { width: value.landscape[0], height: value.landscape[1] },
    },
  })),
})
