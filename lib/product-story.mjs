export const productStorySteps = Object.freeze([
  { id: 'source_upload', label: 'Source upload' },
  { id: 'vision_analysis', label: 'Vision analysis' },
  { id: 'storyboard', label: 'Storyboard' },
  { id: 'gpu_provision', label: 'GPU provision' },
  { id: 'motion_shots', label: 'Motion shots' },
  { id: 'identity_check', label: 'Identity check' },
  { id: 'video_composition', label: 'Video composition' },
  { id: 'release_gpu', label: 'Release GPU' },
])

const storyModes = new Set(['fast_story', 'amd_cinematic'])
const storyAspects = new Set(['9:16', '1:1', '16:9'])
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
  'slow macro dolly through foreground detail into a confident product reveal',
  'controlled lateral tracking shot with dimensional parallax and soft practical light',
  'low-angle orbit with a precise rack focus from material detail to the full product',
  'dynamic match move into a premium environmental hero composition',
  'slow final push-in with restrained volumetric light and a clean end frame',
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

export function normalizeStoryMode(value) {
  return storyModes.has(value) ? value : 'fast_story'
}

export function normalizeStoryStyle(value) {
  return Object.hasOwn(storyStyleCatalog, value) ? value : 'cinematic_film'
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
    durationSeconds: Math.max(8, Math.min(20, Number(value.durationSeconds) || 15)),
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
  if (normalized.sourceImages.length < 3) throw new Error('A Product Story requires at least three source photos.')

  const analysis = kit.productAnalysis || {}
  const hero = kit.hero || {}
  const brandAngle = kit.brandAngle || {}
  const style = storyStyleCatalog[normalized.style]
  const visibleDetails = Array.isArray(analysis.visibleDetails) ? analysis.visibleDetails.filter(Boolean) : []
  const productName = cleanText(analysis.productType, 'Product')
  const totalShots = Math.min(5, normalized.sourceImages.length)
  const baseDuration = normalized.durationSeconds / totalShots
  const captions = [
    cleanText(hero.headline, `Meet the ${productName}`, 90),
    cleanText(visibleDetails[0], `See the ${productName} up close`, 110),
    cleanText(visibleDetails[1], 'Designed to be seen from every angle', 110),
    cleanText(brandAngle.promise, 'Product details preserved from the source photos', 110),
    cleanText(hero.primaryCta, 'Explore the product', 60),
  ]

  const shots = Array.from({ length: totalShots }, (_, index) => {
    const source = normalized.sourceImages[index]
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
      motion: style.motions[index],
      caption: captions[index],
      startSeconds,
      endSeconds,
      durationSeconds: Math.round((endSeconds - startSeconds) * 100) / 100,
      productPixelPolicy: normalized.mode === 'amd_cinematic' ? 'reference_constrained_and_verified' : 'source_preserved',
      cinematicPrompt: `${style.direction} ${cinematicCameraCatalog[index]}. Keep the exact product identity, silhouette, proportions, colors, logo, packaging text, hardware, and materials from the reference image. Natural physical motion, realistic lens behavior, coherent temporal detail, no on-screen text.`,
      negativePrompt: 'product redesign, changed logo, changed packaging text, duplicate product, warped geometry, melting, flicker, jitter, floating object, extra handles, extra wheels, watermark, subtitles, typography',
      generation: {
        model: 'Wan2.2-TI2V-5B',
        task: 'image_to_video',
        fps: 24,
        durationSeconds: Math.max(3, Math.min(5, Math.round(endSeconds - startSeconds))),
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
    shots,
    identityGuard: {
      productPixels: normalized.mode === 'amd_cinematic' ? 'reference_constrained_and_verified' : 'source_preserved',
      packagingText: normalized.mode === 'amd_cinematic' ? 'ocr_verified_against_source' : 'source_preserved',
      logo: normalized.mode === 'amd_cinematic' ? 'visual_embedding_verified_against_source' : 'source_preserved',
      generativeProductAlteration: false,
      rejectUnverifiedOutput: normalized.mode === 'amd_cinematic',
    },
    output: {
      width: normalized.aspect === '9:16' ? 1080 : normalized.aspect === '1:1' ? 1080 : 1920,
      height: normalized.aspect === '9:16' ? 1920 : normalized.aspect === '1:1' ? 1080 : 1080,
      format: normalized.mode === 'amd_cinematic' ? 'video/mp4' : 'video/webm',
      composition: normalized.mode === 'amd_cinematic' ? 'amd_gpu_multiclip' : 'browser_canvas',
    },
    generatedAt: new Date().toISOString(),
  }
}

export const productStoryLimits = Object.freeze({
  minImages: 3,
  maxImages: 8,
  maxDurationSeconds: 20,
})
