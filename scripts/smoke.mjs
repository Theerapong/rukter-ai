import { readFileSync } from 'node:fs'
import sharp from 'sharp'

const baseUrl = process.env.SMOKE_BASE_URL || 'http://localhost:3017'
const responseBudgetMs = 30_000
const demoImage = readFileSync(new URL('../public/assets/demo-serum.jpg', import.meta.url))
const experienceIds = ['editorial-monograph', 'botanical-cinema', 'object-gallery', 'tactile-commerce']

const configResponse = await fetch(`${baseUrl}/api/config`, { signal: AbortSignal.timeout(5_000) })
const config = await configResponse.json()
if (!configResponse.ok || JSON.stringify(config.experienceIds) !== JSON.stringify(experienceIds)) {
  throw new Error('Runtime config does not expose the four premium experience contracts.')
}
if (config.visualCriticThreshold !== 82) throw new Error('Visual critic threshold is not configured.')
if (config.visualCriticRepairPasses !== 2 || config.criticRepairTokens?.length !== 6) {
  throw new Error('Two-pass visual critic repairs are not configured.')
}
if (!config.productStoryConfigured || config.gpuZeroIdlePolicy !== 'destroy_after_job') {
  throw new Error('Product Story zero-idle runtime contract is not configured.')
}
if (config.gpuQueuePolicy !== 'fifo' || config.gpuQueueConcurrency !== 1 || config.gpuQueueCapacity < 1) {
  throw new Error('Product Story FIFO GPU queue contract is not configured.')
}
if (config.storyLimits?.minImages !== 3 || config.storyLimits?.maxImages !== 8) {
  throw new Error('Product Story source image limits are incorrect.')
}
const captureRuntime = await fetch(`${baseUrl}/vendor/html2canvas.min.js`, { signal: AbortSignal.timeout(5_000) })
if (!captureRuntime.ok || (await captureRuntime.arrayBuffer()).byteLength < 100_000) {
  throw new Error('Visual screenshot runtime is missing.')
}

const storySourceImages = []
const demoDataUrl = `data:image/jpeg;base64,${demoImage.toString('base64')}`
for (let index = 0; index < 3; index += 1) {
  const uploadResponse = await fetch(`${baseUrl}/api/product-image`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `story-source-${index + 1}.jpg`, type: 'image/jpeg', dataUrl: demoDataUrl }),
    signal: AbortSignal.timeout(5_000),
  })
  const uploaded = await uploadResponse.json()
  if (!uploadResponse.ok || !uploaded.url) throw new Error('Product Story source upload failed.')
  storySourceImages.push({ ...uploaded, id: `source-${index + 1}`, label: `View ${index + 1}` })
}

const storyResponse = await fetch(`${baseUrl}/api/story-jobs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    mode: 'fast_story',
    aspect: '9:16',
    durationSeconds: 15,
    market: 'Global',
    productImage: { ...storySourceImages[0], dataUrl: demoDataUrl },
    sourceImages: storySourceImages,
  }),
  signal: AbortSignal.timeout(5_000),
})
let storyJob = await storyResponse.json()
if (storyResponse.status !== 202 || !storyJob.id) throw new Error(`Product Story job creation failed: ${JSON.stringify(storyJob)}`)
const storyDeadline = Date.now() + 12_000
while (!['ready', 'failed', 'cancelled'].includes(storyJob.status) && Date.now() < storyDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 250))
  const statusResponse = await fetch(`${baseUrl}/api/story-jobs/${encodeURIComponent(storyJob.id)}`, { signal: AbortSignal.timeout(5_000) })
  storyJob = await statusResponse.json()
}
if (storyJob.status !== 'ready') throw new Error(`Fast Product Story did not complete: ${JSON.stringify(storyJob)}`)
if (storyJob.activity?.length !== 9 || storyJob.plan?.shots?.length !== 3) {
  throw new Error('Product Story did not expose the full activity and storyboard contracts.')
}
if (storyJob.gpu?.billing !== 'inactive' || storyJob.gpu?.status !== 'offline') {
  throw new Error('Fast Product Story unexpectedly started GPU billing.')
}
if (storyJob.activity.find((step) => step.id === 'release_gpu')?.status !== 'skipped') {
  throw new Error('Fast Product Story did not record the zero-lease release step.')
}
if (storyJob.activity.find((step) => step.id === 'gpu_queue')?.status !== 'skipped') {
  throw new Error('Fast Product Story unexpectedly entered the AMD render queue.')
}

const unavailableCinematicResponse = await fetch(`${baseUrl}/api/story-jobs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ mode: 'amd_cinematic', aspect: '16:9', sourceImages: storySourceImages }),
  signal: AbortSignal.timeout(5_000),
})
const unavailableCinematic = await unavailableCinematicResponse.json()
if (unavailableCinematicResponse.status !== 409 || unavailableCinematic.code !== 'amd_cinematic_unavailable') {
  throw new Error('AMD Cinematic was silently substituted while the GPU worker was offline.')
}

