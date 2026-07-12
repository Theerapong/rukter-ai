export const productStorySteps = Object.freeze([
  { id: 'source_upload', label: 'Source upload' },
  { id: 'vision_analysis', label: 'Fireworks vision brief' },
  { id: 'storyboard', label: 'Video prompt direction' },
  { id: 'gpu_queue', label: 'AMD render queue' },
  { id: 'gpu_provision', label: 'AMD GPU provision' },
  { id: 'motion_shots', label: 'Text-guided video generation' },
  { id: 'identity_check', label: 'Product identity check' },
  { id: 'video_composition', label: 'Video composition' },
  { id: 'release_gpu', label: 'Persistent worker status' },
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
const productOnlyFramePrompt = 'Product-centered commercial frame with no people. Keep the complete source product visually dominant and unobstructed while following the approved scene and environment direction.'
const productContextFramePrompt = 'Product-centered commercial frame. The complete source product must remain fully visible, visually dominant, and unobstructed by any person or contextual element.'
const productIdentityPrompt = [
  'Keep the exact product identity, silhouette, proportions, colors, logo, packaging text, hardware, and materials from the reference image.',
  'Animate only camera movement, lighting, and subtle product-safe parallax; do not invent new foreground subjects or occluders.',
  'No unverified foreground subject, duplicate object, occluding prop, extra packaging, or background clutter may obscure or replace the product.',
  'Natural physical motion, realistic lens behavior, and coherent temporal detail. Add no captions, subtitles, watermarks, or overlay text; preserve every source-printed mark and character.',
].join(' ')
const humanNegativePrompts = new Set([
  'person',
  'human',
  'body',
  'body part',
  'hand',
  'hands',
  'fingers',
  'finger',
  'arm',
  'skin',
  'wrist',
  'forearm',
  'nails',
])
const productIdentityNegativePrompts = [
  ...humanNegativePrompts,
  'unverified foreground subject',
  'unrequested duplicate object',
  'occluding prop',
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
  'watermark',
  'subtitles',
  'added overlay text',
]

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

function cleanList(value, maxItems = 8, maxLength = 180) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => cleanText(item, '', maxLength)).filter(Boolean))].slice(0, maxItems)
}

function directorSourceIndex(value, sourceCount, fallbackIndex) {
  const parsed = Math.round(Number(value))
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > sourceCount) return fallbackIndex % sourceCount
  return parsed - 1
}

