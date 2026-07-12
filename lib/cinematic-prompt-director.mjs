const motionCameraPresets = Object.freeze({
  'push-in': 'Dolly In',
  'pan-left': 'Dolly Left',
  'pan-right': 'Dolly Right',
  'parallax-rise': 'Crane Up',
  'hero-hold': 'Dolly In',
})

function cleanClause(value, fallback = '', max = 140) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  const resolved = text || fallback
  const shortened = resolved.length <= max
    ? resolved
    : resolved.slice(0, max + 1).replace(/\s+\S*$/, '')
  return shortened.replace(/[.;,:\s]+$/, '')
}

function productLensCue(value) {
  const lens = cleanClause(value, '', 180)
  const focalLength = lens.match(/\b\d{2,3}mm(?:\s+equivalent)?\b/i)?.[0]
  if (focalLength) return `${focalLength} lens with natural product perspective`
  if (/macro/i.test(lens)) return 'macro-adjacent lens with controlled product detail'
  return 'natural commercial product perspective'
}

function productDepthCue(value) {
  const depth = cleanClause(value, '', 200)
  if (/focus pull|lands? on|resolves? on/i.test(depth)) return 'a controlled focus pull resolves on the complete product'
  if (/parallax/i.test(depth)) return 'background-only parallax preserves a sharp product silhouette'
  if (/out of focus|falloff|shallow/i.test(depth)) return 'soft background falloff keeps the complete product sharp'
  return 'clear depth separation keeps the complete product sharp'
}

function productLightingCue(value) {
  const lighting = cleanClause(value, '', 220)
  if (/rim/i.test(lighting)) return 'one rim-light sweep settles into balanced hero light'
  if (/highlight|reflection|specular/i.test(lighting)) return 'one controlled highlight travels behind the product and settles'
  if (/low[- ]key|contrast|shadow/i.test(lighting)) return 'low-key contrast opens into balanced commercial light'
  return 'one soft side-light sweep settles into balanced hero light'
}

function productStageCue(value) {
  const environment = cleanClause(value, '', 220).toLowerCase()
  if (/dark|black|low[- ]key/.test(environment)) return 'dark neutral studio'
  if (/white|high[- ]key|bright/.test(environment)) return 'high-key neutral studio'
  if (/reflective|gloss|polish/.test(environment)) return 'restrained reflective studio surface'
  if (/desk|tabletop|counter/.test(environment)) return 'clean neutral tabletop'
  return 'clean neutral product studio'
}

function productSceneCue(sceneDynamics, motionAffordances) {
  const affordances = Array.isArray(motionAffordances) ? motionAffordances.join(' ') : motionAffordances
  const direction = `${cleanClause(sceneDynamics, '', 240)} ${cleanClause(affordances, '', 260)}`.toLowerCase()
  if (/reflection|specular|highlight/.test(direction)) {
    return 'one controlled background reflection and visible material highlight travel once, then settle'
  }
  if (/haze|atmosphere|fog|mist/.test(direction)) {
    return 'subtle background haze shifts behind the unchanged product, then settles'
  }
  if (/shadow/.test(direction)) {
    return 'one soft background shadow travels behind the unchanged product, then settles'
  }
  if (/parallax|depth|plane/.test(direction)) {
    return 'background planes drift with restrained parallax behind the unchanged product'
  }
  if (/focus|rack/.test(direction)) {
    return 'background focus falloff shifts once while the complete product stays sharp'
  }
  return 'background light and depth shift subtly behind the unchanged product'
}

export function productCameraPreset(cameraDirection, motion = 'push-in') {
  const direction = cleanClause(cameraDirection, '', 240).toLowerCase()
  if (/\b(?:360[- ]degree\s+)?orbit(?:al)?\b|\barc(?:ing)?\b/.test(direction)) return 'Arc'
  if (/\bcrane\s+down\b|\bdescend/.test(direction)) return 'Crane Down'
  if (/\bcrane\s+up\b|\brise\b|\bvertical\s+reveal\b/.test(direction)) return 'Crane Up'
  if (/\b(?:dolly|track|move|pan)\s+left\b|\bleftward\b/.test(direction)) return 'Dolly Left'
  if (/\b(?:dolly|track|move|pan)\s+right\b|\brightward\b/.test(direction)) return 'Dolly Right'
  if (/\b(?:dolly|pull|zoom)\s+out\b|\bpull[- ]back\b/.test(direction)) return 'Dolly Out'
  if (/\b(?:dolly|push|zoom)\s+in\b|\bpush[- ]in\b|\bapproach\b/.test(direction)) return 'Dolly In'
  return motionCameraPresets[motion] || 'Dolly In'
}

export function compileProductRenderPrompt({
  cameraDirection = '',
  motion = 'push-in',
  lens = '',
  depthPlan = '',
  lightingTransition = '',
  environment = '',
  sceneDynamics = '',
  motionAffordances = [],
  allowPeople = false,
} = {}) {
  const cameraPreset = productCameraPreset(cameraDirection, motion)
  const lensClause = productLensCue(lens)
  const depthClause = productDepthCue(depthPlan)
  const lightClause = productLightingCue(lightingTransition)
  const stageClause = productStageCue(environment)
  const sceneClause = productSceneCue(sceneDynamics, motionAffordances)
  const peopleClause = allowPeople
    ? 'Any people stay behind the product without contact or overlap.'
    : 'The frame remains product-only.'
  const prompt = [
    'Reference lock: keep the provided product or product set unchanged: same item count, arrangement, geometry, colors, materials, marks, and text.',
    `Camera: ${cameraPreset}, one smooth continuous move at constant speed.`,
    `Stage: ${stageClause}. Motion: ${sceneClause}.`,
    `Look: ${lensClause}; ${depthClause}; ${lightClause}.`,
    peopleClause,
    'End on a steady, complete hero frame with coherent temporal detail.',
  ].join(' ')
  return {
    framework: 'reference-locked-mcsla-one-move',
    cameraPreset,
    prompt,
    wordCount: prompt.split(/\s+/).filter(Boolean).length,
  }
}