const cases = [
  {
    brief: 'Premium Thai herbal skincare for TikTok Shop sellers. Refillable serum bottle with jasmine and rice bran.',
    channel: 'TikTok Shop',
    market: 'Thailand and Southeast Asia',
    productImage: {
      name: 'serum.jpg',
      type: 'image/jpeg',
      size: 281392,
    },
  },
  {
    brief: '\u0e42\u0e04\u0e21\u0e44\u0e1f\u0e1e\u0e01\u0e1e\u0e32\u0e2a\u0e33\u0e2b\u0e23\u0e31\u0e1a\u0e0a\u0e38\u0e14\u0e09\u0e38\u0e01\u0e40\u0e09\u0e34\u0e19\u0e43\u0e19\u0e1e\u0e37\u0e49\u0e19\u0e17\u0e35\u0e48\u0e0a\u0e32\u0e22\u0e1d\u0e31\u0e48\u0e07',
    channel: 'DTC',
    market: 'Global',
  },
  {
    brief: '',
    channel: 'Shopee',
    market: 'Southeast Asia',
    productImage: {
      name: 'catalog-camera.jpg',
      type: 'image/jpeg',
      size: demoImage.length,
      url: 'https://example.com/catalog-camera.jpg',
      dataUrl: `data:image/jpeg;base64,${demoImage.toString('base64')}`,
    },
  },
]

function containsNonLatinLetter(value) {
  return [...String(value || '')].some((character) => (
    /\p{L}/u.test(character) && !/\p{Script=Latin}/u.test(character)
  ))
}

function assertEnglishGeneratedOutput(value) {
  const pending = [value]
  while (pending.length) {
    const current = pending.pop()
    if (typeof current === 'string' && containsNonLatinLetter(current)) {
      throw new Error(`Generated output contains non-English script: ${current.slice(0, 80)}`)
    }
    if (Array.isArray(current)) pending.push(...current)
    else if (current && typeof current === 'object') pending.push(...Object.values(current))
  }
}