function peoplePolicyForbidsPeople(value) {
  return /(?:^|[\s_-])(?:no|none|forbid(?:den)?|disallow(?:ed)?)[\s_-]*(?:people|person|human)|product[\s_-]*only/i.test(String(value || ''))
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
  const direction = value.direction && typeof value.direction === 'object' ? value.direction : {}
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
    direction: {
      campaignGoal: cleanText(direction.campaignGoal, 'Present the product clearly and build buyer interest.', 180),
      scenePolicy: cleanText(direction.scenePolicy, 'Keep the source product visually dominant and unobstructed.', 160),
      peoplePolicy: cleanText(direction.peoplePolicy, 'No people or body parts may occlude the product.', 160),
    },
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
  const productDNA = kit.productDNA && typeof kit.productDNA === 'object' ? kit.productDNA : {}
  const videoDirection = kit.videoDirection && typeof kit.videoDirection === 'object' ? kit.videoDirection : {}
  const directedShots = Array.isArray(videoDirection.shots) ? videoDirection.shots.filter((shot) => shot && typeof shot === 'object') : []
  const hero = kit.hero || {}
  const brandAngle = kit.brandAngle || {}
  const style = storyStyleCatalog[normalized.style]
  const requestedDirection = normalized.direction
  const visibleDetails = cleanList(analysis.visibleDetails, 8, 180)
  const productComponents = cleanList(productDNA.components, 8, 120)
  const productIdentityLocks = cleanList([
    ...cleanList(productDNA.identityLocks, 8, 180),
    ...productComponents.map((component) => `Visible component: ${component}`),
    ...visibleDetails,
  ], 10, 180)
  const productMaterials = cleanList(productDNA.materials, 5, 100)
  const productColors = cleanList(productDNA.colors, 5, 80)
  const brandMarks = cleanList(productDNA.brandMarks, 5, 120)
  const visibleText = cleanList(productDNA.visibleText, 5, 120)
  const visualRisks = cleanList(productDNA.visualRisks, 5, 140)
  const motionAffordances = cleanList(productDNA.motionAffordances, 5, 140)
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
    const directorShot = directedShots[index % Math.max(1, directedShots.length)] || {}
    const fallbackSourceIndex = index % normalized.sourceImages.length
    const source = normalized.sourceImages[directorSourceIndex(
      directorShot.sourceViewIndex,
      normalized.sourceImages.length,
      fallbackSourceIndex,
    )]
    const motion = cycleValue(style.motions, index, 'hero-hold')
    const caption = cleanText(directorShot.caption, cycleValue(captions, index, `Show the ${productName}`), 120)
    const cameraDirection = cleanText(
      directorShot.camera,
      cycleValue(cinematicCameraCatalog, index, cinematicCameraCatalog.at(-1)),
      220,
    )
    const purpose = cleanText(directorShot.purpose, `Present the source product clearly in beat ${index + 1}.`, 180)
    const action = cleanText(directorShot.action, 'Use restrained camera and lighting motion while keeping the product unchanged.', 200)
    const lighting = cleanText(directorShot.lighting, 'Controlled commercial lighting that preserves the source colors and materials.', 180)
    const environment = cleanText(directorShot.environment, 'A clean product-focused setting with no unverified props.', 180)
    const transition = cleanText(directorShot.transition, 'A clean edit that does not obscure the product.', 140)
    const shotIdentityLocks = cleanList([
      ...productIdentityLocks,
      ...cleanList(directorShot.identityLocks, 6, 180),
    ], 12, 180)
    const allowedChanges = cleanList(directorShot.allowedChanges, 6, 140)
    const forbiddenChanges = cleanList(directorShot.forbiddenChanges, 8, 140)
    const allowPeople = directorShot.allowPeople === true && !peoplePolicyForbidsPeople(requestedDirection.peoplePolicy)
    const identityEvidence = shotIdentityLocks.length
      ? `Observed identity details that must remain visibly unchanged: ${shotIdentityLocks.join('; ')}.`
      : 'Preserve every directly visible product feature from the source image without inventing unseen details.'
    const materialEvidence = productMaterials.length || productColors.length
      ? `Preserve observed materials${productMaterials.length ? ` (${productMaterials.join(', ')})` : ''} and colors${productColors.length ? ` (${productColors.join(', ')})` : ''}.`
      : ''
    const brandEvidence = brandMarks.length || visibleText.length
      ? `Keep observed brand marks${brandMarks.length ? ` (${brandMarks.join(', ')})` : ''} and visible text${visibleText.length ? ` (${visibleText.join(', ')})` : ''} unchanged and legible.`
      : ''
    const riskDirection = visualRisks.length
      ? `Protect against these source-specific visual risks: ${visualRisks.join('; ')}.`
      : ''
    const motionDirection = motionAffordances.length
      ? `Use only these source-safe motion affordances: ${motionAffordances.join('; ')}.`
      : ''
    const allowedDirection = allowedChanges.length
      ? `Allowed changes: ${allowedChanges.join('; ')}.`
      : 'Only camera movement, lighting, and background treatment may change.'
    const forbiddenDirection = forbiddenChanges.length
      ? `Forbidden changes: ${forbiddenChanges.join('; ')}.`
      : 'Do not redesign, relabel, duplicate, remove, or occlude the product.'
    const peopleDirection = allowPeople
      ? 'People may appear only as non-occluding context; no hand, body part, clothing, or prop may cover, hold, replace, or alter the product.'
      : 'No people, no hands, no fingers, no arms, no body parts, or skin may enter or occlude the product frame.'
    const concept = cleanText(videoDirection.concept, requestedDirection.campaignGoal || `${style.label} product presentation`, 180)
    const cinematicPrompt = [
      style.direction,
      `Creative concept: ${concept}.`,
      `Campaign goal: ${requestedDirection.campaignGoal}`,
      `Requested scene policy: ${requestedDirection.scenePolicy}`,
      `Requested people policy: ${requestedDirection.peoplePolicy}`,
      `Story beat: ${purpose}`,
      `Camera: ${cameraDirection}.`,
      `Lighting: ${lighting}`,
      `Environment: ${environment}`,
      `Action: ${action}`,
      `Transition: ${transition}`,
      identityEvidence,
      materialEvidence,
      brandEvidence,
      riskDirection,
      motionDirection,
      allowedDirection,
      forbiddenDirection,
      peopleDirection,
      allowPeople ? productContextFramePrompt : productOnlyFramePrompt,
      productIdentityPrompt,
    ].filter(Boolean).join(' ')
    const shotNegativePrompt = [
      ...productIdentityNegativePrompts.filter((item) => !allowPeople || !humanNegativePrompts.has(item)),
      ...forbiddenChanges.map((item) => `changed ${item}`),
    ].join(', ')
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
      productPixelPolicy: normalized.mode === 'amd_cinematic' ? 'generative_reference_constrained_check_required' : 'source_preserved',
      cinematicPrompt,
      negativePrompt: shotNegativePrompt,
      identityLocks: shotIdentityLocks,
      allowedChanges,
      forbiddenChanges,
      allowPeople,
      director: {
        purpose,
        camera: cameraDirection,
        lighting,
        environment,
        action,
        transition,
      },
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
    schema: 'rukter.product_story.v2',
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
    director: {
      concept: cleanText(videoDirection.concept, requestedDirection.campaignGoal || `${style.label} product presentation`, 180),
      storyArc: cleanText(videoDirection.storyArc, 'Establish the product, reveal its observed details, and finish on a clear hero view.', 260),
      pacing: cleanText(videoDirection.pacing, style.direction, 180),
      scenePolicy: cleanText(videoDirection.scenePolicy, requestedDirection.scenePolicy, 180),
      campaignGoal: requestedDirection.campaignGoal,
      peoplePolicy: requestedDirection.peoplePolicy,
    },
    productDNA: {
      category: cleanText(productDNA.category, productName, 120),
      identitySummary: cleanText(productDNA.identitySummary, analysis.summary || `${productName} from the supplied source views.`, 260),
      identityLocks: productIdentityLocks,
      materials: productMaterials,
      colors: productColors,
      brandMarks,
      visibleText,
      visualRisks,
      components: productComponents,
      motionAffordances,
    },
    identityGuard: {
      productPixels: normalized.mode === 'amd_cinematic' ? 'generative_reference_constrained_check_required' : 'source_preserved',
      packagingText: normalized.mode === 'amd_cinematic' ? 'ocr_retention_check_required_if_detectable' : 'source_preserved',
      logo: normalized.mode === 'amd_cinematic' ? 'whole_frame_similarity_check_required' : 'source_preserved',
      generativeProductAlteration: normalized.mode === 'amd_cinematic',
      rejectUnverifiedOutput: normalized.mode === 'amd_cinematic',
      identityLocks: productIdentityLocks,
      visualRisks,
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
        prompt: cleanText(shot.cinematicPrompt, '', 2400),
        negativePrompt: cleanText(shot.negativePrompt, '', 1000),
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
