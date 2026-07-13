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

function withoutNegatedPhrases(value) {
  return cleanClause(value, '', 260)
    .toLowerCase()
    .split(/[.;,]/)
    .filter((clause) => !/\b(?:no|not|never|without|avoid)\b/.test(clause))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function hasTemperatureTransition(value) {
  const direction = cleanClause(value, '', 300)
    .toLowerCase()
    .split(/[.;,]/)
    .filter((clause) => !(
      /\b(?:no|not|never|without|avoid)\b/.test(clause)
      && /\b(?:temperature|warm|warmer|cool|cooler)\b/.test(clause)
    ))
    .join(' ')
  if (!/\b(?:temperature|warm|warmer|cool|cooler)\b/.test(direction)) return false
  if (/(?:temperature|warm|warmer|cool|cooler).{0,28}\b(?:constant|fixed|unchanged|stable|steady|holds?)\b|\b(?:constant|fixed|unchanged|stable|steady)\b.{0,28}(?:temperature|warm|cool)/.test(direction)) {
    return false
  }
  return /\b(?:shift|shifts|change|changes|transition|transitions|become|becomes|opening|end|warms|cools|warmer|cooler)\b/.test(direction)
}

function cueIsNegated(value, cuePattern) {
  const text = cleanClause(value, '', 260).toLowerCase()
  return text.split(/[.;,]/).some((clause) => (
    new RegExp(`\\b(?:no|not|never|without|avoid)\\b[^.;,]{0,100}${cuePattern.source}`).test(clause)
  ))
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
  if (hasTemperatureTransition(lighting)) {
    return 'one key-light temperature shift settles into balanced hero light'
  }
  if (/rim/i.test(lighting)) return 'one rim-light sweep settles into balanced hero light'
  if (/highlight|reflection|specular/i.test(lighting)) return 'one controlled highlight travels behind the product and settles'
  if (/low[- ]key|contrast|shadow/i.test(lighting)) return 'low-key contrast opens into balanced commercial light'
  return 'one soft side-light sweep settles into balanced hero light'
}

function productStageCue(value) {
  const environment = cleanClause(value, '', 220).toLowerCase()
  const darkPattern = /\b(?:dark|black|low[- ]key)\b/
  const brightPattern = /\b(?:white|high[- ]key|bright)\b/
  if (!cueIsNegated(environment, darkPattern) && darkPattern.test(environment)) return 'dark neutral studio'
  if (!cueIsNegated(environment, brightPattern) && brightPattern.test(environment)) return 'high-key neutral studio'
  if (/reflective|gloss|polish/.test(environment)) return 'restrained reflective studio surface'
  if (/desk|tabletop|counter/.test(environment)) return 'clean neutral tabletop'
  return 'clean neutral product studio'
}

function productSceneCue(sceneDynamics, motionAffordances) {
  const affordances = Array.isArray(motionAffordances) ? motionAffordances : [motionAffordances]
  const direction = [
    withoutNegatedPhrases(cleanClause(sceneDynamics, '', 240)),
    ...affordances.map((value) => withoutNegatedPhrases(cleanClause(value, '', 140))),
  ].filter(Boolean).join(' ')
  if (/reflection|specular|highlight/.test(direction)) {
    return 'one controlled background reflection and visible material highlight travel once, then settle'
  }
  if (hasTemperatureTransition(direction)) {
    return 'background color temperature shifts once behind the unchanged product, then settles'
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
  sourceViewCount = 1,
  preserveFullGroup = false,
  allowPeople = false,
} = {}) {
  const requestedCameraPreset = productCameraPreset(cameraDirection, motion)
  const singleView = Number(sourceViewCount) <= 1
  // Arc is intentionally disabled until the server can provide structured,
  // validated view-coverage evidence rather than trusting upload count alone.
  const arcDowngraded = requestedCameraPreset === 'Arc'
  const cameraPreset = arcDowngraded ? (motionCameraPresets[motion] || 'Dolly In') : requestedCameraPreset
  const lensClause = productLensCue(lens)
  const depthClause = productDepthCue(depthPlan)
  const lightClause = productLightingCue(lightingTransition)
  const stageClause = productStageCue(environment)
  const sceneClause = productSceneCue(sceneDynamics, motionAffordances)
  const peopleClause = allowPeople
    ? 'People stay behind the product without contact or overlap.'
    : 'Product-only frame.'
  const prompt = [
    'Reference lock: preserve supplied product/set exactly—count, arrangement, geometry, color, material, marks, and text.',
    `Camera: ${cameraPreset}, one smooth constant-speed move.`,
    singleView ? 'Single-view: stay on the visible face; never reveal an unseen side or profile.' : '',
    `Stage: ${stageClause}. Motion: ${sceneClause}.`,
    `Look: ${lensClause}; ${depthClause}; ${lightClause}.`,
    'Background lock: empty and prop-free; nothing enters frame.',
    preserveFullGroup ? 'Group framing: keep every item fully visible throughout.' : '',
    peopleClause,
    'End on a steady complete hero frame with coherent detail.',
  ].filter(Boolean).join(' ')
  return {
    framework: 'reference-locked-mcsla-one-move',
    cameraPreset,
    requestedCameraPreset,
    cameraSafety: arcDowngraded ? 'arc_disabled_without_structured_view_evidence' : 'compiled_one_move',
    prompt,
    wordCount: prompt.split(/\s+/).filter(Boolean).length,
  }
}