const payloads = []
for (const input of cases) {
  const startedAt = performance.now()
  const response = await fetch(`${baseUrl}/api/launch-kit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(responseBudgetMs),
  })
  const elapsedMs = Math.round(performance.now() - startedAt)
  const payload = await response.json()

  if (!response.ok) {
    console.error(payload)
    process.exit(1)
  }

  for (const key of ['kit', 'draftPayload', 'amdEvidence', 'productTwin', 'mode']) {
    if (!(key in payload)) throw new Error(`Missing key: ${key}`)
  }

  for (const key of ['summary', 'productType', 'visibleDetails', 'confidence', 'needsReview']) {
    if (!(key in payload.kit.productAnalysis)) throw new Error(`Missing productAnalysis key: ${key}`)
  }
  for (const key of ['recommendedExperience', 'artDirection', 'tone']) {
    if (!payload.kit.creativeDirection?.[key]) throw new Error(`Missing creativeDirection key: ${key}`)
  }
  if (payload.kit.hero.headline.trim().split(/\s+/).length > 9) {
    throw new Error('Hero headline exceeds the premium 9-word contract.')
  }
  if (payload.kit.hero.subheading.trim().split(/\s+/).length > 24) {
    throw new Error('Hero subheading exceeds the premium 24-word contract.')
  }
  if (!experienceIds.includes(payload.kit.creativeDirection.recommendedExperience)) {
    throw new Error('Creative direction recommended an unsupported experience.')
  }
  if (input.productImage?.dataUrl && !payload.productAssets?.length) {
    throw new Error('Image-only response did not include a cropped product asset.')
  }

  for (const key of [
    'requestTimeoutMs',
    'totalTimeoutMs',
    'maxTokens',
    'modelAttempts',
    'responseDurationMs',
    'responseBudgetMs',
    'withinResponseBudget',
    'amdComputeVerified',
    'submissionEligibleRun',
    'claimSafetyApplied',
    'claimSafetyRewrites',
  ]) {
    if (!(key in payload.amdEvidence)) throw new Error(`Missing amdEvidence key: ${key}`)
  }

  if (elapsedMs >= responseBudgetMs) throw new Error(`Response exceeded ${responseBudgetMs}ms: ${elapsedMs}ms`)
  if (payload.amdEvidence.totalTimeoutMs >= responseBudgetMs) {
    throw new Error(`Configured inference budget must be under ${responseBudgetMs}ms.`)
  }
  if (!payload.amdEvidence.withinResponseBudget) throw new Error('Response evidence did not pass the time budget.')
  if (payload.mode === 'fireworks_inference' && !payload.amdEvidence.submissionEligibleRun) {
    throw new Error('A successful Fireworks run must be marked as submission eligible.')
  }
  if (!payload.amdEvidence.claimSafetyApplied) throw new Error('Seller-verified claim guard was not applied.')

  const customerFacingCopy = JSON.stringify([
    payload.kit.hero,
    payload.kit.storefrontLayout,
    payload.kit.seo,
    payload.kit.socialCaptions,
  ])
  if (/\b(?:already\s+in|award[- ]winning|best[- ]sell(?:er|ing)|clinically\s+(?:proven|tested)|limited[- ]time|limited\s+stock|mix\s+and\s+match|no\s+guilt|real\s+flavor|sealed\s+fresh|sold\s+out|variety\s+pack)\b|\b(?:affordable|baked|bundles?|cheap|discounts?|flavors?|freshness|prices?|referrals?|save)\b/i.test(customerFacingCopy)) {
    throw new Error('Generated storefront contains an unsupported customer-facing claim.')
  }

  assertEnglishGeneratedOutput([payload.kit, payload.draftPayload, payload.amdEvidence])
  payloads.push({ payload, elapsedMs })
}

const headlines = new Set(payloads.map(({ payload }) => payload.kit.hero.headline))
if (headlines.size !== cases.length) {
  throw new Error('Distinct unseen inputs produced the same hero headline; possible hardcoded or cached output.')
}

const imageBuild = payloads[2].payload
if (imageBuild.productTwin?.mode !== 'single_photo_2_5d') throw new Error('Single-photo generation was not labeled as a 2.5D Product Twin preview.')
if (!/not verified/i.test(imageBuild.productTwin?.truthNote || '')) throw new Error('Product Twin response does not disclose unverified depth.')
if (imageBuild.designQuality?.directionCount !== 4) throw new Error('Design quality gate did not report four directions.')
if (!imageBuild.productAssets.some((asset) => asset.backgroundRemoved && asset.isolationMethod === 'ai-guided-edge-matte')) {
  throw new Error('Product extraction did not produce a transparent alpha matte.')
}
const isolatedAsset = imageBuild.productAssets.find((asset) => asset.backgroundRemoved)
if (isolatedAsset.matteQuality < 80 || !isolatedAsset.edgeDecontaminated || isolatedAsset.componentCount < 1) {
  throw new Error('Product extraction did not pass the clean-edge matte contract.')
}
if (!isolatedAsset.url || new URL(isolatedAsset.url).pathname.split('/').at(-2) !== 'uploads') {
  throw new Error('Isolated product asset is not available through a portable public URL.')
}
const isolatedAssetResponse = await fetch(isolatedAsset.url, { signal: AbortSignal.timeout(5_000) })
if (!isolatedAssetResponse.ok || !isolatedAssetResponse.headers.get('content-type')?.includes('image/webp')) {
  throw new Error('Persisted isolated product asset could not be loaded.')
}
const isolatedBuffer = Buffer.from(isolatedAsset.dataUrl.split(',')[1], 'base64')
const alpha = await sharp(isolatedBuffer).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true })
let minX = alpha.info.width
let minY = alpha.info.height
let maxX = -1
let maxY = -1
for (let y = 0; y < alpha.info.height; y += 1) {
  for (let x = 0; x < alpha.info.width; x += 1) {
    if (alpha.data[(y * alpha.info.width + x) * alpha.info.channels] < 96) continue
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
}
if (maxX < 0 || maxY - minY <= maxX - minX) {
  throw new Error('Demo product isolation did not retain the primary upright product.')
}
const rowOpacity = Array.from({ length: alpha.info.height }, (_, y) => {
  let sum = 0
  for (let x = 0; x < alpha.info.width; x += 1) sum += alpha.data[(y * alpha.info.width + x) * alpha.info.channels]
  return sum / alpha.info.width
})
const bandedRows = rowOpacity.slice(1).filter((opacity, index) => Math.abs(opacity - rowOpacity[index]) > 40).length
if (bandedRows > alpha.info.height * 0.15) throw new Error('Transparent alpha matte contains horizontal row banding.')

for (const experienceId of experienceIds) {
  const response = await fetch(`${baseUrl}/api/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kit: imageBuild.kit, productAssets: imageBuild.productAssets, experienceId }),
    signal: AbortSignal.timeout(10_000),
  })
  const archive = Buffer.from(await response.arrayBuffer())
  if (!response.ok || archive.subarray(0, 2).toString() !== 'PK') throw new Error(`Invalid ${experienceId} export archive.`)
  const archiveIndex = archive.toString('latin1')
  for (const required of [
    'index.html',
    'styles.css',
    'script.js',
    'build-details.json',
    'images/product-1.webp',
    'fonts/manrope-variable.woff2',
    'fonts/archivo-variable.woff2',
    'fonts/instrument-serif.woff2',
  ]) {
    if (!archiveIndex.includes(required)) throw new Error(`${experienceId} export is missing ${required}.`)
  }
  if (experienceId === 'botanical-cinema' || experienceId === 'object-gallery') {
    for (const required of ['vendor/three.module.min.js', 'vendor/three.core.min.js']) {
      if (!archiveIndex.includes(required)) throw new Error(`${experienceId} export is missing ${required}.`)
    }
  }
  if ((experienceId === 'botanical-cinema' || experienceId === 'tactile-commerce') && !archiveIndex.includes('vendor/gsap.min.js')) {
    throw new Error('GSAP export is missing vendor/gsap.min.js.')
  }
}

const twinExportResponse = await fetch(`${baseUrl}/api/export`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    exportKind: 'product-twin',
    kit: imageBuild.kit,
    productAssets: imageBuild.productAssets,
    productTwin: imageBuild.productTwin,
  }),
  signal: AbortSignal.timeout(10_000),
})
const twinArchive = Buffer.from(await twinExportResponse.arrayBuffer())
if (!twinExportResponse.ok || twinArchive.subarray(0, 2).toString() !== 'PK') throw new Error('Invalid Product Twin export archive.')
const twinArchiveIndex = twinArchive.toString('latin1')
for (const required of ['viewer.html', 'viewer.css', 'viewer.js', 'product-twin.json', 'images/product-1.webp', 'vendor/three.module.min.js', 'vendor/three.core.min.js']) {
  if (!twinArchiveIndex.includes(required)) throw new Error(`Product Twin export is missing ${required}.`)
}

const modelTwinExportResponse = await fetch(`${baseUrl}/api/export`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    exportKind: 'product-twin',
    kit: imageBuild.kit,
    productAssets: [],
    productTwin: {
      ...imageBuild.productTwin,
      mode: 'imported_model_3d',
      preview: {
        kind: 'model',
        modelUrl: `${baseUrl}/assets/product-3730-photogrammetry.usdz`,
      },
      reconstruction: {
        status: 'completed',
        provider: 'RealityKit Object Capture',
        modelFormat: 'usdz',
      },
    },
  }),
  signal: AbortSignal.timeout(15_000),
})
const modelTwinArchive = Buffer.from(await modelTwinExportResponse.arrayBuffer())
if (!modelTwinExportResponse.ok || modelTwinArchive.subarray(0, 2).toString() !== 'PK') throw new Error('Invalid model Product Twin export archive.')
const modelTwinArchiveIndex = modelTwinArchive.toString('latin1')
for (const required of ['models/product.usdz', 'vendor/loaders/USDLoader.js', 'vendor/loaders/GLTFLoader.js', 'vendor/libs/fflate.module.js']) {
  if (!modelTwinArchiveIndex.includes(required)) throw new Error(`Model Product Twin export is missing ${required}.`)
}

console.log(JSON.stringify({
  status: 'ok',
  cases: payloads.length,
  modes: payloads.map(({ payload }) => payload.mode),
  providers: payloads.map(({ payload }) => payload.amdEvidence.provider),
  responseMs: payloads.map(({ elapsedMs }) => elapsedMs),
  responseBudgetMs,
  totalTimeoutMs: payloads[0].payload.amdEvidence.totalTimeoutMs,
  outputsDiffer: true,
  englishGeneratedOutput: true,
  draftOnly: payloads.every(({ payload }) => payload.draftPayload.draftOnly),
  imageOnlyInputAccepted: payloads.some(({ payload }) => payload.amdEvidence.visionInputUsed),
  transparentProductAsset: true,
  cleanEdgeMatte: isolatedAsset.matteQuality,
  portableProductAsset: true,
  visualCriticRuntime: true,
  visualCriticRepairPasses: config.visualCriticRepairPasses,
  experienceExports: experienceIds.length,
  productTwinMode: imageBuild.productTwin.mode,
  productTwinExport: true,
  portableModelExport: true,
}, null, 2))
