import http from 'node:http'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ZipArchive } from 'archiver'
import sharp from 'sharp'
import {
  dedupeProductDetections,
  normalizeBoundingBox,
  normalizeProductDetections as normalizeProductDetectionRecords,
  selectProductAssets,
} from './lib/product-assets.mjs'
import {
  buildProductTwinManifest,
  normalizeSourceCapture,
  normalizeSourceViews,
} from './lib/product-twin.mjs'
import {
  buildStoryAiTrace,
  buildProductStoryPlan,
  createStoryActivity,
  normalizeStoryRequest,
  productStoryLimits,
} from './lib/product-story.mjs'
import { runAmdStoryJob } from './lib/amd-story-orchestrator.mjs'
import { createDigitalOceanGpuOrchestrator } from './lib/digitalocean-gpu-orchestrator.mjs'
import { createSerialJobQueue } from './lib/serial-job-queue.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.join(__dirname, 'public')
const amdWorkerDir = path.join(__dirname, 'amd-worker')
const uploadDir = path.join(__dirname, '.runtime', 'uploads')
const port = Number(process.env.PORT || 3017)
const storyJobs = new Map()
const storyJobTtlMs = 60 * 60 * 1000
const amdStoryQueueMaxSize = Math.max(1, Math.min(100, Number(process.env.AMD_GPU_QUEUE_MAX_SIZE) || 25))
const amdCapacityPollMs = Math.max(5_000, Math.min(120_000, Number(process.env.AMD_GPU_CAPACITY_POLL_MS) || 30_000))
const maxBodyBytes = 6_000_000
const maxUploadBytes = 4_000_000
const maxVideoUploadBytes = 50_000_000
const maxProductAssets = 4
const experienceCatalog = Object.freeze({
  'editorial-monograph': { name: 'Editorial Monograph', engine: 'CSS + JavaScript' },
  'botanical-cinema': { name: 'Botanical Cinema', engine: 'Three.js + GSAP' },
  'object-gallery': { name: 'Object Gallery', engine: 'Three.js' },
  'tactile-commerce': { name: 'Tactile Commerce', engine: 'GSAP' },
})
const criticRepairTokens = Object.freeze([
  'tighten-headline',
  'reduce-copy-width',
  'balance-hero',
  'increase-product-scale',
  'increase-contrast',
  'simplify-actions',
])
const exportFontFiles = Object.freeze([
  'manrope-variable.woff2',
  'archivo-variable.woff2',
  'instrument-serif.woff2',
  'LICENSE-manrope.txt',
  'LICENSE-archivo.txt',
  'LICENSE-instrument-serif.txt',
])
const defaultExperienceId = 'editorial-monograph'
const oauthCookieMaxAge = 60 * 60 * 12
const defaultFireworksModel = 'accounts/fireworks/models/deepseek-v4-flash'
const defaultFireworksFallbackModels = ['accounts/fireworks/models/gpt-oss-20b']
const defaultFireworksVisionModel = 'accounts/fireworks/models/kimi-k2p6'
const defaultFireworksRequestTimeoutMs = 24_000
const defaultFireworksTotalTimeoutMs = 27_000
const defaultFireworksMaxTokens = 2048
const hackathonResponseBudgetMs = 30_000
const amdGpuPublicUrl = process.env.RUKTER_AI_PUBLIC_URL || 'https://rukter.ai'
const gpuLeaseOrchestrator = process.env.AMD_GPU_DIGITALOCEAN_TOKEN
  ? createDigitalOceanGpuOrchestrator({
      token: process.env.AMD_GPU_DIGITALOCEAN_TOKEN,
      workerToken: process.env.AMD_GPU_ORCHESTRATOR_TOKEN || '',
      publicUrl: amdGpuPublicUrl,
      region: process.env.AMD_GPU_REGION || 'atl1',
      size: process.env.AMD_GPU_SIZE || 'gpu-mi300x1-192gb-devcloud',
      image: process.env.AMD_GPU_IMAGE || 'amddevelopercloud-pytorch2100rocm724',
      vpcUuid: process.env.AMD_GPU_VPC_UUID || '',
      sshKeyFingerprint: process.env.AMD_GPU_SSH_KEY_FINGERPRINT || '',
      sshKeyName: process.env.AMD_GPU_SSH_KEY_NAME || '',
      persistentTag: process.env.AMD_GPU_PERSISTENT_TAG || 'rukter-product-story-persistent',
      ttlSeconds: Number(process.env.AMD_GPU_LEASE_TTL_SECONDS) || 1800,
      workerSourceBaseUrl: process.env.AMD_GPU_WORKER_SOURCE_BASE_URL,
    })
  : null
const amdStoryQueue = createSerialJobQueue({
  maxSize: amdStoryQueueMaxSize,
  runJob: processQueuedAmdStoryJob,
  onChange: syncAmdStoryQueueState,
  onError: handleUnexpectedAmdQueueError,
})
const freeformCreativePageSchema = 'rukter.freeform_creative_page.v4'
const launchKitResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'RukterLaunchKit',
    schema: {
      type: 'object',
      required: ['productAnalysis', 'productDetections', 'creativeDirection', 'brandAngle', 'hero', 'storefrontLayout', 'mediaPlan', 'seo', 'socialCaptions', 'dashboardReview'],
      properties: {
        productAnalysis: {
          type: 'object',
          required: ['summary', 'productType', 'visibleDetails', 'confidence', 'needsReview'],
          properties: {
            summary: { type: 'string' },
            productType: { type: 'string' },
            visibleDetails: { type: 'array', items: { type: 'string' } },
            confidence: { type: 'string' },
            needsReview: { type: 'array', items: { type: 'string' } },
          },
        },
        productDetections: {
          type: 'array',
          maxItems: maxProductAssets,
          items: {
            type: 'object',
            required: ['label', 'bbox', 'confidence', 'rotationDegrees'],
            properties: {
              label: { type: 'string' },
              bbox: {
                type: 'object',
                required: ['x', 'y', 'width', 'height'],
                properties: {
                  x: { type: 'number' },
                  y: { type: 'number' },
                  width: { type: 'number' },
                  height: { type: 'number' },
                },
              },
              confidence: { type: 'string' },
              rotationDegrees: { type: 'number', enum: [0, 90, 180, 270] },
            },
          },
        },
        creativeDirection: {
          type: 'object',
          required: ['recommendedExperience', 'artDirection', 'tone'],
          properties: {
            recommendedExperience: { type: 'string', enum: Object.keys(experienceCatalog) },
            artDirection: { type: 'string' },
            tone: { type: 'string' },
          },
        },
        brandAngle: {
          type: 'object',
          required: ['positioning', 'customer', 'promise'],
          properties: {
            positioning: { type: 'string' },
            customer: { type: 'string' },
            promise: { type: 'string' },
          },
        },
        hero: {
          type: 'object',
          required: ['headline', 'subheading', 'primaryCta', 'secondaryCta'],
          properties: {
            headline: { type: 'string' },
            subheading: { type: 'string' },
            primaryCta: { type: 'string' },
            secondaryCta: { type: 'string' },
          },
        },
        storefrontLayout: {
          type: 'array',
          items: {
            type: 'object',
            required: ['section', 'purpose', 'copy', 'editableSlots'],
            properties: {
              section: { type: 'string' },
              purpose: { type: 'string' },
              copy: { type: 'string' },
              editableSlots: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        mediaPlan: {
          type: 'array',
          items: {
            type: 'object',
            required: ['slot', 'direction', 'assetKind'],
            properties: {
              slot: { type: 'string' },
              direction: { type: 'string' },
              assetKind: { type: 'string' },
            },
          },
        },
        seo: {
          type: 'object',
          required: ['title', 'description', 'keywords'],
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            keywords: { type: 'array', items: { type: 'string' } },
          },
        },
        socialCaptions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['channel', 'caption'],
            properties: {
              channel: { type: 'string' },
              caption: { type: 'string' },
            },
          },
        },
        dashboardReview: { type: 'array', items: { type: 'string' } },
      },
    },
  },
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.usdz': 'model/vnd.usdz+zip',
  '.usd': 'model/vnd.usd',
  '.usdc': 'model/vnd.usd',
  '.usda': 'model/vnd.usd',
  '.mp4': 'video/mp4',
}

const uploadMimeTypes = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/avif', '.avif'],
  ['image/gif', '.gif'],
])

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, {
    location,
    'cache-control': 'no-store',
    ...headers,
  })
  res.end()
}

function sendText(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readCookie(req, name) {
  const cookie = req.headers.cookie || ''
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
  return match ? decodeURIComponent(match[1]) : ''
}

function cookieHeader(name, value, options = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'SameSite=Lax',
    'HttpOnly',
  ]
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`)
  if (options.secure !== false) parts.push('Secure')
  return parts.join('; ')
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBodyBytes) {
        reject(new Error('Request body is too large.'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function readBuffer(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('Request body is too large.'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function publicOrigin(req) {
  if (process.env.RUKTER_AI_PUBLIC_URL) return process.env.RUKTER_AI_PUBLIC_URL.replace(/\/$/, '')
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${port}`
  const hostname = String(host).split(':')[0]
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
  const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  const protocol = isLocalHost ? (forwardedProto || 'http') : 'https'
  return `${protocol}://${host}`
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

function randomToken(bytes = 32) {
  return base64Url(Buffer.from(randomUUID() + randomUUID()).subarray(0, bytes))
}

function pkceChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url')
}

function cleanText(value, max = 1200) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, max)
}

function normalizeExperienceId(value) {
  const id = cleanText(value, 40)
  return Object.hasOwn(experienceCatalog, id) ? id : defaultExperienceId
}

function normalizeCreativeDirection(value) {
  const recommendedExperience = normalizeExperienceId(value?.recommendedExperience)
  return {
    recommendedExperience,
    artDirection: englishSafeText(value?.artDirection, experienceCatalog[recommendedExperience].name, 140),
    tone: englishSafeText(value?.tone, 'Premium, product-led, and concise.', 140),
  }
}

function experienceUsesThree(experienceId) {
  return experienceId === 'botanical-cinema' || experienceId === 'object-gallery'
}

function experienceUsesGsap(experienceId) {
  return experienceId === 'botanical-cinema' || experienceId === 'tactile-commerce'
}

function containsNonLatinLetter(value) {
  return [...String(value || '')].some((character) => (
    /\p{L}/u.test(character) && !/\p{Script=Latin}/u.test(character)
  ))
}

function englishSafeText(value, fallback, max = 120) {
  const cleaned = cleanText(value, max)
  return cleaned && !containsNonLatinLetter(cleaned) ? cleaned : fallback
}

function conciseProductName(value, fallback = 'Product') {
  const product = englishSafeText(value, fallback, 100)
  const candidates = product
    .split(/\s*\/\s*|\s+or\s+|\s*\([^)]*\)\s*/i)
    .map((candidate) => candidate.trim())
    .filter(Boolean)
  const words = (candidates.at(-1) || product).split(/\s+/).filter(Boolean)
  return words.slice(Math.max(0, words.length - 3)).join(' ')
}

function conciseHeroCopy(value, fallback, maxWords) {
  const text = englishSafeText(value, fallback, 320)
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length <= maxWords) return text
  return `${words.slice(0, maxWords).join(' ').replace(/[,:;.!?]+$/, '')}...`
}

function escapeHtml(value, max = 1200) {
  return cleanText(value, max)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function sanitizeLaunchInput(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const productImage = input.productImage && typeof input.productImage === 'object'
    ? {
        name: cleanText(input.productImage.name, 120),
        type: cleanText(input.productImage.type, 80),
        size: Number.isFinite(Number(input.productImage.size)) ? Number(input.productImage.size) : 0,
        url: cleanHttpsUrl(input.productImage.url),
        dataUrl: cleanProductImageDataUrl(input.productImage.dataUrl),
      }
    : null

  return {
    brief: cleanText(input.brief, 1800),
    channel: cleanText(input.channel, 80) || 'DTC',
    market: cleanText(input.market, 120) || 'Southeast Asia',
    productImage,
    sourceImages: normalizeSourceViews(input.sourceImages),
    capture: normalizeSourceCapture(input.capture),
  }
}

function cleanProductImageDataUrl(value) {
  if (typeof value !== 'string') return ''
  const match = value.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/)
  if (!match) return ''
  const buffer = Buffer.from(match[2], 'base64')
  if (!buffer.length || buffer.length > maxUploadBytes) return ''
  return value
}

function hasProductImage(input) {
  return Boolean(input.productImage?.dataUrl || input.productImage?.url)
}

function publicProductImageMeta(productImage) {
  if (!productImage) return null
  const { dataUrl: _dataUrl, ...metadata } = productImage
  return metadata
}

function clampNumber(value, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return min
  return Math.min(max, Math.max(min, parsed))
}

function normalizeProductDetections(value, fallbackLabel = 'Product') {
  return normalizeProductDetectionRecords(value, fallbackLabel, maxProductAssets).map((item, index) => ({
    ...item,
    label: englishSafeText(item.label, `${fallbackLabel} ${index + 1}`, 80),
    confidence: englishSafeText(item.confidence, 'review', 40),
  }))
}

function dominantEdgeColors(data, width, height, channels) {
  const bins = new Map()
  const sample = (x, y) => {
    const offset = (y * width + x) * channels
    const r = data[offset]
    const g = data[offset + 1]
    const b = data[offset + 2]
    const key = `${r >> 5}:${g >> 5}:${b >> 5}`
    const bin = bins.get(key) || { count: 0, r: 0, g: 0, b: 0 }
    bin.count += 1
    bin.r += r
    bin.g += g
    bin.b += b
    bins.set(key, bin)
  }
  const step = Math.max(1, Math.floor(Math.min(width, height) / 100))
  const edgeDepth = Math.min(3, Math.floor(Math.min(width, height) / 8))
  for (let depth = 0; depth < edgeDepth; depth += 1) {
    for (let x = 0; x < width; x += step) {
      sample(x, depth)
      sample(x, height - 1 - depth)
    }
    for (let y = 0; y < height; y += step) {
      sample(depth, y)
      sample(width - 1 - depth, y)
    }
  }
  return [...bins.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map((bin) => ({
      r: bin.r / bin.count,
      g: bin.g / bin.count,
      b: bin.b / bin.count,
    }))
}

function colorDistanceSquared(data, offset, color) {
  const red = data[offset] - color.r
  const green = data[offset + 1] - color.g
  const blue = data[offset + 2] - color.b
  return red * red + green * green + blue * blue
}

function isolateLargestForeground(background, width, height) {
  const pixelCount = width * height
  const visited = new Uint8Array(pixelCount)
  const queue = new Int32Array(pixelCount)
  let foregroundPixels = 0
  let componentCount = 0
  let largest = []

  for (let start = 0; start < pixelCount; start += 1) {
    if (background[start] || visited[start]) continue
    componentCount += 1
    let queueStart = 0
    let queueEnd = 0
    const component = []
    visited[start] = 1
    queue[queueEnd] = start
    queueEnd += 1
    while (queueStart < queueEnd) {
      const index = queue[queueStart]
      queueStart += 1
      component.push(index)
      const x = index % width
      const y = Math.floor(index / width)
      const visit = (neighbor) => {
        if (background[neighbor] || visited[neighbor]) return
        visited[neighbor] = 1
        queue[queueEnd] = neighbor
        queueEnd += 1
      }
      if (x > 0) visit(index - 1)
      if (x + 1 < width) visit(index + 1)
      if (y > 0) visit(index - width)
      if (y + 1 < height) visit(index + width)
    }
    foregroundPixels += component.length
    if (component.length > largest.length) largest = component
  }

  const mask = new Uint8Array(pixelCount)
  for (const index of largest) mask[index] = 1
  return {
    mask,
    componentCount,
    largestShare: foregroundPixels ? largest.length / foregroundPixels : 0,
  }
}

function closeForegroundMask(mask, width, height) {
  const pixelCount = width * height
  const dilated = new Uint8Array(pixelCount)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      let found = false
      for (let dy = -1; dy <= 1 && !found; dy += 1) {
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx
          if (nx >= 0 && nx < width && mask[ny * width + nx]) {
            found = true
            break
          }
        }
      }
      if (found) dilated[index] = 1
    }
  }

  const closed = new Uint8Array(pixelCount)
  for (let y = 1; y + 1 < height; y += 1) {
    for (let x = 1; x + 1 < width; x += 1) {
      let solid = true
      for (let dy = -1; dy <= 1 && solid; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dilated[(y + dy) * width + x + dx]) {
            solid = false
            break
          }
        }
      }
      if (solid) closed[y * width + x] = 1
    }
  }

  const maxGap = Math.max(2, Math.round(Math.min(width, height) * 0.025))
  for (let y = 0; y < height; y += 1) {
    let previous = -1
    for (let x = 0; x < width; x += 1) {
      if (!closed[y * width + x]) continue
      const gap = x - previous - 1
      if (previous >= 0 && gap > 0 && gap <= maxGap) {
        for (let fill = previous + 1; fill < x; fill += 1) closed[y * width + fill] = 1
      }
      previous = x
    }
  }
  for (let x = 0; x < width; x += 1) {
    let previous = -1
    for (let y = 0; y < height; y += 1) {
      if (!closed[y * width + x]) continue
      const gap = y - previous - 1
      if (previous >= 0 && gap > 0 && gap <= maxGap) {
        for (let fill = previous + 1; fill < y; fill += 1) closed[fill * width + x] = 1
      }
      previous = y
    }
  }
  return closed
}

function erodeForegroundEdge(mask, width, height) {
  const eroded = new Uint8Array(mask.length)
  for (let y = 1; y + 1 < height; y += 1) {
    for (let x = 1; x + 1 < width; x += 1) {
      let solid = true
      for (let dy = -1; dy <= 1 && solid; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!mask[(y + dy) * width + x + dx]) {
            solid = false
            break
          }
        }
      }
      if (solid) eroded[y * width + x] = 1
    }
  }
  return eroded
}

async function isolateProductPixels(data, width, height, channels) {
  const colors = dominantEdgeColors(data, width, height, channels)
  const pixelCount = width * height
  const background = new Uint8Array(pixelCount)
  const queue = new Int32Array(pixelCount)
  let queueStart = 0
  let queueEnd = 0
  const thresholdSquared = 54 * 54
  const isBackgroundColor = (index) => {
    const offset = index * channels
    return colors.some((color) => colorDistanceSquared(data, offset, color) <= thresholdSquared)
  }
  const enqueue = (index) => {
    if (background[index] || !isBackgroundColor(index)) return
    background[index] = 1
    queue[queueEnd] = index
    queueEnd += 1
  }

  for (let x = 0; x < width; x += 1) {
    enqueue(x)
    enqueue((height - 1) * width + x)
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(y * width)
    enqueue(y * width + width - 1)
  }

  while (queueStart < queueEnd) {
    const index = queue[queueStart]
    queueStart += 1
    const x = index % width
    const y = Math.floor(index / width)
    if (x > 0) enqueue(index - 1)
    if (x + 1 < width) enqueue(index + 1)
    if (y > 0) enqueue(index - width)
    if (y + 1 < height) enqueue(index + width)
  }

  const initialRemovedRatio = queueEnd / pixelCount
  let backgroundRemoved = initialRemovedRatio >= 0.06 && initialRemovedRatio <= 0.97
  let componentCount = 0
  let largestShare = 0
  let foregroundMask = null
  if (backgroundRemoved) {
    const foreground = isolateLargestForeground(background, width, height)
    componentCount = foreground.componentCount
    largestShare = foreground.largestShare
    foregroundMask = erodeForegroundEdge(closeForegroundMask(foreground.mask, width, height), width, height)
    const foregroundPixels = foregroundMask.reduce((total, value) => total + value, 0)
    const refinedCoverage = foregroundPixels / pixelCount
    backgroundRemoved = refinedCoverage >= 0.01 && refinedCoverage <= 0.94
  }
  const alpha = Buffer.alloc(pixelCount, 255)
  if (backgroundRemoved && foregroundMask) {
    for (let index = 0; index < pixelCount; index += 1) {
      if (!foregroundMask[index]) alpha[index] = 0
    }
  }
  let feathered = alpha
  if (backgroundRemoved) {
    const blurred = await sharp(alpha, { raw: { width, height, channels: 1 } })
      .blur(0.8)
      .raw()
      .toBuffer({ resolveWithObject: true })
    feathered = Buffer.alloc(pixelCount)
    for (let index = 0; index < pixelCount; index += 1) {
      feathered[index] = blurred.data[index * blurred.info.channels]
    }
  }
  const rgba = Buffer.alloc(pixelCount * 4)
  const backgroundColor = colors[0] || { r: 255, g: 255, b: 255 }
  for (let index = 0; index < pixelCount; index += 1) {
    const sourceOffset = index * channels
    const outputOffset = index * 4
    const alphaValue = feathered[index] < 10 ? 0 : feathered[index]
    const alphaRatio = Math.max(alphaValue / 255, 0.08)
    for (let channel = 0; channel < 3; channel += 1) {
      const sourceValue = data[sourceOffset + channel]
      const backgroundValue = [backgroundColor.r, backgroundColor.g, backgroundColor.b][channel]
      const recovered = (sourceValue - backgroundValue * (1 - alphaRatio)) / alphaRatio
      const corrected = alphaValue > 0 && alphaValue < 246
        ? sourceValue * 0.35 + recovered * 0.65
        : sourceValue
      rgba[outputOffset + channel] = Math.round(clampNumber(corrected, 0, 255))
    }
    rgba[outputOffset + 3] = alphaValue
  }
  const foregroundCoverage = backgroundRemoved && foregroundMask
    ? Math.round((foregroundMask.reduce((total, value) => total + value, 0) / pixelCount) * 100)
    : Math.round((1 - initialRemovedRatio) * 100)
  const matteQuality = backgroundRemoved
    ? Math.round(clampNumber(60 + largestShare * 30 + (foregroundCoverage >= 5 && foregroundCoverage <= 88 ? 10 : 0), 0, 100))
    : 0
  return {
    rgba,
    backgroundRemoved,
    foregroundCoverage,
    componentCount,
    matteQuality,
    edgeDecontaminated: backgroundRemoved,
  }
}

function isLowContrastPackageDetection(detection) {
  const label = cleanText(detection?.label, 100)
  const bbox = normalizeBoundingBox(detection?.bbox)
  const aspect = bbox.width / Math.max(1, bbox.height)
  return /\b(?:bar|book|box|carton|case|device|pack|package|packet|phone|pouch|sachet|soap|tablet|wrapper)\b/i.test(label)
    && aspect >= 0.42
    && aspect <= 3.2
}

async function createPackageBoundsMatte(data, width, height, channels) {
  const inset = Math.max(2, Math.round(Math.min(width, height) * 0.035))
  const alpha = Buffer.alloc(width * height)
  for (let y = inset; y < height - inset; y += 1) {
    alpha.fill(255, y * width + inset, y * width + width - inset)
  }
  const blurred = await sharp(alpha, { raw: { width, height, channels: 1 } })
    .blur(0.7)
    .raw()
    .toBuffer({ resolveWithObject: true })
  const rgba = Buffer.alloc(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    const sourceOffset = index * channels
    const outputOffset = index * 4
    rgba[outputOffset] = data[sourceOffset]
    rgba[outputOffset + 1] = data[sourceOffset + 1]
    rgba[outputOffset + 2] = data[sourceOffset + 2]
    rgba[outputOffset + 3] = blurred.data[index * blurred.info.channels]
  }
  const innerWidth = Math.max(0, width - inset * 2)
  const innerHeight = Math.max(0, height - inset * 2)
  return {
    rgba,
    backgroundRemoved: true,
    foregroundCoverage: Math.round((innerWidth * innerHeight / Math.max(1, width * height)) * 100),
    componentCount: 1,
    matteQuality: 84,
    edgeDecontaminated: true,
    packageBoundsFallback: true,
  }
}

function fallbackSubjectBoundingBox(width, height) {
  const aspect = width / Math.max(height, 1)
  if (aspect >= 1.25) return { x: 300, y: 50, width: 250, height: 700 }
  if (aspect <= 0.8) return { x: 80, y: 40, width: 840, height: 920 }
  return { x: 100, y: 30, width: 800, height: 940 }
}

async function extractProductAssets(input, kit, assetOrigin = '') {
  const dataUrl = input.productImage?.dataUrl || ''
  if (!dataUrl) return []
  const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const source = Buffer.from(encoded, 'base64')
  if (!source.length) return []

  const normalized = await sharp(source, { failOn: 'none' })
    .rotate()
    .toBuffer({ resolveWithObject: true })
  const sourceWidth = normalized.info.width
  const sourceHeight = normalized.info.height
  if (!sourceWidth || !sourceHeight) return []

  const fallbackLabel = kit.productAnalysis?.productType || 'Product'
  const detections = normalizeProductDetections(kit.productDetections, fallbackLabel)
  const selected = dedupeProductDetections(detections, maxProductAssets)
    .map((detection) => /^fallback/i.test(detection.confidence)
      ? { ...detection, bbox: fallbackSubjectBoundingBox(sourceWidth, sourceHeight) }
      : detection)

  if (!selected.length) return []

  const candidates = await Promise.all(selected.map(async (detection, index) => {
    const rawLeft = Math.round((detection.bbox.x / 1000) * sourceWidth)
    const rawTop = Math.round((detection.bbox.y / 1000) * sourceHeight)
    const rawWidth = Math.max(1, Math.round((detection.bbox.width / 1000) * sourceWidth))
    const rawHeight = Math.max(1, Math.round((detection.bbox.height / 1000) * sourceHeight))
    const padding = Math.max(4, Math.round(Math.min(rawWidth, rawHeight) * 0.06))
    const left = Math.max(0, rawLeft - padding)
    const top = Math.max(0, rawTop - padding)
    const width = Math.max(1, Math.min(sourceWidth - left, rawWidth + padding * 2))
    const height = Math.max(1, Math.min(sourceHeight - top, rawHeight + padding * 2))
    const isolatedInput = await sharp(normalized.data)
      .extract({ left, top, width, height })
      .rotate(detection.rotationDegrees || 0, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .resize(620, 620, { fit: 'inside', withoutEnlargement: false })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    let isolated = await isolateProductPixels(
      isolatedInput.data,
      isolatedInput.info.width,
      isolatedInput.info.height,
      isolatedInput.info.channels,
    )
    const edgeMatteUsable = isolated.backgroundRemoved
      && isolated.matteQuality >= 80
      && isolated.edgeDecontaminated
      && isolated.componentCount >= 1
      && isolated.foregroundCoverage >= 8
      && isolated.foregroundCoverage <= 92
    if (!edgeMatteUsable && isLowContrastPackageDetection(detection)) {
      isolated = await createPackageBoundsMatte(
        isolatedInput.data,
        isolatedInput.info.width,
        isolatedInput.info.height,
        isolatedInput.info.channels,
      )
    }
    const matteAccepted = isolated.backgroundRemoved
      && isolated.matteQuality >= 80
      && isolated.edgeDecontaminated
      && isolated.componentCount >= 1
      && isolated.foregroundCoverage >= 8
      && isolated.foregroundCoverage <= 92
    const outputInput = matteAccepted ? isolated.rgba : isolatedInput.data
    const outputChannels = matteAccepted ? 4 : isolatedInput.info.channels
    let outputPipeline = sharp(outputInput, {
      raw: {
        width: isolatedInput.info.width,
        height: isolatedInput.info.height,
        channels: outputChannels,
      },
    })
    if (matteAccepted) {
      outputPipeline = outputPipeline.trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 4 })
    }
    const output = await outputPipeline
      .resize(720, 720, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 90, alphaQuality: 100, smartSubsample: true })
      .toBuffer()
    let assetUrl = ''
    if (assetOrigin) {
      const storedFileName = `${randomUUID()}.webp`
      await mkdir(uploadDir, { recursive: true })
      await writeFile(path.join(uploadDir, storedFileName), output)
      assetUrl = `${assetOrigin.replace(/\/$/, '')}/uploads/${storedFileName}`
    }
    return {
      id: `product-${index + 1}`,
      label: detection.label,
      confidence: detection.confidence,
      mimeType: 'image/webp',
      fileName: `product-${index + 1}.webp`,
      width: 720,
      height: 720,
      sourceBbox: detection.bbox,
      rotationDegrees: detection.rotationDegrees || 0,
      backgroundRemoved: matteAccepted,
      cropFallback: !matteAccepted,
      foregroundCoverage: isolated.foregroundCoverage,
      componentCount: isolated.componentCount,
      matteQuality: matteAccepted ? isolated.matteQuality : 0,
      edgeDecontaminated: matteAccepted,
      isolationMethod: matteAccepted
        ? isolated.packageBoundsFallback ? 'ai-package-bounds-matte' : 'ai-guided-edge-matte'
        : 'ai-bounding-box-crop',
      ...(assetUrl ? { url: assetUrl } : {}),
      dataUrl: `data:image/webp;base64,${output.toString('base64')}`,
    }
  }))

  const usableAssets = selectProductAssets(candidates, maxProductAssets)

  return usableAssets.map((asset, index) => ({
    ...asset,
    id: `product-${index + 1}`,
    fileName: `product-${index + 1}.webp`,
  }))
}

function cleanHttpsUrl(value) {
  if (typeof value !== 'string') return ''
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    return url.toString().slice(0, 1000)
  } catch {
    return ''
  }
}

function inferProductName(brief, imageName = '') {
  const compact = cleanText(brief, 220)
  if (!compact || containsNonLatinLetter(compact)) {
    const fromImage = cleanText(imageName, 120)
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\b(img|image|photo|picture|dsc|demo|sample)\b/gi, '')
      .replace(/^(?:demo|sample)(?=[a-z])/i, '')
      .replace(/\s+/g, ' ')
      .trim()
    return fromImage && /[A-Za-z]/.test(fromImage) && !containsNonLatinLetter(fromImage)
      ? fromImage.replace(/\b[a-z]/g, (character) => character.toUpperCase())
      : 'Photo-identified product'
  }
  const firstSentence = compact.split(/[.!?]/)[0]?.trim() || compact
  const words = firstSentence
    .replace(/^(a|an|the)\s+/i, '')
    .split(/\s+/)
  const audienceIndex = words.findIndex((word, index) => index >= 2 && word.toLowerCase() === 'for')
  return words.slice(0, audienceIndex > 2 ? audienceIndex : 6).join(' ')
}

function fallbackLaunchKit(input) {
  const product = inferProductName(input.brief, input.productImage?.name)
  const channel = englishSafeText(input.channel, 'the selected sales channel', 80)
  const market = englishSafeText(input.market, 'the selected market', 120)
  const imageCue = input.productImage?.name
    ? `Use ${input.productImage.name} as the primary product reference.`
    : 'Reserve the hero media slot for a clean product image.'

  return {
    productAnalysis: {
      summary: input.brief && !containsNonLatinLetter(input.brief)
        ? input.brief
        : `${product} shown in the supplied product context. Add verified specifications before publishing.`,
      productType: product,
      visibleDetails: input.productImage?.name ? ['Product image attached for visual review.'] : ['No product image was provided.'],
      confidence: hasProductImage(input) ? 'Image attached; AI vision was unavailable for this fallback.' : 'Based on seller notes only.',
      needsReview: ['Verify brand, ingredients, dimensions, price, and regulated claims before publishing.'],
    },
    productDetections: hasProductImage(input)
      ? [{ label: product, bbox: { x: 300, y: 50, width: 250, height: 700 }, confidence: 'fallback center-subject estimate' }]
      : [],
    creativeDirection: {
      recommendedExperience: defaultExperienceId,
      artDirection: 'Editorial product study with restrained motion and strong object focus.',
      tone: 'Premium, tactile, and product-led.',
    },
    brandAngle: {
      positioning: `A closer, more considered way to experience ${product}.`,
      customer: `People comparing products across ${market}.`,
      promise: 'A clear visual story grounded in the product details buyers can actually see.',
    },
    hero: {
      headline: `${product}, ready to stand apart`,
      subheading: `A focused product story for buyers across ${market}, shaped for discovery on ${channel}.`,
      primaryCta: 'Discover the product',
      secondaryCta: 'See the story',
    },
    storefrontLayout: [
      {
        section: 'Hero',
        purpose: 'Make the product and its visual character clear in the first viewport.',
        copy: `${product} takes center stage with a concise promise and one clear next step.`,
        editableSlots: ['headline', 'subheading', 'primary image', 'cta'],
      },
      {
        section: 'Product story',
        purpose: 'Turn visible product details into a reason to look closer.',
        copy: `Explore the product form, packaging, and visual signals that matter before choosing it.`,
        editableSlots: ['section title', 'story copy', 'supporting image'],
      },
      {
        section: 'Conversion proof',
        purpose: 'Give shoppers clear evidence without invented claims.',
        copy: 'Present visible details now and reserve specifications, ingredients, and guarantees for verified information.',
        editableSlots: ['proof points', 'icons', 'trust copy'],
      },
      {
        section: 'Campaign CTA',
        purpose: 'End the product story with one confident next step.',
        copy: 'Invite the visitor to explore verified details or continue to the product offer.',
        editableSlots: ['offer text', 'cta', 'footer note'],
      },
    ],
    mediaPlan: [
      {
        slot: 'hero-product',
        direction: imageCue,
        assetKind: 'image',
      },
      {
        slot: 'story-lifestyle',
        direction: `Show the product in a relevant ${market} setting without generic stock styling.`,
        assetKind: 'image',
      },
      {
        slot: 'motion-accent',
        direction: 'Use subtle reveal motion and product-scale parallax, not a heavy template animation.',
        assetKind: 'motion',
      },
    ],
    seo: {
      title: `${product} | Product story`,
      description: `Discover ${product} through a visual product story created for ${channel} shoppers across ${market}.`,
      keywords: [product, channel, market, 'product details', 'product story'],
    },
    socialCaptions: [
      {
        channel,
        caption: `See ${product} up close through a focused visual story and product details.`,
      },
      {
        channel: 'Instagram',
        caption: `${product}, framed around the details that make the object worth a closer look.`,
      },
      {
        channel: 'Campaign',
        caption: `Explore the visible form, packaging, and product story behind ${product}.`,
      },
    ],
    dashboardReview: [
      'Check that the hero image matches the real product.',
      'Verify shipping, price, claims, and guarantee before publishing.',
      'Adjust tone for the seller audience and local language.',
      'Preview mobile before going live.',
    ],
  }
}

function buildAgentPrompt(input) {
  const sourceCount = Math.max(1, input.sourceImages?.length || (input.productImage ? 1 : 0))
  return [
    'You are Rukter.ai Launch Agent, an ecommerce launch strategist and product-image analyst.',
    'Create a complete, practical launch kit for an independent seller.',
    'Return only valid JSON with this exact top-level schema:',
    '{"productAnalysis":{"summary":"string","productType":"string","visibleDetails":["string"],"confidence":"string","needsReview":["string"]},"productDetections":[{"label":"string","bbox":{"x":0,"y":0,"width":1000,"height":1000},"confidence":"string","rotationDegrees":0}],"creativeDirection":{"recommendedExperience":"editorial-monograph|botanical-cinema|object-gallery|tactile-commerce","artDirection":"string","tone":"string"},"brandAngle":{"positioning":"string","customer":"string","promise":"string"},"hero":{"headline":"string","subheading":"string","primaryCta":"string","secondaryCta":"string"},"storefrontLayout":[{"section":"string","purpose":"string","copy":"string","editableSlots":["string"]}],"mediaPlan":[{"slot":"string","direction":"string","assetKind":"string"}],"seo":{"title":"string","description":"string","keywords":["string"]},"socialCaptions":[{"channel":"string","caption":"string"}],"dashboardReview":["string"]}',
    'The output must be specific to the input and must be safe for an unpublished editable draft.',
    `You received ${sourceCount} source view${sourceCount === 1 ? '' : 's'} of the same product. Compare all views before describing the product, and separate directly visible evidence from uncertain details.`,
    'When product images are attached, analyze the pixels as the primary product source. Identify the product category, visible packaging text, colors, materials, form, and apparent use across the complete set of views.',
    `When an image is attached, productDetections is required and must contain between 1 and ${maxProductAssets} boxes for the most visually prominent distinct sellable products in the FIRST source view. Bounding boxes use integer coordinates from 0 to 1000 relative to that complete first image. Keep each box tight around one complete product package and avoid price labels, shelves, faces, printed text fragments, and duplicate boxes.`,
    'For every productDetection, set rotationDegrees to 0, 90, 180, or 270 so printed packaging text reads naturally after clockwise rotation. Use 180 for an upside-down package and keep 0 when it is already upright.',
    'If the upload is a phone screenshot or contains browser/app UI around an embedded product photo, treat all UI chrome as context, not as a product. Locate products inside the embedded photo but keep every bounding-box coordinate relative to the complete uploaded screenshot.',
    'Never detect yellow shelf-price labels, barcodes, store signs, UI cards, preview frames, or captions as products. A valid detection must include the complete physical package or object, not only its logo or printed label.',
    'Do not return ingredients, flowers, leaves, food props, display stands, or scenery as productDetections unless each item is itself a distinct packaged SKU for sale.',
    'Choose creativeDirection.recommendedExperience from editorial-monograph, botanical-cinema, object-gallery, or tactile-commerce based on product form, visual texture, audience, and the supplied image. Describe one specific art direction and tone without mentioning templates.',
    'For text-only requests, return productDetections as an empty array.',
    'Do not invent ingredients, dimensions, certifications, price, performance, origin, or medical claims that are not visible or supplied by the seller.',
    'Never fabricate social proof, ratings, sales, cart counts, views, popularity, scarcity, awards, health claims, or certifications. Do not create a Social Proof section unless the seller supplied verifiable proof.',
    'If a detail is only inferred from the image, describe it as apparent or suggested in productAnalysis and omit it from assertive customer-facing claims.',
    'Use productAnalysis.needsReview for details the seller must verify. Keep productAnalysis.summary useful as an editable product description.',
    'Write every human-readable string in English, even when the seller input is in another language. Translate the meaning and use Latin transliteration for names when needed.',
    'Do not reproduce non-Latin packaging text. Translate or transliterate visible names into English Latin characters.',
    'Return exactly 4 storefrontLayout items, 3 mediaPlan items, 3 socialCaptions items, and 4 dashboardReview strings.',
    'Keep every string concise. Do not use newline characters inside string values.',
    'Write the hero as premium buyer-facing storefront copy, not as a description of this tool or workflow.',
    'Write brandAngle, hero, storefrontLayout, SEO, and socialCaptions as customer-facing product storytelling. Do not mention sellers, drafts, dashboards, paid traffic, templates, AI generation, launch kits, or the page-building workflow in those fields.',
    'Keep hero.headline between 3 and 9 words and hero.subheading under 24 words.',
    'Do not mention AI, drafts, dashboards, templates, sellers, launch kits, or human review in hero copy.',
    'Do not say that the page is already published. Do not include markdown. End immediately after the final JSON object.',
    '',
    `Optional seller notes: ${input.brief || 'None. Analyze the product image without requiring seller notes.'}`,
    `Target channel: ${input.channel}`,
    `Target market: ${input.market}`,
    `Primary product image metadata: ${input.productImage ? JSON.stringify(publicProductImageMeta(input.productImage)) : 'none'}`,
    `Source view labels: ${input.sourceImages?.length ? input.sourceImages.map((image, index) => `${index + 1}. ${image.label || image.name || 'Product view'}`).join(' | ') : 'none'}`,
  ].join('\n')
}

function extractJsonObject(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) throw new Error('Empty model response.')
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) throw new Error('Model response did not contain JSON.')
    return JSON.parse(trimmed.slice(start, end + 1))
  }
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function hasItems(value) {
  return Array.isArray(value) && value.length > 0
}

function assertLaunchKitSchema(kit) {
  const missing = []
  if (!kit || typeof kit !== 'object' || Array.isArray(kit)) {
    throw new Error('Model response was not a launch kit object.')
  }

  if (!hasText(kit.productAnalysis?.summary)) missing.push('productAnalysis.summary')
  if (!hasText(kit.productAnalysis?.productType)) missing.push('productAnalysis.productType')
  if (!hasItems(kit.productAnalysis?.visibleDetails)) missing.push('productAnalysis.visibleDetails')
  if (!hasText(kit.productAnalysis?.confidence)) missing.push('productAnalysis.confidence')
  if (!hasItems(kit.productAnalysis?.needsReview)) missing.push('productAnalysis.needsReview')
  if (!hasText(kit.creativeDirection?.recommendedExperience)) missing.push('creativeDirection.recommendedExperience')
  if (!hasText(kit.creativeDirection?.artDirection)) missing.push('creativeDirection.artDirection')
  if (!hasText(kit.creativeDirection?.tone)) missing.push('creativeDirection.tone')
  if (!hasText(kit.brandAngle?.positioning)) missing.push('brandAngle.positioning')
  if (!hasText(kit.brandAngle?.customer)) missing.push('brandAngle.customer')
  if (!hasText(kit.brandAngle?.promise)) missing.push('brandAngle.promise')
  if (!hasText(kit.hero?.headline)) missing.push('hero.headline')
  if (!hasText(kit.hero?.subheading)) missing.push('hero.subheading')
  if (!hasText(kit.hero?.primaryCta)) missing.push('hero.primaryCta')
  if (!hasText(kit.hero?.secondaryCta)) missing.push('hero.secondaryCta')
  if (!hasItems(kit.storefrontLayout)) missing.push('storefrontLayout')
  if (!hasItems(kit.mediaPlan)) missing.push('mediaPlan')
  if (!hasText(kit.seo?.title)) missing.push('seo.title')
  if (!hasText(kit.seo?.description)) missing.push('seo.description')
  if (!hasItems(kit.socialCaptions)) missing.push('socialCaptions')
  if (!hasItems(kit.dashboardReview)) missing.push('dashboardReview')

  if (missing.length) {
    throw new Error(`Model response missing required launch kit fields: ${missing.slice(0, 8).join(', ')}`)
  }

  return kit
}

function assertEnglishLaunchKit(kit) {
  const pending = [kit]
  while (pending.length) {
    const value = pending.pop()
    if (typeof value === 'string' && containsNonLatinLetter(value)) {
      throw new Error('Model response contained non-English script.')
    }
    if (Array.isArray(value)) pending.push(...value)
    else if (value && typeof value === 'object') pending.push(...Object.values(value))
  }
  return kit
}

function sanitizeEnglishLaunchKit(value) {
  if (typeof value === 'string') {
    const cleaned = [...value]
      .map((character) => (/\p{L}/u.test(character) && !/\p{Script=Latin}/u.test(character) ? ' ' : character))
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
    return /[A-Za-z]/.test(cleaned) ? cleaned : 'Non-English product text requires seller verification.'
  }
  if (Array.isArray(value)) return value.map(sanitizeEnglishLaunchKit)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeEnglishLaunchKit(item)]))
  }
  return value
}

const unsupportedClaimPattern = /\b(?:already\s+in|award[- ]winning|best[- ]sell(?:er|ing)|clinically\s+(?:proven|tested)|customers?\s+love|free\s+from|guaranteed|limited[- ]time|limited\s+stock|mix\s+and\s+match|no\s+guilt|real\s+flavor|sealed\s+fresh|sold\s+out|variety\s+pack|zero\s+\w+)\b|\b(?:affordable|baked|bundles?|carts?|cheap|discounts?|flavors?|freshness|guaranteed|halal|ingredients?|orders?|organic|prices?|ratings?|recyclable|referrals?|reviews?|sales?|save|stars?|sustainable|vegan|views?|viral)\b/i
const proofSectionPattern = /\b(?:customer proof|reviews?|social proof|stock urgency|testimonials?|trust signals?)\b/i

function normalizedNumberTokens(value) {
  return (String(value || '').match(/\b\d[\d,.]*(?:\s*[kmb%])?\b/gi) || [])
    .map((token) => token.toLowerCase().replace(/[\s,]/g, ''))
}

function containsUnsupportedClaim(value, sellerNotes) {
  const text = String(value || '')
  const notes = String(sellerNotes || '')
  const generatedNumbers = normalizedNumberTokens(text)
  const suppliedNumbers = new Set(normalizedNumberTokens(notes))
  if (generatedNumbers.some((token) => !suppliedNumbers.has(token))) return true

  const match = text.match(unsupportedClaimPattern)
  if (!match) return false
  return !notes.toLowerCase().includes(match[0].toLowerCase())
}

function enforceSellerVerifiedClaims(kit, input) {
  let rewrites = 0
  const product = englishSafeText(kit.productAnalysis?.productType, 'Product', 80)
  const channel = englishSafeText(input.channel, 'the selected channel', 80)
  const market = englishSafeText(input.market, 'the selected market', 120)
  const safe = (value, fallback) => {
    if (!containsUnsupportedClaim(value, input.brief)) return value
    rewrites += 1
    return fallback
  }

  kit.brandAngle.positioning = safe(
    kit.brandAngle.positioning,
    `${product} presented with a clear, product-led story for ${market}.`,
  )
  kit.brandAngle.customer = safe(
    kit.brandAngle.customer,
    `Buyers browsing ${channel} in ${market}.`,
  )
  kit.brandAngle.promise = safe(
    kit.brandAngle.promise,
    'A clear product story built from visible details and verified facts.',
  )
  kit.hero.headline = safe(kit.hero.headline, 'Discover the Product')
  kit.hero.subheading = safe(
    kit.hero.subheading,
    'Explore the visible product story, with specifications ready for seller review.',
  )

  kit.storefrontLayout = kit.storefrontLayout.map((section) => {
    const sectionText = [section.section, section.purpose, section.copy, ...(section.editableSlots || [])].join(' ')
    if (proofSectionPattern.test(sectionText) && !input.brief.toLowerCase().includes('verified review')) {
      rewrites += 1
      return {
        section: 'Verified Product Details',
        purpose: 'Give buyers confirmed facts before they decide.',
        copy: 'Explore verified ingredients, pack size, origin, pricing, availability, and product feedback.',
        editableSlots: ['verified specifications', 'verified product feedback', 'availability'],
      }
    }
    return {
      ...section,
      section: safe(section.section, 'Product Story'),
      purpose: safe(section.purpose, 'Help buyers understand the product through verified details.'),
      copy: safe(section.copy, 'Explore the product through clear imagery and verified details.'),
      editableSlots: (section.editableSlots || []).map((slot) => safe(slot, 'verified product detail')),
    }
  })

  kit.seo.title = safe(kit.seo.title, `${product} | Rukter`)
  kit.seo.description = safe(
    kit.seo.description,
    `${kit.productAnalysis.summary} Confirm specifications before purchase.`,
  )
  const safeKeywords = (kit.seo.keywords || [])
    .filter((keyword) => !containsUnsupportedClaim(keyword, input.brief))
  if (safeKeywords.length !== (kit.seo.keywords || []).length) {
    rewrites += (kit.seo.keywords || []).length - safeKeywords.length
  }
  kit.seo.keywords = [...new Set(safeKeywords.length ? safeKeywords : [product])]
  const safeSocialCaptions = [
    `Take a closer look at this ${product.toLowerCase()} and tell us what detail stands out.`,
    `See the packaging, form, and visible details of this ${product.toLowerCase()} up close.`,
    `What would you want to know about this ${product.toLowerCase()} before choosing it?`,
  ]
  kit.socialCaptions = kit.socialCaptions.map((item, index) => ({
    ...item,
    caption: safe(item.caption, safeSocialCaptions[index % safeSocialCaptions.length]),
  }))

  if (hasProductImage(input) && !input.brief.trim()) {
    const category = cleanText(product, 80)
      .split('(')[0]
      .replace(/\b(?:[a-z]+[- ]flavou?red|certified|halal|medical|organic|vegan)\b/gi, '')
      .replace(/\s+/g, ' ')
      .replace(/^[-/,\s]+|[-/,\s]+$/g, '') || 'Product'
    const categoryLower = category.toLowerCase()

    kit.mediaPlan = [
      {
        slot: 'Product hero',
        direction: 'Photograph the exact uploaded product against a clean background without altering its packaging.',
        assetKind: 'Product image',
      },
      {
        slot: 'Packaging detail',
        direction: 'Capture readable front and back panels so the seller can confirm all printed information.',
        assetKind: 'Detail image',
      },
      {
        slot: 'Verified context',
        direction: 'Add a context image only after the seller confirms the product form and intended use.',
        assetKind: 'Context image',
      },
    ]
    kit.seo = {
      title: `${category} - Visual Product Overview`,
      description: `Explore this ${categoryLower} through visible packaging and photo-based analysis. Exact specifications require seller confirmation.`,
      keywords: [categoryLower, 'visual product overview', englishSafeText(input.market, 'target market', 80).toLowerCase()],
    }
    kit.socialCaptions = [
      { channel: input.channel, caption: `A closer look at this ${categoryLower}, based on the uploaded product photo.` },
      { channel: input.channel, caption: `What visible detail stands out in this ${categoryLower} packaging?` },
      { channel: input.channel, caption: `Product photo first, seller-verified facts next. Explore this ${categoryLower} before the full listing goes live.` },
    ]
    rewrites += 3
  }

  kit.hero.headline = conciseHeroCopy(kit.hero.headline, 'See the Product Up Close', 9)
  kit.hero.subheading = conciseHeroCopy(
    kit.hero.subheading,
    `Explore this ${conciseProductName(product).toLowerCase()} through visible, seller-verifiable details.`,
    24,
  )

  return { kit, rewrites }
}

function splitModelList(value) {
  return String(value || '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean)
}

function resolveFireworksModel() {
  return process.env.FIREWORKS_MODEL || process.env.GEMMA_MODEL || defaultFireworksModel
}

function resolveFireworksModels() {
  const fallbacks = process.env.FIREWORKS_MODEL_FALLBACKS
    ? splitModelList(process.env.FIREWORKS_MODEL_FALLBACKS)
    : defaultFireworksFallbackModels
  return [...new Set([resolveFireworksModel(), ...fallbacks])]
}

function resolveFireworksVisionModel() {
  return process.env.FIREWORKS_VISION_MODEL || process.env.GEMMA_VISION_MODEL || defaultFireworksVisionModel
}

function resolveInferenceModels(input) {
  if (!hasProductImage(input)) return resolveFireworksModels()
  const visionModels = process.env.FIREWORKS_VISION_MODEL_FALLBACKS
    ? splitModelList(process.env.FIREWORKS_VISION_MODEL_FALLBACKS)
    : []
  const models = [resolveFireworksVisionModel(), ...visionModels]
  if (input.brief) models.push(...resolveFireworksModels())
  return [...new Set(models)]
}

function positiveNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function fireworksRuntimeConfig() {
  return {
    requestTimeoutMs: positiveNumber(process.env.FIREWORKS_REQUEST_TIMEOUT_MS, defaultFireworksRequestTimeoutMs),
    totalTimeoutMs: positiveNumber(process.env.FIREWORKS_TOTAL_TIMEOUT_MS, defaultFireworksTotalTimeoutMs),
    maxTokens: Math.round(positiveNumber(process.env.FIREWORKS_MAX_TOKENS, defaultFireworksMaxTokens)),
  }
}

function responseFormatFor(input) {
  const responseFormat = structuredClone(launchKitResponseFormat)
  if (hasProductImage(input)) {
    responseFormat.json_schema.schema.properties.productDetections.minItems = 1
  }
  return responseFormat
}

function fireworksVisionContent(input) {
  if (!hasProductImage(input)) return buildAgentPrompt(input)
  const content = []
  const primaryUrl = input.productImage.dataUrl || input.productImage.url
  if (primaryUrl) {
    content.push({ type: 'text', text: `Source view 1: ${input.sourceImages?.[0]?.label || input.productImage.name || 'Primary product view'}` })
    content.push({ type: 'image_url', image_url: { url: primaryUrl } })
  }
  for (const [index, image] of (input.sourceImages || []).slice(1, 8).entries()) {
    if (!image.url) continue
    content.push({ type: 'text', text: `Source view ${index + 2}: ${image.label || image.name || 'Product view'}` })
    content.push({ type: 'image_url', image_url: { url: image.url } })
  }
  content.push({ type: 'text', text: buildAgentPrompt(input) })
  return content
}

async function callFireworksModel({ apiKey, baseUrl, input, model, timeoutMs, maxTokens }) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: maxTokens,
        ...(/kimi-k2p6/i.test(model) ? { reasoning_effort: 'none' } : {}),
        response_format: responseFormatFor(input),
        messages: [
          {
            role: 'system',
            content: 'You produce strict JSON for ecommerce launch workflows. Every response string must be in English. Never output markdown.',
          },
          {
            role: 'user',
            content: fireworksVisionContent(input),
          },
        ],
      }),
    })
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Fireworks request timed out after ${timeoutMs}ms.`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Fireworks request failed: ${response.status} ${detail.slice(0, 300)}`)
  }

  const payload = await response.json()
  const choice = payload?.choices?.[0] || {}
  const finishReason = choice.finish_reason || ''
  if (finishReason === 'length') {
    throw new Error(`Fireworks response was truncated at max_tokens=${maxTokens}.`)
  }
  const content = choice?.message?.content || choice?.text || ''
  if (!content) {
    throw new Error(`Fireworks response did not include message content${finishReason ? ` (finish_reason=${finishReason})` : ''}.`)
  }
  const kit = sanitizeEnglishLaunchKit(assertLaunchKitSchema(extractJsonObject(content)))
  return assertEnglishLaunchKit(kit)
}

async function callFireworksInference(input) {
  const apiKey = process.env.FIREWORKS_API_KEY
  if (!apiKey) return null

  const baseUrl = (process.env.FIREWORKS_BASE_URL || 'https://api.fireworks.ai/inference/v1').replace(/\/$/, '')
  const models = resolveInferenceModels(input)
  const errors = []
  const attempts = []
  const startedAt = Date.now()
  const runtimeConfig = fireworksRuntimeConfig()
  const { requestTimeoutMs, totalTimeoutMs, maxTokens } = runtimeConfig
  const deadline = Date.now() + totalTimeoutMs

  for (const model of models) {
    const remainingMs = deadline - Date.now()
    if (remainingMs < 2_500) {
      errors.push(`${model}: skipped because Fireworks total timeout budget was exhausted.`)
      attempts.push({ model, status: 'skipped_timeout_budget', durationMs: 0 })
      break
    }
    try {
      const attemptStartedAt = Date.now()
      const kit = await callFireworksModel({
        apiKey,
        baseUrl,
        input,
        model,
        timeoutMs: Math.min(requestTimeoutMs, remainingMs),
        maxTokens,
      })
      attempts.push({ model, status: 'ok', durationMs: Date.now() - attemptStartedAt })
      return {
        kit,
        model,
        meta: {
          status: 'ok',
          durationMs: Date.now() - startedAt,
          attempts,
          requestTimeoutMs,
          totalTimeoutMs,
          maxTokens,
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`${model}: ${message}`)
      attempts.push({ model, status: 'error', message: message.slice(0, 220) })
    }
  }

  const error = new Error(`Fireworks inference failed for ${models.length} model(s): ${errors.join(' | ').slice(0, 700)}`)
  error.fireworksMeta = {
    status: 'fallback',
    durationMs: Date.now() - startedAt,
    attempts,
    requestTimeoutMs,
    totalTimeoutMs,
    maxTokens,
  }
  throw error
}

function cleanDesignScreenshot(value) {
  if (typeof value !== 'string') return ''
  const match = value.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/)
  if (!match) return ''
  const buffer = Buffer.from(match[1], 'base64')
  if (!buffer.length || buffer.length > 1_500_000) return ''
  return value
}

function normalizeCriticRepairs(value) {
  const allowed = new Set(criticRepairTokens)
  return [...new Set(normalizeList(value).map((item) => cleanText(item, 40)).filter((item) => allowed.has(item)))].slice(0, 4)
}

async function callFireworksDesignCritic(screenshot, experienceId, iteration = 0) {
  const apiKey = process.env.FIREWORKS_API_KEY
  if (!apiKey) throw new Error('Fireworks is not configured for visual critique.')
  const baseUrl = (process.env.FIREWORKS_BASE_URL || 'https://api.fireworks.ai/inference/v1').replace(/\/$/, '')
  const model = resolveFireworksVisionModel()
  const controller = new AbortController()
  const timeoutMs = Math.min(12_000, fireworksRuntimeConfig().requestTimeoutMs)
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()
  let response
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 420,
        ...(/kimi-k2p6/i.test(model) ? { reasoning_effort: 'none' } : {}),
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'RukterVisualCritique',
            schema: {
              type: 'object',
              required: ['score', 'strengths', 'issues', 'verdict', 'repairs'],
              properties: {
                score: { type: 'integer', minimum: 0, maximum: 100 },
                strengths: { type: 'array', items: { type: 'string' }, maxItems: 3 },
                issues: { type: 'array', items: { type: 'string' }, maxItems: 3 },
                verdict: { type: 'string' },
                repairs: {
                  type: 'array',
                  maxItems: 4,
                  items: { type: 'string', enum: criticRepairTokens },
                },
              },
            },
          },
        },
        messages: [
          {
            role: 'system',
            content: 'You are a strict senior web design reviewer. Return JSON only. Judge the screenshot, not the product category or unverified product claims.',
          },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: screenshot } },
              {
                type: 'text',
                text: `Review this ${iteration > 0 ? 'automatically refined' : 'initial'} first viewport for the ${experienceCatalog[experienceId].name} direction. Score typography, composition, product prominence, contrast, readability, visual hierarchy, and overlap. Use this fixed rubric: 90-100 exceptional award-ready work; 82-89 polished agency-ready work; 72-81 solid work with visible refinements remaining; 60-71 usable but generic or imbalanced; below 60 materially broken. Use the full range and do not cluster around a threshold. Choose repairs only from the allowed enum and only when each repair directly addresses a visible issue. Keep strengths, issues, and verdict concise and actionable.`,
              },
            ],
          },
        ],
      }),
    })
  } finally {
    clearTimeout(timeout)
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Fireworks design critique failed: ${response.status} ${detail.slice(0, 220)}`)
  }
  const payload = await response.json()
  const critique = extractJsonObject(payload?.choices?.[0]?.message?.content || '')
  const score = Math.round(clampNumber(critique.score, 0, 100))
  return {
    score,
    status: score >= 82 ? 'passed' : 'refine',
    strengths: normalizeList(critique.strengths).slice(0, 3).map((item) => englishSafeText(item, 'Clear visual direction.', 180)),
    issues: normalizeList(critique.issues).slice(0, 3).map((item) => englishSafeText(item, 'Review visual balance.', 180)),
    repairs: normalizeCriticRepairs(critique.repairs),
    verdict: englishSafeText(critique.verdict, score >= 82 ? 'Ready for seller selection.' : 'Automatic layout refinement applied.', 220),
    model,
    provider: 'Fireworks AI (AMD-hosted vision critique)',
    amdComputeVerified: true,
    durationMs: Date.now() - startedAt,
  }
}

async function handleDesignCritique(req, res) {
  try {
    const rawBody = await readBody(req)
    const parsed = rawBody ? JSON.parse(rawBody) : {}
    const experienceId = normalizeExperienceId(parsed.experienceId)
    const iteration = Math.round(clampNumber(parsed.iteration, 0, 1))
    const screenshot = cleanDesignScreenshot(parsed.screenshot)
    if (!screenshot) {
      sendJson(res, 400, { error: 'A JPEG design screenshot under 1.5 MB is required.' })
      return
    }
    const critique = await callFireworksDesignCritic(screenshot, experienceId, iteration)
    sendJson(res, 200, critique)
  } catch (error) {
    sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) })
  }
}

function buildDraftPayload(input, kit) {
  return {
    source: 'rukter.ai-launch-agent',
    draftOnly: true,
    publishGuard: 'manual_seller_review_required',
    target: {
      canonicalUrl: process.env.RUKTER_CANONICAL_URL || 'https://rukter.com',
      dashboardUrl: process.env.RUKTER_DASHBOARD_URL || 'https://store-4.rukter.com/dashboard/theme',
    },
    storeContext: {
      channel: englishSafeText(input.channel, 'Selected sales channel', 80),
      market: englishSafeText(input.market, 'Selected market', 120),
      productImage: publicProductImageMeta(input.productImage),
      productAnalysis: kit.productAnalysis,
    },
    themeDraft: {
      creativeDirection: kit.creativeDirection,
      hero: kit.hero,
      sections: kit.storefrontLayout,
      mediaPlan: kit.mediaPlan,
      seo: kit.seo,
      reviewChecklist: kit.dashboardReview,
    },
  }
}

function draftBriefFromLaunchKit(input, kit, experienceId = defaultExperienceId) {
  const experience = experienceCatalog[normalizeExperienceId(experienceId)]
  const layout = normalizeList(kit.storefrontLayout)
    .map((section) => `${cleanText(section.section || section.name, 80)}: ${cleanText(section.purpose || section.copy || section.description, 180)}`)
    .filter(Boolean)
    .slice(0, 5)
    .join(' | ')
  const media = normalizeList(kit.mediaPlan)
    .map((item) => `${cleanText(item.slot || item.role, 60)} ${cleanText(item.direction || item.copy, 160)}`)
    .filter(Boolean)
    .slice(0, 4)
    .join(' | ')
  return cleanText([
    `Create an unpublished editable Rukter storefront draft for ${input.channel || 'DTC'} in ${input.market || 'Southeast Asia'}.`,
    input.brief ? `Seller notes: ${input.brief}` : '',
    `AI product analysis: ${kit.productAnalysis?.summary || ''}`,
    `Brand angle: ${kit.brandAngle?.positioning || ''}`,
    `Hero: ${kit.hero?.headline || ''} - ${kit.hero?.subheading || ''}`,
    `Layout: ${layout}`,
    `Media direction: ${media}`,
    `SEO: ${kit.seo?.title || ''} ${kit.seo?.description || ''}`,
    `Selected experience: ${experience.name}, using the ${experience.engine} direction. Preserve this visual and motion direction in the editable page.`,
    `Art direction: ${kit.creativeDirection?.artDirection || experience.name}. Tone: ${kit.creativeDirection?.tone || 'Premium and product-led'}.`,
    'Keep this as a draft only. Do not publish. Make the page editable in the Rukter dashboard.',
  ].filter(Boolean).join('\n'), 1000)
}

function normalizeList(value) {
  if (Array.isArray(value)) return value
  if (!value) return []
  return [value]
}

function creativeAssetsForInput(input) {
  const imageUrl = cleanHttpsUrl(input.productImage?.url)
  if (!imageUrl) return []
  return [{
    mediaUrl: imageUrl,
    kind: 'image',
    role: 'hero_image',
    slotId: 'hero-image',
    importToRukterAssets: true,
  }]
}

function assetSlot(id, role, label, input, prompt = '') {
  const imageUrl = cleanHttpsUrl(input.productImage?.url)
  return {
    id,
    kind: 'image',
    role,
    label,
    ...(imageUrl ? { url: imageUrl } : {}),
    generationPrompt: prompt || `${label} for ${inferProductName(input.brief, input.productImage?.name)}`,
  }
}

function creativeExperienceCss(experienceId) {
  const common = '.rk-hero{position:relative;isolation:isolate;overflow:hidden}.rk-copy{position:relative;z-index:3}.rk-product-stage{position:relative;min-height:820px;margin:0;border-radius:0;background-color:#fff;background-size:contain;background-repeat:no-repeat;overflow:hidden}.rk-stage-word{position:absolute;z-index:0;top:50%;left:50%;width:120%;color:rgba(23,92,255,.1);font-size:132px;font-weight:950;line-height:.8;text-align:center;text-transform:uppercase;transform:translate(-50%,-50%);white-space:nowrap}.rk-stage-frame{position:absolute;inset:7%;border:1px solid rgba(23,92,255,.3)}.rk-marquee{display:flex;width:max-content;min-width:200%;overflow:hidden;background:var(--rk-accent,#175cff);color:#fff}.rk-marquee span{min-width:50%;padding:18px 28px;font-size:14px;font-weight:900;text-transform:uppercase;white-space:nowrap;animation:rk-marquee 22s linear infinite}@keyframes rk-marquee{to{transform:translateX(-100%)}}@media(max-width:640px){.rk-product-stage{min-height:62vh;margin:0}.rk-stage-word{font-size:62px}.rk-stage-frame{inset:14px}.rk-marquee span{padding-block:14px}}@media(prefers-reduced-motion:reduce){.rk-marquee span{animation:none}}'
  const styles = {
    'editorial-monograph': '.rk-launch-page{--rk-accent:#e31b23;background:#fff;color:#111}.rk-hero{grid-template-columns:1.1fr .9fr;background:#fff}.rk-copy{border-right:1px solid #111}.rk-copy h1{font-family:Arial Narrow,Inter,system-ui,sans-serif;text-transform:uppercase}.rk-proof,.rk-story{background:#111;color:#fff}.rk-kicker,.rk-card span{color:#e31b23}',
    'botanical-cinema': '.rk-launch-page{--rk-accent:#9dff20;background:#050705;color:#fff}.rk-hero,.rk-sections,.rk-story,.rk-social,.rk-cta{background:#050705;color:#fff;border-color:#263122}.rk-copy h1,.rk-kicker,.rk-card span{color:#9dff20}.rk-product-stage,.rk-side-image{background:#0d140c;border:1px solid #38562f}.rk-card{background:#0b100a;border-color:#263122}',
    'object-gallery': '.rk-launch-page{--rk-accent:#175cff;background:#f2f4f7;color:#111}.rk-hero{background:#f2f4f7}.rk-copy{border-right:1px solid #cbd2de}.rk-copy h1{font-family:Georgia,serif;font-weight:500}.rk-product-stage{background:#e7ebf1;border-color:#175cff}.rk-proof,.rk-story{background:#fff}.rk-kicker,.rk-card span{color:#175cff}',
    'tactile-commerce': '.rk-launch-page{--rk-accent:#ffd632;background:#fff;color:#111}.rk-hero{background:#175cff;color:#fff}.rk-copy h1{font-family:Inter,system-ui,sans-serif;font-weight:950}.rk-product-stage{background:#fff}.rk-proof{background:#ff5d48}.rk-story{background:#ffd632}.rk-social{background:#175cff}.rk-kicker,.rk-card span{color:#e31b23}',
  }
  return `${common}${styles[normalizeExperienceId(experienceId)]}`
}

function buildCreativePageManifest(input, kit, selectedExperienceId = defaultExperienceId) {
  const experienceId = normalizeExperienceId(selectedExperienceId)
  const experience = experienceCatalog[experienceId]
  const product = kit.productAnalysis?.productType || inferProductName(input.brief, input.productImage?.name)
  const shortProduct = product
    .split(/\s+(?:or|and)\s+|[(/]/i)[0]
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join(' ')
  const channel = input.channel || 'DTC'
  const market = input.market || 'Southeast Asia'
  const hero = kit.hero || {}
  const brand = kit.brandAngle || {}
  const layout = normalizeList(kit.storefrontLayout).slice(0, 4)
  const captions = normalizeList(kit.socialCaptions).slice(0, 3)
  const checklist = normalizeList(kit.dashboardReview).slice(0, 4)
  const heroHeadline = {
    'editorial-monograph': `${shortProduct}. Considered.`,
    'botanical-cinema': `${shortProduct}, in full view.`,
    'object-gallery': 'An object worth a closer look.',
    'tactile-commerce': `Meet the ${shortProduct}.`,
  }[experienceId] || hero.headline || `${product} in focus`
  const heroSubheading = kit.productAnalysis?.summary || hero.subheading || brand.promise || `A product-led study for ${market}.`
  const proofItems = [
    brand.customer || `Built for ${market} sellers`,
    brand.promise || 'Editable before publish',
    brand.positioning || `Ready for ${channel}`,
  ]
  const layoutCards = layout.map((item, index) => `
        <article class="rk-card">
          <span>${String(index + 1).padStart(2, '0')}</span>
          <h3 data-rk-editable="section-${index + 1}-title">${escapeHtml(item.section || item.name || 'Storefront section', 120)}</h3>
          <p data-rk-editable="section-${index + 1}-copy">${escapeHtml(item.copy || item.purpose || item.description || 'Editable launch section.', 260)}</p>
        </article>`).join('')
  const proofHtml = proofItems.map((item, index) => `
          <li><strong>0${index + 1}</strong><span>${escapeHtml(item, 180)}</span></li>`).join('')
  const captionHtml = captions.map((item) => `
        <article>
          <strong>${escapeHtml(item.channel || 'Social', 80)}</strong>
          <p>${escapeHtml(item.caption || item, 220)}</p>
        </article>`).join('')
  const checklistHtml = checklist.map((item) => `<li>${escapeHtml(item, 180)}</li>`).join('')
  const assetSlots = [
    assetSlot('hero-image', 'hero_image', `${product} hero image`, input, `${product} premium product hero for ${channel}`),
    assetSlot('story-image', 'story', `${product} story image`, input, `${product} lifestyle story for ${market}`),
    assetSlot('proof-image', 'proof', `${product} trust image`, input, `${product} trust and proof visual`),
  ]
  const editables = [
    { id: 'hero-eyebrow', kind: 'text', selector: '[data-rk-editable="hero-eyebrow"]', label: 'Hero eyebrow' },
    { id: 'hero-title', kind: 'text', selector: '[data-rk-editable="hero-title"]', label: 'Hero headline' },
    { id: 'hero-subheading', kind: 'text', selector: '[data-rk-editable="hero-subheading"]', label: 'Hero subheading' },
    { id: 'primary-cta', kind: 'link', selector: '[data-rk-editable="primary-cta"]', label: 'Primary CTA' },
    ...layout.map((_, index) => ({
      id: `section-${index + 1}-title`,
      kind: 'text',
      selector: `[data-rk-editable="section-${index + 1}-title"]`,
      label: `Section ${index + 1} title`,
    })),
    ...layout.map((_, index) => ({
      id: `section-${index + 1}-copy`,
      kind: 'text',
      selector: `[data-rk-editable="section-${index + 1}-copy"]`,
      label: `Section ${index + 1} copy`,
    })),
    ...assetSlots.map((slot) => ({
      id: `${slot.id}-media`,
      kind: 'media',
      selector: `[data-slot="${slot.id}"]`,
      label: slot.label,
      slotId: slot.id,
    })),
  ]

  return {
    schema: freeformCreativePageSchema,
    version: 4,
    mode: 'replace_page',
    fullPage: true,
    suppressLegacyFooter: true,
    documentOnly: true,
    themeMode: 'light',
    document: {
      id: `rukter-ai-${experienceId}`,
      name: `${product} / ${experience.name}`,
      experienceId,
      experienceName: experience.name,
      height: 3200,
      heightTablet: 3600,
      heightMobile: 4300,
      mobileLayout: 'custom',
      background: { color: '#f7fbf9' },
      modules: ['rk-media', 'rk-motion'],
      assetSlots,
      editables,
      qa: {
        requiredViewports: ['desktop', 'mobile'],
        checks: ['noBlankRuntime', 'noHorizontalOverflow', 'noConsoleErrors', 'responsiveViewports', 'noTextOverlap'],
        maxConsoleErrors: 0,
      },
      html: `<main class="rk-launch-page rk-experience-${experienceId}" data-rukter-runtime="freeform-document" data-experience="${experienceId}">
  <section class="rk-hero">
    <div class="rk-copy">
      <p class="rk-kicker" data-rk-editable="hero-eyebrow">${escapeHtml(channel)} / ${escapeHtml(market)}</p>
      <h1 data-rk-editable="hero-title">${escapeHtml(heroHeadline, 160)}</h1>
      <p data-rk-editable="hero-subheading">${escapeHtml(heroSubheading, 300)}</p>
      <a class="rk-button" href="#launch-kit" data-rk-editable="primary-cta">${escapeHtml(hero.primaryCta || 'Shop the launch', 80)}</a>
    </div>
    <div class="rk-product-stage" data-slot="hero-image" aria-label="Product hero image"><span class="rk-stage-word">${escapeHtml(shortProduct, 80)}</span><span class="rk-stage-frame"></span></div>
  </section>
  <div class="rk-marquee" aria-hidden="true"><span>${escapeHtml(shortProduct, 80)} + ${escapeHtml(kit.creativeDirection?.tone || 'Product-led', 120)} + Made from one image +</span><span>${escapeHtml(shortProduct, 80)} + ${escapeHtml(kit.creativeDirection?.tone || 'Product-led', 120)} + Made from one image +</span></div>
  <section class="rk-proof">
    <ol>${proofHtml}</ol>
  </section>
  <section id="launch-kit" class="rk-sections">
    <p class="rk-kicker">Editable launch plan</p>
    <h2>${escapeHtml(product, 120)} storefront sections</h2>
    <div class="rk-card-grid">${layoutCards}</div>
  </section>
  <section class="rk-story">
    <div>
      <p class="rk-kicker">Product story</p>
      <h2>${escapeHtml(brand.positioning || heroHeadline, 160)}</h2>
      <p>${escapeHtml(brand.promise || heroSubheading, 320)}</p>
    </div>
    <div class="rk-side-image" data-slot="story-image"></div>
  </section>
  <section class="rk-social">
    <div>
      <p class="rk-kicker">Campaign copy</p>
      <h2>Ready for seller review</h2>
      <div class="rk-caption-grid">${captionHtml}</div>
    </div>
    <div class="rk-review">
      <strong>Before publish</strong>
      <ul>${checklistHtml}</ul>
    </div>
  </section>
  <section class="rk-cta">
    <div class="rk-side-image" data-slot="proof-image"></div>
    <div>
      <p class="rk-kicker">Manual publish gate</p>
      <h2>AI creates the draft. The seller publishes.</h2>
      <p>This page stays unpublished until the Rukter dashboard review is complete.</p>
    </div>
  </section>
</main>`,
      css: `.rk-launch-page{width:100%;max-width:100%;overflow:hidden;overflow-x:hidden;background:#f7fbf9;color:#101417;font-family:Inter,ui-sans-serif,system-ui,sans-serif;letter-spacing:0}.rk-launch-page *{box-sizing:border-box;min-width:0}.rk-launch-page h1,.rk-launch-page h2,.rk-launch-page h3,.rk-launch-page p{overflow-wrap:anywhere;letter-spacing:0}.rk-hero{display:grid;grid-template-columns:minmax(0,.92fr) minmax(280px,.76fr);min-height:820px;border-bottom:1px solid #dbe7e3;background:#f7fbf9;align-items:center}.rk-copy{padding:72px}.rk-kicker{margin:0 0 16px;color:#008575;font-size:13px;font-weight:900;text-transform:uppercase}.rk-copy h1{margin:0;max-width:12ch;font-size:82px;line-height:.98;font-weight:950}.rk-copy p:not(.rk-kicker){max-width:640px;color:#41515d;font-size:21px;line-height:1.55}.rk-button{display:inline-flex;align-items:center;justify-content:center;width:max-content;min-width:170px;margin-top:28px;padding:16px 24px;border-radius:4px;background:#101417;color:#fff;text-decoration:none;font-weight:900}.rk-product-stage,.rk-side-image{min-height:420px;margin:48px;border:1px solid #dbe7e3;border-radius:8px;background:#edf7f4;background-size:cover;background-position:center}.rk-proof ol{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));list-style:none;margin:0;padding:0;border-bottom:1px solid #dbe7e3}.rk-proof li{padding:34px;border-right:1px solid #dbe7e3}.rk-proof li:last-child{border-right:0}.rk-proof strong{display:block;color:#e2372b;margin-bottom:10px}.rk-proof span{font-weight:850;font-size:26px;line-height:1.18}.rk-sections,.rk-story,.rk-social,.rk-cta{padding:82px}.rk-sections h2,.rk-story h2,.rk-social h2,.rk-cta h2{margin:0 0 28px;font-size:60px;line-height:1.02;font-weight:950;max-width:13ch}.rk-card-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px}.rk-card{border:1px solid #d6e2dd;border-radius:8px;background:#fff;padding:22px;min-height:260px}.rk-card span{color:#e2372b;font-weight:950}.rk-card h3{font-size:24px;line-height:1.08;margin:22px 0 12px}.rk-card p,.rk-story p,.rk-social p,.rk-cta p,.rk-review li{color:#41515d;line-height:1.55}.rk-story,.rk-cta{display:grid;grid-template-columns:minmax(0,.9fr) minmax(280px,.74fr);align-items:center;gap:36px;background:#fff}.rk-story .rk-side-image,.rk-cta .rk-side-image{margin:0;min-height:360px}.rk-social{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,.44fr);gap:30px;background:#101417;color:#fff}.rk-social h2,.rk-social .rk-kicker,.rk-cta h2{color:inherit}.rk-caption-grid{display:grid;gap:14px}.rk-caption-grid article,.rk-review{border:1px solid rgba(255,255,255,.16);border-radius:8px;background:rgba(255,255,255,.08);padding:18px}.rk-review ul{padding-left:18px}.rk-cta{background:#f7fbf9}${creativeExperienceCss(experienceId)}@media(max-width:960px){.rk-hero,.rk-story,.rk-social,.rk-cta{grid-template-columns:1fr}.rk-proof ol,.rk-card-grid{grid-template-columns:1fr 1fr}.rk-product-stage{margin-top:0}}@media(max-width:640px){.rk-copy,.rk-sections,.rk-story,.rk-social,.rk-cta{padding:38px 22px}.rk-copy h1{font-size:46px;max-width:12ch}.rk-sections h2,.rk-story h2,.rk-social h2,.rk-cta h2{font-size:40px;max-width:14ch}.rk-product-stage,.rk-side-image{margin:0 22px 34px;min-height:300px;border-radius:8px}.rk-proof ol,.rk-card-grid{grid-template-columns:1fr}.rk-proof li{border-right:0;border-bottom:1px solid #dbe7e3}.rk-button{width:100%;max-width:260px}}`,
      js: `const rk=window.Rukter||{getAsset(){return null}};function safe(value){return typeof value==='string'?value.replace(/"/g,''):''}function applySlot(node){const id=node.getAttribute('data-slot');const asset=id&&rk.getAsset?rk.getAsset(id):null;const url=safe(asset&&asset.mediaUrl);if(url)node.style.backgroundImage='url("'+url+'")'}document.querySelectorAll('[data-slot]').forEach(applySlot);`,
    },
  }
}

function buildMcpDraftArguments(input, kit, selectedExperienceId = defaultExperienceId, productAssets = []) {
  const experienceId = normalizeExperienceId(selectedExperienceId)
  const isolatedAssetUrl = normalizeList(productAssets)
    .map((asset) => cleanHttpsUrl(asset?.url))
    .find(Boolean)
  const draftInput = isolatedAssetUrl
    ? { ...input, productImage: { ...(input.productImage || {}), url: isolatedAssetUrl } }
    : input
  const creativeAssets = creativeAssetsForInput(draftInput)
  const creativePage = buildCreativePageManifest(draftInput, kit, experienceId)
  const requiredCapabilities = ['image', 'commerce', 'media_slots', 'freeform', 'motion']
  if (experienceUsesThree(experienceId)) requiredCapabilities.push('3d')
  return {
    brief: draftBriefFromLaunchKit(input, kit, experienceId),
    slug: 'index',
    language: 'en',
    qualityMode: 'awwwards',
    requiredCapabilities,
    experienceId,
    experienceName: experienceCatalog[experienceId].name,
    creativePage,
    ...(creativeAssets.length ? { creativeAssets } : {}),
  }
}

function buildAmdEvidence(mode, modelOverride = '', inferenceMeta = {}, input = {}) {
  const model = modelOverride || (hasProductImage(input) ? resolveFireworksVisionModel() : resolveFireworksModel())
  const isFireworks = mode === 'fireworks_inference'
  const gemmaTargeted = /gemma/i.test(model)
  const runtimeConfig = fireworksRuntimeConfig()
  const responseDurationMs = inferenceMeta.responseDurationMs ?? null
  const withinResponseBudget = responseDurationMs !== null && responseDurationMs < hackathonResponseBudgetMs
  return {
    mode,
    provider: isFireworks ? 'Fireworks AI (AMD-hosted inference)' : 'Local deterministic demo fallback',
    model,
    fallbackModels: resolveInferenceModels(input).slice(1),
    fireworksConfigured: Boolean(process.env.FIREWORKS_API_KEY),
    inferenceStatus: inferenceMeta.status || (isFireworks ? 'ok' : 'fallback_or_unconfigured'),
    inferenceDurationMs: inferenceMeta.durationMs ?? null,
    modelAttempts: inferenceMeta.attempts || [],
    requestTimeoutMs: inferenceMeta.requestTimeoutMs || runtimeConfig.requestTimeoutMs,
    totalTimeoutMs: inferenceMeta.totalTimeoutMs || runtimeConfig.totalTimeoutMs,
    maxTokens: inferenceMeta.maxTokens || runtimeConfig.maxTokens,
    responseDurationMs,
    responseBudgetMs: hackathonResponseBudgetMs,
    withinResponseBudget,
    amdComputeVerified: isFireworks,
    submissionEligibleRun: isFireworks && withinResponseBudget,
    amdComputePath: isFireworks
      ? 'Fireworks AI inference using AMD-hardware-hosted models.'
      : 'Not verified for this response because Fireworks inference did not complete.',
    gemmaTargeted,
    visionInputUsed: hasProductImage(input),
    visionModel: resolveFireworksVisionModel(),
    claimSafetyApplied: true,
    claimSafetyRewrites: inferenceMeta.claimSafetyRewrites ?? 0,
    fireworksBaseUrl: process.env.FIREWORKS_BASE_URL || 'https://api.fireworks.ai/inference/v1',
    ...(process.env.AMD_CLOUD_INSTANCE ? { amdCloudInstance: process.env.AMD_CLOUD_INSTANCE } : {}),
    ...(process.env.AMD_GPU_NAME ? { amdGpuName: process.env.AMD_GPU_NAME } : {}),
    ...(process.env.ROCM_VERSION ? { rocmVersion: process.env.ROCM_VERSION } : {}),
    hostingPlatform: process.env.RUKTER_AI_HOSTING_PLATFORM || process.env.RUKTER_AI_DEPLOY_ENV || '',
    runtimePlatform: `${process.platform}/${process.arch === 'x64' ? 'amd64' : process.arch}`,
    generatedAt: new Date().toISOString(),
    note: isFireworks
      ? gemmaTargeted
        ? 'Verified Fireworks inference run targeting Gemma on AMD-hosted infrastructure.'
        : 'Verified Fireworks inference run using an AMD-hardware-hosted model.'
      : 'Fallback output is for local review only and is not valid AMD compute evidence for submission.',
  }
}

function buildDesignQuality(kit, productAssets) {
  const checks = [
    {
      id: 'product-isolation',
      label: 'Transparent product isolation',
      weight: 24,
      passed: productAssets.length > 0 && productAssets.every((asset) => asset.backgroundRemoved),
    },
    {
      id: 'complete-story',
      label: 'Complete landing-page story',
      weight: 20,
      passed: normalizeList(kit.storefrontLayout).length >= 4,
    },
    {
      id: 'visual-evidence',
      label: 'Photo-grounded product evidence',
      weight: 18,
      passed: normalizeList(kit.productAnalysis?.visibleDetails).length >= 3,
    },
    {
      id: 'claim-safety',
      label: 'Seller-verification guard',
      weight: 18,
      passed: normalizeList(kit.productAnalysis?.needsReview).length >= 2,
    },
    {
      id: 'seo-ready',
      label: 'SEO title, description, and keywords',
      weight: 12,
      passed: Boolean(kit.seo?.title && kit.seo?.description && normalizeList(kit.seo?.keywords).length),
    },
    {
      id: 'responsive-contract',
      label: 'Desktop and mobile runtime contract',
      weight: 8,
      passed: true,
    },
  ]
  const score = checks.reduce((total, check) => total + (check.passed ? check.weight : 0), 0)
  const failedChecks = checks.filter((check) => !check.passed).map((check) => check.label)
  return {
    score,
    status: score >= 85 ? 'passed' : 'refine',
    checkedBy: 'Rukter visual quality gate',
    directionCount: Object.keys(experienceCatalog).length,
    checks,
    recommendation: score >= 85
      ? 'Art direction, content completeness, responsive behavior, and seller-review controls are ready for visual selection.'
      : `Refine before selection: ${failedChecks.join(', ')}.`,
  }
}

function storyGpuEnabled() {
  return Boolean(gpuLeaseOrchestrator && storyOrchestratorUrl())
    && String(process.env.AMD_GPU_PUBLIC_ENABLED || '').toLowerCase() === 'true'
}

function storyOrchestratorUrl() {
  return String(process.env.AMD_GPU_ORCHESTRATOR_URL || `http://127.0.0.1:${port}`).replace(/\/$/, '')
}

function pruneStoryJobs() {
  const cutoff = Date.now() - storyJobTtlMs
  for (const [id, job] of storyJobs) {
    if (['ready', 'failed', 'cancelled'].includes(job.status) && new Date(job.updatedAt).getTime() < cutoff) {
      storyJobs.delete(id)
    }
  }
}

function publicStoryQueue(job) {
  const queue = job?.queue
  if (!queue) return null
  const enqueuedAtMs = new Date(queue.enqueuedAt || '').getTime()
  const waitEndedAtMs = new Date(queue.startedAt || queue.completedAt || '').getTime()
  const waitMs = Number.isFinite(enqueuedAtMs)
    ? Math.max(0, (Number.isFinite(waitEndedAtMs) ? waitEndedAtMs : Date.now()) - enqueuedAtMs)
    : 0
  return {
    policy: 'fifo',
    concurrency: 1,
    state: queue.state,
    position: Number(queue.position) || 0,
    jobsAhead: Number(queue.jobsAhead) || 0,
    enqueuedAt: queue.enqueuedAt || null,
    startedAt: queue.startedAt || null,
    completedAt: queue.completedAt || null,
    waitMs,
    note: queue.note || '',
  }
}

function publicStoryJob(job) {
  if (!job) return null
  return {
    id: job.id,
    schema: 'rukter.product_story_job.v2',
    status: job.status,
    requestedMode: job.requestedMode,
    effectiveMode: job.effectiveMode,
    style: job.request.style,
    aspect: job.request.aspect,
    durationSeconds: job.request.durationSeconds,
    sourceImages: job.request.sourceImages,
    activity: job.activity,
    currentStep: job.currentStep,
    currentShot: job.currentShot,
    totalShots: job.plan?.shots?.length || Math.min(5, job.request.sourceImages.length),
    plan: job.plan || null,
    productAnalysis: job.productAnalysis || null,
    aiDirection: job.aiDirection || null,
    output: job.output || null,
    gpu: job.gpu,
    queue: publicStoryQueue(job),
    warning: job.warning || '',
    error: job.error || '',
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}

function touchStoryJob(job) {
  job.updatedAt = new Date().toISOString()
}

function updateStoryStep(job, stepId, status, detail, progress = null) {
  const step = job.activity.find((item) => item.id === stepId)
  if (!step) return
  const now = new Date().toISOString()
  if (status === 'active' && !step.startedAt) step.startedAt = now
  if (['completed', 'skipped', 'failed', 'cancelled'].includes(status)) step.completedAt = now
  step.status = status
  step.detail = cleanText(detail, 240) || step.detail
  if (progress !== null) step.progress = Math.max(0, Math.min(100, Number(progress) || 0))
  else if (status === 'completed' || status === 'skipped') step.progress = 100
  job.currentStep = stepId
  touchStoryJob(job)
}

function storyDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      signal?.removeEventListener('abort', onAbort)
      callback(value)
    }
    const timer = setTimeout(() => finish(resolve), ms)
    const onAbort = () => {
      clearTimeout(timer)
      finish(reject, signal.reason || new Error('Product Story job cancelled.'))
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function syncAmdStoryQueueState(snapshot) {
  const pendingById = new Map(snapshot.pending.map((entry, index) => [entry.id, { entry, index }]))
  const now = new Date().toISOString()
  for (const job of storyJobs.values()) {
    if (job.requestedMode !== 'amd_cinematic' || ['ready', 'failed', 'cancelled'].includes(job.status)) continue
    if (job.id === snapshot.activeId) {
      job.status = 'waiting_for_gpu'
      job.queue = {
        ...job.queue,
        state: 'checking_capacity',
        position: 0,
        jobsAhead: 0,
        startedAt: job.queue?.startedAt || now,
        note: 'GPU queue slot acquired. Checking AMD capacity before billing starts.',
      }
      updateStoryStep(job, 'gpu_queue', 'active', 'Queue slot acquired; checking AMD capacity. No GPU billing has started', 90)
      continue
    }

    const pending = pendingById.get(job.id)
    if (!pending) continue
    const jobsAhead = pending.index + (snapshot.activeId ? 1 : 0)
    const position = jobsAhead + 1
    const queueState = pending.entry.ready ? 'waiting' : 'preparing'
    job.queue = {
      ...job.queue,
      state: queueState,
      position,
      jobsAhead,
      enqueuedAt: job.queue?.enqueuedAt || pending.entry.reservedAt || now,
      note: pending.entry.ready
        ? `Waiting for the single AMD render slot. ${jobsAhead} job${jobsAhead === 1 ? '' : 's'} ahead; GPU billing has not started.`
        : `Queue place reserved while Fireworks prepares the product brief and video prompts. ${jobsAhead} job${jobsAhead === 1 ? '' : 's'} ahead.`,
    }
    if (pending.entry.ready) {
      job.status = 'waiting_for_gpu'
      updateStoryStep(
        job,
        'gpu_queue',
        'active',
        `Queue position ${position}; ${jobsAhead} job${jobsAhead === 1 ? '' : 's'} ahead. GPU billing has not started`,
        Math.max(5, 80 - jobsAhead * 10),
      )
    } else {
      touchStoryJob(job)
    }
  }
}

function setStoryQueueTerminal(job, state, note) {
  job.queue = {
    ...job.queue,
    state,
    position: 0,
    jobsAhead: 0,
    completedAt: new Date().toISOString(),
    note,
  }
}

function handleUnexpectedAmdQueueError(error, jobId) {
  const job = storyJobs.get(jobId)
  if (!job || ['ready', 'failed', 'cancelled'].includes(job.status)) return
  job.status = 'failed'
  job.error = error instanceof Error ? error.message : String(error)
  setStoryQueueTerminal(job, 'failed', 'The queued AMD render stopped unexpectedly; the next job can continue.')
  const active = job.activity.find((step) => step.status === 'active')
  if (active) updateStoryStep(job, active.id, 'failed', job.error)
  delete job.controller
  touchStoryJob(job)
}

function isRetriableAmdCapacityError(error) {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return /capacity|size is unavailable|currently unavailable|no mi300x|region.*unavailable|temporar|too many requests|\b429\b|\b502\b|\b503\b|\b504\b|fetch failed|network|timed? out/.test(message)
}

async function waitForAmdCapacity(job, signal) {
  while (true) {
    if (signal.aborted) throw signal.reason || new Error('Product Story job cancelled.')
    job.status = 'waiting_for_gpu'
    job.queue.state = 'checking_capacity'
    job.queue.note = 'First in queue. Checking AMD Developer Cloud capacity; GPU billing has not started.'
    updateStoryStep(job, 'gpu_queue', 'active', 'First in queue; checking AMD Developer Cloud capacity. No GPU billing has started', 95)
    try {
      const capacity = await gpuLeaseOrchestrator.checkCapacity({ refresh: true })
      if (capacity.available || capacity.requestable) return capacity
      job.queue.state = 'capacity_wait'
      job.queue.note = capacity.reason || 'Waiting for AMD MI300X capacity. GPU billing has not started.'
      updateStoryStep(job, 'gpu_queue', 'active', `${job.queue.note} Retrying automatically`, 95)
    } catch (error) {
      if (!isRetriableAmdCapacityError(error)) throw error
      job.queue.state = 'capacity_wait'
      job.queue.note = `AMD capacity check is temporarily unavailable: ${error instanceof Error ? error.message : String(error)}`
      updateStoryStep(job, 'gpu_queue', 'active', 'Capacity check is temporarily unavailable; retrying automatically with no GPU billing', 95)
    }
    await storyDelay(amdCapacityPollMs, signal)
  }
}

async function buildStoryLaunchKit(input) {
  let kit
  let mode = 'demo_fallback'
  let model = ''
  let inferenceMeta = null
  let modelWarning = ''
  const maxAttempts = process.env.FIREWORKS_API_KEY ? 2 : 1
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const generated = await callFireworksInference(input)
      if (generated) {
        kit = generated.kit
        mode = 'fireworks_inference'
        model = generated.model
        inferenceMeta = generated.meta
        break
      }
    } catch (error) {
      modelWarning = error instanceof Error ? error.message : String(error)
      if (attempt < maxAttempts) await storyDelay(300)
    }
  }
  if (!kit) {
    kit = fallbackLaunchKit(input)
    if (modelWarning) kit.modelWarning = modelWarning
  }
  kit.productDetections = normalizeProductDetections(
    kit.productDetections,
    kit.productAnalysis?.productType || 'Product',
  )
  kit.creativeDirection = normalizeCreativeDirection(kit.creativeDirection)
  kit = enforceSellerVerifiedClaims(kit, input).kit
  return { kit, mode, model, inferenceMeta }
}

async function runFastStory(job, signal) {
  updateStoryStep(job, 'gpu_queue', 'skipped', 'Motion Preview does not enter the AMD render queue')
  const gpuProvisionStep = job.activity.find((step) => step.id === 'gpu_provision')
  if (gpuProvisionStep?.status !== 'failed') {
    updateStoryStep(job, 'gpu_provision', 'skipped', 'AMD GPU stayed offline; no GPU billing was started')
  }
  if (job.gpu?.status !== 'release_failed') {
    job.gpu = {
      status: 'offline',
      billing: 'inactive',
      releasePolicy: 'destroy_after_job',
      device: '',
      rocmVersion: '',
      leaseId: '',
    }
  }
  job.queue = {
    state: 'not_required',
    position: 0,
    jobsAhead: 0,
    enqueuedAt: null,
    startedAt: null,
    completedAt: new Date().toISOString(),
    note: 'Motion Preview runs in the browser and does not require the AMD render queue.',
  }
  job.status = 'generating'
  updateStoryStep(job, 'motion_shots', 'active', `Preparing source-preserving shot 1 of ${job.plan.shots.length}`, 0)
  for (let index = 0; index < job.plan.shots.length; index += 1) {
    job.currentShot = index + 1
    updateStoryStep(
      job,
      'motion_shots',
      'active',
      `Preparing source-preserving shot ${index + 1} of ${job.plan.shots.length}`,
      ((index + 1) / job.plan.shots.length) * 100,
    )
    await storyDelay(260, signal)
  }
  updateStoryStep(job, 'motion_shots', 'completed', `${job.plan.shots.length} motion directions ready`)
  updateStoryStep(job, 'identity_check', 'active', 'Checking source-preserving composition policy', 50)
  await storyDelay(320, signal)
  updateStoryStep(job, 'identity_check', 'completed', 'Product pixels, logo, and packaging text remain source-preserved')
  updateStoryStep(job, 'video_composition', 'active', 'Preparing browser video composition', 60)
  await storyDelay(380, signal)
  job.output = {
    status: 'ready',
    format: 'video/webm',
    videoUrl: '',
    composition: 'browser_canvas',
    width: job.plan.output.width,
    height: job.plan.output.height,
    durationSeconds: job.plan.durationSeconds,
  }
  updateStoryStep(job, 'video_composition', 'completed', 'Interactive story and WebM export are ready')
  const releaseStep = job.activity.find((step) => step.id === 'release_gpu')
  if (releaseStep?.status !== 'failed') {
    updateStoryStep(job, 'release_gpu', 'skipped', 'No GPU lease existed; billing remained inactive')
  }
}

function handleAmdStoryEvent(job, event) {
  const eventReleasePolicy = event.lease?.releasePolicy || job.gpu?.releasePolicy || 'destroy_after_job'
  const persistentLease = eventReleasePolicy === 'retain_after_job'
  if (event.type === 'lease_request') {
    job.status = 'gpu_starting'
    updateStoryStep(job, 'gpu_provision', 'active', 'Requesting one zero-idle AMD GPU Droplet', 10)
  } else if (event.type === 'lease_progress') {
    job.status = 'gpu_starting'
    job.queue.state = 'active'
    job.queue.note = 'AMD render slot active. This job exclusively owns the GPU lifecycle until release.'
    updateStoryStep(job, 'gpu_queue', 'completed', 'Exclusive AMD render slot acquired; no other Product Story can use this lifecycle')
    job.gpu = {
      status: event.lease?.phase || 'provisioning',
      billing: persistentLease ? 'persistent_active' : 'active_for_job',
      releasePolicy: eventReleasePolicy,
      device: '',
      rocmVersion: '',
      leaseId: cleanText(event.lease?.id, 120),
    }
    updateStoryStep(job, 'gpu_provision', 'active', event.detail, event.lease?.phase === 'worker_booting' ? 65 : 30)
  } else if (event.type === 'lease_ready') {
    job.gpu = {
      status: 'ready',
      billing: persistentLease ? 'persistent_active' : 'active_for_job',
      releasePolicy: eventReleasePolicy,
      device: cleanText(event.lease?.gpuDevice, 120),
      rocmVersion: cleanText(event.lease?.rocmVersion, 80),
      leaseId: cleanText(event.lease?.id, 120),
    }
    updateStoryStep(job, 'gpu_queue', 'completed', 'Exclusive AMD render slot active')
    updateStoryStep(job, 'gpu_provision', 'completed', `${job.gpu.device || 'AMD GPU'} ready`)
    updateStoryStep(job, 'motion_shots', 'active', 'Loading Wan 2.2 text-image-to-video on AMD ROCm', 0)
  } else if (event.type === 'job_progress') {
    job.status = 'generating'
    const stage = cleanText(event.worker?.stage, 80)
    if (stage === 'identity_check') {
      const finalShot = Number(event.worker?.context?.shot) === Number(event.worker?.context?.totalShots)
      if (finalShot) {
        updateStoryStep(job, 'motion_shots', 'completed', 'All text-guided Wan 2.2 shots generated')
        updateStoryStep(job, 'identity_check', 'active', event.detail, event.progress)
      } else {
        updateStoryStep(job, 'motion_shots', 'active', event.detail, event.progress)
      }
    } else if (stage === 'video_composition' || stage === 'output_upload') {
      updateStoryStep(job, 'motion_shots', 'completed', 'All text-guided Wan 2.2 shots generated')
      updateStoryStep(job, 'identity_check', 'completed', 'Generated frames passed CLIP and OCR identity checks')
      updateStoryStep(job, 'video_composition', 'active', event.detail, event.progress)
    } else {
      updateStoryStep(job, 'motion_shots', 'active', event.detail, event.progress)
    }
  } else if (event.type === 'lease_release') {
    job.gpu.status = persistentLease ? 'retaining' : 'releasing'
    job.gpu.releasePolicy = eventReleasePolicy
    updateStoryStep(job, 'release_gpu', 'active', event.detail, 50)
  } else if (event.type === 'lease_released') {
    job.gpu.status = 'released'
    job.gpu.billing = 'inactive'
    updateStoryStep(job, 'release_gpu', 'completed', 'AMD GPU destroyed; billing stopped and the next queued job may start')
  } else if (event.type === 'lease_retained') {
    job.gpu.status = 'ready'
    job.gpu.billing = 'persistent_active'
    job.gpu.releasePolicy = 'retain_after_job'
    updateStoryStep(job, 'release_gpu', 'skipped', 'Persistent AMD GPU retained online for the next Product Story job')
  } else if (event.type === 'lease_release_failed') {
    job.gpu.status = 'release_failed'
    job.gpu.billing = 'possibly_active'
    updateStoryStep(job, 'release_gpu', 'failed', event.detail)
  }
}

async function runAmdCinematicStory(job, signal) {
  while (true) {
    await waitForAmdCapacity(job, signal)
    try {
      const result = await runAmdStoryJob({
        orchestratorUrl: storyOrchestratorUrl(),
        token: process.env.AMD_GPU_ORCHESTRATOR_TOKEN || '',
        story: job.plan,
        sourceImages: job.request.sourceImages,
        signal,
        onEvent: (event) => handleAmdStoryEvent(job, event),
      })
      if (result.evidence?.identityVerified !== true) {
        throw new Error('AMD worker did not return a verified product identity check.')
      }
      if (Number(result.evidence?.shotCount) !== job.plan.shots.length) {
        throw new Error('AMD worker did not return every directed cinematic shot.')
      }
      job.effectiveMode = 'amd_cinematic'
      job.output = {
        status: 'ready',
        format: cleanText(result.format, 40) || 'video/mp4',
        videoUrl: cleanHttpsUrl(result.videoUrl),
        composition: 'amd_gpu_worker',
        width: Number(result.width) || job.plan.output.width,
        height: Number(result.height) || job.plan.output.height,
        durationSeconds: Number(result.durationSeconds) || job.plan.durationSeconds,
        evidence: result.evidence || null,
      }
      updateStoryStep(job, 'motion_shots', 'completed', 'Wan 2.2 text-guided video shots generated on AMD ROCm')
      updateStoryStep(job, 'identity_check', 'completed', 'CLIP similarity and OCR retention checks passed')
      updateStoryStep(job, 'video_composition', 'completed', 'Verified shots composed into the final MP4')
      return
    } catch (error) {
      if (signal.aborted) throw error
      if (!job.gpu?.leaseId && isRetriableAmdCapacityError(error)) {
        job.status = 'waiting_for_gpu'
        job.gpu.status = 'offline'
        job.gpu.billing = 'inactive'
        job.queue.state = 'capacity_wait'
        job.queue.note = 'AMD capacity changed before the Droplet was created. Retrying automatically with no GPU billing.'
        updateStoryStep(job, 'gpu_queue', 'active', 'AMD capacity changed before provisioning; retrying automatically with no GPU billing', 95)
        updateStoryStep(job, 'gpu_provision', 'pending', 'Waiting for AMD capacity before requesting a Droplet', 0)
        await storyDelay(amdCapacityPollMs, signal)
        continue
      }

      const releaseFailed = job.gpu?.status === 'release_failed'
      const gpuProvisioned = Boolean(job.gpu?.leaseId)
      job.warning = releaseFailed
        ? `AMD GPU release failed: ${error instanceof Error ? error.message : String(error)} Use Release GPU now; the TTL reaper remains the final safeguard.`
        : `AMD Cinematic failed: ${error instanceof Error ? error.message : String(error)}`
      if (!releaseFailed) {
        if (!gpuProvisioned) updateStoryStep(job, 'gpu_provision', 'failed', 'AMD GPU job failed; no motion preview was substituted')
        for (const stepId of ['motion_shots', 'identity_check', 'video_composition']) {
          const step = job.activity.find((item) => item.id === stepId)
          if (step && !['completed', 'failed'].includes(step.status)) {
            updateStoryStep(job, stepId, step.status === 'active' ? 'failed' : 'skipped', 'Not completed because the AMD Cinematic job failed')
          }
        }
        if (!gpuProvisioned) {
          job.gpu.status = 'offline'
          job.gpu.billing = 'inactive'
          updateStoryStep(job, 'release_gpu', 'skipped', 'No GPU Droplet was created; billing remained inactive')
        }
      }
      throw error
    }
  }
}

function settleStoryJobFailure(job, error, signal) {
  const cancelled = signal?.aborted
  job.status = cancelled ? 'cancelled' : 'failed'
  job.error = cancelled ? '' : error instanceof Error ? error.message : String(error)
  setStoryQueueTerminal(
    job,
    cancelled ? 'cancelled' : 'failed',
    cancelled ? 'Removed from the AMD render lifecycle.' : 'This AMD render ended; the next queued job may continue.',
  )
  const active = job.activity.find((step) => step.status === 'active')
  if (active) updateStoryStep(job, active.id, cancelled ? 'cancelled' : 'failed', cancelled ? 'Cancelled by user' : job.error)
  for (const step of job.activity) {
    if (step.status === 'pending') updateStoryStep(job, step.id, 'skipped', cancelled ? 'Not run because the job was cancelled' : 'Not run because the job failed')
  }
  touchStoryJob(job)
}

async function processQueuedAmdStoryJob(jobId) {
  const job = storyJobs.get(jobId)
  if (!job || ['ready', 'failed', 'cancelled'].includes(job.status)) return
  const controller = job.controller || new AbortController()
  job.controller = controller
  try {
    await runAmdCinematicStory(job, controller.signal)
    job.status = 'ready'
    job.currentStep = 'release_gpu'
    setStoryQueueTerminal(
      job,
      'complete',
      job.gpu?.releasePolicy === 'retain_after_job'
        ? 'Persistent AMD GPU retained online; the next FIFO job can reuse it.'
        : 'AMD GPU destroyed; the next FIFO job can start.',
    )
    touchStoryJob(job)
  } catch (error) {
    settleStoryJobFailure(job, error, controller.signal)
  } finally {
    delete job.controller
  }
}

async function processStoryJob(jobId) {
  const job = storyJobs.get(jobId)
  if (!job) return
  const controller = job.controller || new AbortController()
  job.controller = controller
  try {
    updateStoryStep(job, 'source_upload', 'completed', `${job.request.sourceImages.length} source photos stored`)
    job.status = 'analyzing'
    updateStoryStep(job, 'vision_analysis', 'active', `Sending ${job.request.sourceImages.length} product views to Fireworks AI`, 10)
    const generated = await buildStoryLaunchKit(job.input)
    if (controller.signal.aborted) throw controller.signal.reason
    job.productAnalysis = generated.kit.productAnalysis
    job.aiDirection = buildStoryAiTrace({
      kit: generated.kit,
      mode: generated.mode,
      model: generated.model,
      sourceCount: job.request.sourceImages.length,
      inferenceMeta: generated.inferenceMeta,
    })
    if (generated.mode !== 'fireworks_inference' && generated.kit.modelWarning) {
      job.warning = `Vision provider fallback: ${generated.kit.modelWarning}`
    }
    updateStoryStep(
      job,
      'vision_analysis',
      'completed',
      generated.mode === 'fireworks_inference'
        ? `${generated.model.split('/').at(-1)} analyzed ${job.request.sourceImages.length} views on Fireworks AI`
        : 'Local fallback analysis completed; no remote vision model was used',
    )

    updateStoryStep(job, 'storyboard', 'active', 'Turning visible product evidence into shot prompts', 40)
    job.plan = buildProductStoryPlan({ kit: generated.kit, request: job.request })
    job.aiDirection = buildStoryAiTrace({
      kit: generated.kit,
      mode: generated.mode,
      model: generated.model,
      sourceCount: job.request.sourceImages.length,
      plan: job.plan,
      inferenceMeta: generated.inferenceMeta,
    })
    await storyDelay(260, controller.signal)
    updateStoryStep(job, 'storyboard', 'completed', `${job.plan.shots.length} text-guided video prompts ready`)

    if (job.requestedMode === 'amd_cinematic') {
      if (!storyGpuEnabled()) throw new Error('AMD Cinematic is unavailable until a verified Wan 2.2 GPU worker is online.')
      job.status = 'waiting_for_gpu'
      if (!amdStoryQueue.markReady(job.id)) throw new Error('The AMD render queue reservation was lost.')
      return
    }

    job.effectiveMode = 'fast_story'
    await runFastStory(job, controller.signal)
    job.status = 'ready'
    job.currentStep = 'release_gpu'
    touchStoryJob(job)
  } catch (error) {
    amdStoryQueue.cancel(job.id)
    settleStoryJobFailure(job, error, controller.signal)
  } finally {
    if (['ready', 'failed', 'cancelled'].includes(job.status)) delete job.controller
  }
}

async function handleCreateStoryJob(req, res) {
  try {
    pruneStoryJobs()
    const rawBody = await readBody(req)
    const parsed = rawBody ? JSON.parse(rawBody) : {}
    const request = normalizeStoryRequest(parsed)
    if (request.mode === 'amd_cinematic' && !storyGpuEnabled()) {
      sendJson(res, 409, {
        code: 'amd_cinematic_unavailable',
        error: 'AMD Cinematic is unavailable until a verified Wan 2.2 GPU worker is online. Select Motion Preview instead.',
      })
      return
    }
    if (request.sourceImages.length < productStoryLimits.minImages) {
      sendJson(res, 400, { error: `Upload at least ${productStoryLimits.minImages} product photos.` })
      return
    }
    const input = sanitizeLaunchInput({
      brief: parsed.brief,
      channel: parsed.channel,
      market: parsed.market,
      productImage: parsed.productImage,
      sourceImages: request.sourceImages,
      capture: { kind: 'multi_photo', extractedFrameCount: request.sourceImages.length },
    })
    const now = new Date().toISOString()
    const id = `story_${randomUUID().replaceAll('-', '')}`
    const activity = createStoryActivity()
    if (request.mode !== 'amd_cinematic') {
      const generationStep = activity.find((step) => step.id === 'motion_shots')
      if (generationStep) generationStep.label = 'Source motion preview'
    }
    const job = {
      id,
      status: 'queued',
      requestedMode: request.mode,
      effectiveMode: request.mode === 'amd_cinematic' && storyGpuEnabled() ? 'amd_cinematic' : 'fast_story',
      request,
      input,
      activity,
      currentStep: 'source_upload',
      currentShot: 0,
      plan: null,
      aiDirection: null,
      output: null,
      gpu: {
        status: 'offline',
        billing: 'inactive',
        releasePolicy: 'destroy_after_job',
        device: '',
        rocmVersion: '',
        leaseId: '',
      },
      queue: {
        state: request.mode === 'amd_cinematic' ? 'preparing' : 'not_required',
        position: 0,
        jobsAhead: 0,
        enqueuedAt: request.mode === 'amd_cinematic' ? now : null,
        startedAt: null,
        completedAt: null,
        note: request.mode === 'amd_cinematic'
          ? 'FIFO place reserved while Fireworks prepares the product brief and video prompts.'
          : 'Motion Preview does not require the AMD render queue.',
      },
      warning: '',
      error: '',
      controller: new AbortController(),
      createdAt: now,
      updatedAt: now,
    }
    storyJobs.set(id, job)
    if (request.mode === 'amd_cinematic') {
      const reservation = amdStoryQueue.reserve(id)
      if (!reservation.accepted) {
        storyJobs.delete(id)
        sendJson(res, 429, {
          code: 'amd_queue_full',
          error: `The AMD render queue is full (${reservation.capacity} jobs). Try again after a queued job finishes or is cancelled.`,
          queue: { policy: 'fifo', concurrency: 1, capacity: reservation.capacity },
        })
        return
      }
    }
    setTimeout(() => processStoryJob(id), 0)
    sendJson(res, 202, publicStoryJob(job))
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}

function handleGetStoryJob(res, jobId) {
  const job = storyJobs.get(jobId)
  if (!job) {
    sendJson(res, 404, { error: 'Product Story job not found.' })
    return
  }
  sendJson(res, 200, publicStoryJob(job))
}

function cancelStoryJob(job) {
  if (['ready', 'failed', 'cancelled'].includes(job.status)) return
  const controller = job.controller
  const removedFromQueue = amdStoryQueue.cancel(job.id)
  const activeGpuJob = amdStoryQueue.snapshot().activeId === job.id
  controller?.abort(new Error('Cancelled by user.'))

  if (activeGpuJob) {
    job.status = 'cancelling'
    job.queue.state = 'cancelling'
    job.queue.note = 'Cancelling the active render and destroying its AMD GPU before the next job starts.'
    const active = job.activity.find((step) => step.status === 'active')
    if (active) updateStoryStep(job, active.id, 'active', 'Cancellation requested; destroying the AMD GPU before advancing the queue', active.progress)
    touchStoryJob(job)
    return
  }

  settleStoryJobFailure(job, new Error('Cancelled by user.'), controller?.signal || AbortSignal.abort())
  if (removedFromQueue) {
    const queueStep = job.activity.find((step) => step.id === 'gpu_queue')
    if (queueStep && !['completed', 'cancelled'].includes(queueStep.status)) {
      updateStoryStep(job, 'gpu_queue', 'cancelled', 'Removed from the AMD render queue; no GPU billing started')
    }
  }
}

async function releaseStoryGpu(job) {
  const removedFromQueue = amdStoryQueue.cancel(job.id)
  job.controller?.abort(new Error('GPU released by user.'))
  if (removedFromQueue && !job.gpu?.leaseId) {
    settleStoryJobFailure(job, new Error('GPU queue place released by user.'), job.controller?.signal || AbortSignal.abort())
    updateStoryStep(job, 'gpu_queue', 'cancelled', 'Removed from the AMD render queue; no GPU Droplet existed')
    return
  }
  const leaseId = job.gpu?.leaseId
  const orchestratorUrl = storyOrchestratorUrl()
  let releaseResult = null
  if (leaseId && orchestratorUrl) {
    const response = await fetch(`${orchestratorUrl.replace(/\/$/, '')}/v1/leases/${encodeURIComponent(leaseId)}/release`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.AMD_GPU_ORCHESTRATOR_TOKEN ? { authorization: `Bearer ${process.env.AMD_GPU_ORCHESTRATOR_TOKEN}` } : {}),
      },
      body: JSON.stringify({ policy: 'destroy' }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`AMD GPU release returned ${response.status}.`)
    releaseResult = await response.json().catch(() => null)
  }
  if (releaseResult?.status === 'retained' || releaseResult?.releasePolicy === 'retain_after_job') {
    job.gpu.status = 'ready'
    job.gpu.billing = 'persistent_active'
    job.gpu.releasePolicy = 'retain_after_job'
    updateStoryStep(job, 'release_gpu', 'skipped', 'Persistent AMD GPU retained online by owner policy')
    return
  }
  job.gpu.status = leaseId ? 'released' : 'offline'
  job.gpu.billing = 'inactive'
  updateStoryStep(job, 'release_gpu', leaseId ? 'completed' : 'skipped', leaseId ? 'AMD GPU destroyed; billing stopped' : 'No GPU Droplet existed; billing remained inactive')
}

function gpuControlAuthorized(req) {
  const token = process.env.AMD_GPU_ORCHESTRATOR_TOKEN || ''
  return Boolean(token) && req.headers.authorization === `Bearer ${token}`
}

function requireGpuControl(req, res) {
  if (!gpuControlAuthorized(req)) {
    sendJson(res, 401, { error: 'Invalid AMD GPU control token.' })
    return false
  }
  if (!gpuLeaseOrchestrator) {
    sendJson(res, 503, { error: 'AMD GPU lease orchestrator is not configured.' })
    return false
  }
  return true
}

async function handleStartGpuLease(req, res) {
  if (!requireGpuControl(req, res)) return
  try {
    const body = await readBody(req)
    const parsed = body ? JSON.parse(body) : {}
    const lease = await gpuLeaseOrchestrator.startLease({ dryRun: parsed.dryRun === true })
    sendJson(res, parsed.dryRun === true ? 200 : 202, lease)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendJson(res, message.includes('already exists') ? 409 : 502, { error: message })
  }
}

async function handleGetGpuLease(req, res, leaseId) {
  if (!requireGpuControl(req, res)) return
  try {
    const lease = await gpuLeaseOrchestrator.inspectLease(leaseId)
    sendJson(res, 200, lease)
  } catch (error) {
    sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) })
  }
}

async function handleReleaseGpuLease(req, res, leaseId) {
  if (!requireGpuControl(req, res)) return
  try {
    const lease = await gpuLeaseOrchestrator.releaseLease(leaseId)
    sendJson(res, 200, lease)
  } catch (error) {
    sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) })
  }
}

async function handleAmdStoryAssetUpload(req, res) {
  if (!gpuControlAuthorized(req)) {
    sendJson(res, 401, { error: 'Invalid AMD worker token.' })
    return
  }
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('video/mp4')) {
    sendJson(res, 415, { error: 'AMD story output must be an MP4 video.' })
    return
  }
  try {
    const video = await readBuffer(req, maxVideoUploadBytes)
    if (!video.length) throw new Error('AMD story output is empty.')
    await mkdir(uploadDir, { recursive: true })
    const jobId = cleanText(req.headers['x-rukter-job-id'], 80).replace(/[^a-zA-Z0-9_-]/g, '') || 'story'
    const fileName = `${jobId}-${randomUUID()}.mp4`
    await writeFile(path.join(uploadDir, fileName), video)
    sendJson(res, 201, {
      status: 'stored',
      type: 'video/mp4',
      size: video.length,
      url: `${publicOrigin(req)}/uploads/${fileName}`,
    })
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
  }
}

async function requestAmdProductTwinReconstruction(input) {
  const workerUrl = cleanText(process.env.AMD_3D_WORKER_URL, 1200)
  const sourceViews = normalizeSourceViews(input.sourceImages)
  if (!workerUrl || sourceViews.length < 2) return null

  const startedAt = Date.now()
  const response = await fetch(workerUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(process.env.AMD_3D_WORKER_TOKEN
        ? { authorization: `Bearer ${process.env.AMD_3D_WORKER_TOKEN}` }
        : {}),
    },
    body: JSON.stringify({
      schema: 'rukter.product_twin_reconstruction_request.v1',
      sourceViews: sourceViews.map(({ id, label, url }) => ({ id, label, url })),
      capture: normalizeSourceCapture(input.capture),
      output: { format: 'glb', pbr: true },
    }),
    signal: AbortSignal.timeout(12_000),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload || payload.status !== 'verified' || !payload.modelUrl) {
    throw new Error(payload?.error || `AMD 3D worker returned ${response.status}.`)
  }
  return {
    status: 'verified',
    provider: cleanText(payload.provider, 120) || 'AMD GPU worker',
    modelUrl: cleanText(payload.modelUrl, 1200),
    modelFormat: cleanText(payload.modelFormat, 40) || 'glb',
    durationMs: Number(payload.durationMs) || Date.now() - startedAt,
    evidenceId: cleanText(payload.evidenceId, 160),
  }
}

async function handleLaunchKit(req, res) {
  const requestStartedAt = Date.now()
  try {
    const rawBody = await readBody(req)
    const parsed = rawBody ? JSON.parse(rawBody) : {}
    const input = sanitizeLaunchInput(parsed)

    if (!input.brief && !hasProductImage(input)) {
      sendJson(res, 400, { error: 'Add a product image or optional product notes.' })
      return
    }

    const reconstructionPromise = requestAmdProductTwinReconstruction(input)
      .catch((error) => ({ status: 'worker_failed', error: error instanceof Error ? error.message : String(error) }))

    let mode = 'demo_fallback'
    let generatedModel = ''
    let inferenceMeta = {}
    let kit

    try {
      const generated = await callFireworksInference(input)
      if (generated) {
        kit = generated.kit
        generatedModel = generated.model
        inferenceMeta = generated.meta || {}
        mode = 'fireworks_inference'
      }
    } catch (error) {
      kit = fallbackLaunchKit(input)
      mode = 'demo_fallback'
      kit.modelWarning = error instanceof Error ? error.message : String(error)
      inferenceMeta = error?.fireworksMeta || { status: 'fallback', error: kit.modelWarning }
    }

    if (!kit) kit = fallbackLaunchKit(input)

    kit.productDetections = normalizeProductDetections(
      kit.productDetections,
      kit.productAnalysis?.productType || 'Product',
    )
    kit.creativeDirection = normalizeCreativeDirection(kit.creativeDirection)

    const claimSafety = enforceSellerVerifiedClaims(kit, input)
    kit = claimSafety.kit
    inferenceMeta = { ...inferenceMeta, claimSafetyRewrites: claimSafety.rewrites }

    const productAssets = await extractProductAssets(input, kit, publicOrigin(req))
    const reconstruction = await reconstructionPromise
    const productTwin = buildProductTwinManifest({ input, kit, productAssets, reconstruction })
    const draftPayload = buildDraftPayload(input, kit)
    const designQuality = buildDesignQuality(kit, productAssets)
    const responseDurationMs = Date.now() - requestStartedAt
    sendJson(res, 200, {
      mode,
      kit,
      productAssets,
      productTwin,
      designQuality,
      exportManifest: {
        format: 'zip',
        files: [
          'viewer.html',
          'viewer.css',
          'viewer.js',
          'product-twin.json',
          ...productAssets.map((asset) => `images/${asset.fileName}`),
          'vendor/three.module.min.js',
          'vendor/three.core.min.js',
        ],
      },
      draftPayload,
      amdEvidence: buildAmdEvidence(mode, generatedModel, { ...inferenceMeta, responseDurationMs }, input),
    })
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function handleProductImageUpload(req, res) {
  try {
    const rawBody = await readBody(req)
    const parsed = rawBody ? JSON.parse(rawBody) : {}
    const name = cleanText(parsed.name, 120) || 'product-image'
    const type = cleanText(parsed.type, 80)
    const dataUrl = typeof parsed.dataUrl === 'string' ? parsed.dataUrl : ''
    const ext = uploadMimeTypes.get(type)
    if (!ext || !dataUrl.startsWith(`data:${type};base64,`)) {
      sendJson(res, 400, { error: 'A PNG, JPG, WebP, AVIF, or GIF data URL is required.' })
      return
    }
    const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1)
    const buffer = Buffer.from(encoded, 'base64')
    if (!buffer.length || buffer.length > maxUploadBytes) {
      sendJson(res, 400, { error: 'Product image must be between 1 byte and 4 MB.' })
      return
    }
    await mkdir(uploadDir, { recursive: true })
    const id = randomUUID()
    const fileName = `${id}${ext}`
    const filePath = path.join(uploadDir, fileName)
    await writeFile(filePath, buffer)
    const url = `${publicOrigin(req)}/uploads/${fileName}`
    sendJson(res, 200, {
      id,
      name,
      type,
      size: buffer.length,
      url,
    })
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function cleanExportAssets(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, maxProductAssets).map((asset, index) => {
    const dataUrl = typeof asset?.dataUrl === 'string' ? asset.dataUrl : ''
    const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/)
    if (!match) return null
    const buffer = Buffer.from(match[2], 'base64')
    if (!buffer.length || buffer.length > 1_500_000) return null
    const extension = match[1] === 'image/png' ? 'png' : match[1] === 'image/jpeg' ? 'jpg' : 'webp'
    return {
      label: englishSafeText(asset?.label, `Product ${index + 1}`, 80),
      fileName: `product-${index + 1}.${extension}`,
      mimeType: match[1],
      buffer,
      backgroundRemoved: Boolean(asset?.backgroundRemoved),
      foregroundCoverage: Math.round(clampNumber(asset?.foregroundCoverage, 0, 100)),
      componentCount: Math.max(0, Math.round(clampNumber(asset?.componentCount, 0, 1000))),
      matteQuality: Math.round(clampNumber(asset?.matteQuality, 0, 100)),
      edgeDecontaminated: Boolean(asset?.edgeDecontaminated),
      isolationMethod: cleanText(asset?.isolationMethod, 80),
      sourceBbox: normalizeBoundingBox(asset?.sourceBbox),
      rotationDegrees: [0, 90, 180, 270].includes(Number(asset?.rotationDegrees)) ? Number(asset.rotationDegrees) : 0,
    }
  }).filter(Boolean)
}

function buildProductTwinExport(kit, assets, productTwin = {}, modelFileName = '') {
  const asset = assets[0]
  const imagePath = asset ? `images/${asset.fileName}` : ''
  const analysis = kit.productAnalysis || {}
  const label = englishSafeText(productTwin.label, '2.5D Product Twin Preview', 120)
  const truthNote = englishSafeText(productTwin.truthNote, 'Depth and unseen surfaces are not verified from one photo.', 240)
  const productName = englishSafeText(analysis.productType, 'Product Twin', 120)
  const evidence = normalizeList(productTwin.visualEvidence).slice(0, 12).map((item, index) => ({
    id: cleanText(item?.id, 80) || `evidence-${index + 1}`,
    label: englishSafeText(item?.label, 'Visual evidence', 80),
    value: englishSafeText(item?.value, 'Not verifiable', 260),
    status: item?.status === 'observed' ? 'observed' : 'not_verifiable',
  }))
  const safeManifest = {
    schema: 'rukter.product_twin.v1',
    mode: cleanText(productTwin.mode, 80) || 'single_photo_2_5d',
    label,
    truthNote,
    sourceCount: Math.max(1, Number(productTwin.sourceCount) || 1),
    sourceCapture: normalizeSourceCapture(productTwin.sourceCapture),
    preview: {
      kind: modelFileName ? 'model' : 'texture_orbit_2_5d',
      image: imagePath,
      model: modelFileName,
    },
    reconstruction: {
      ...(productTwin.reconstruction || { status: 'preview_only' }),
      modelUrl: modelFileName,
    },
    visualEvidence: evidence,
    product: {
      name: productName,
      image: imagePath,
      backgroundRemoved: Boolean(asset?.backgroundRemoved),
      matteQuality: Number(asset?.matteQuality) || 0,
    },
    generatedAt: new Date().toISOString(),
  }
  const evidenceHtml = evidence.map((item) => `<li><span>${escapeHtml(item.label, 80)}</span><strong>${escapeHtml(item.value, 260)}</strong><i>${item.status === 'observed' ? 'Observed' : 'Not verifiable'}</i></li>`).join('')
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(productName)} - Rukter Product Twin</title><link rel="stylesheet" href="viewer.css"></head><body><header><strong>Rukter<span>.ai</span></strong><p>${escapeHtml(label)}</p></header><main><section class="viewport"><canvas id="twin" data-image="${escapeHtml(imagePath)}" data-model="${escapeHtml(modelFileName)}" data-format="${escapeHtml(path.extname(modelFileName).slice(1))}" aria-label="Interactive ${escapeHtml(label)}"></canvas><div class="status"><strong>${escapeHtml(productName)}</strong><span>${escapeHtml(truthNote)}</span></div></section><aside><h1>Product Twin</h1><p class="mode">${escapeHtml(label)}</p><p>${escapeHtml(truthNote)}</p><h2>Visual evidence</h2><ul>${evidenceHtml || '<li><span>Evidence</span><strong>Not available</strong><i>Not verifiable</i></li>'}</ul></aside></main><script type="module" src="viewer.js"></script></body></html>`
  const css = `:root{color-scheme:dark;font-family:Arial,sans-serif;letter-spacing:0}*{box-sizing:border-box}body{margin:0;background:#090909;color:#fff}header{height:64px;display:flex;align-items:center;justify-content:space-between;padding:0 24px;border-bottom:1px solid #292929}header strong{font-size:22px}header strong span,.mode{color:#ef233c}header p{font-size:13px;color:#aaa}main{display:grid;grid-template-columns:minmax(0,1fr) 390px;height:calc(100vh - 64px)}.viewport{position:relative;min-height:0;background:#e9e8e6}.viewport canvas{width:100%;height:100%;display:block}.status{position:absolute;left:24px;bottom:24px;display:grid;gap:5px;padding:14px;background:rgba(0,0,0,.78)}.status span{max-width:420px;color:#bbb;font-size:12px}aside{overflow:auto;padding:28px 24px;border-left:1px solid #292929}h1{margin:0 0 12px;font-size:26px}aside>p{color:#aaa;line-height:1.5}h2{margin:30px 0 12px;font-size:14px}ul{margin:0;padding:0;list-style:none;border-top:1px solid #292929}li{display:grid;gap:6px;padding:16px 0;border-bottom:1px solid #292929}li span,li i{color:#999;font-size:11px;font-style:normal}li strong{font-size:13px;line-height:1.4}@media(max-width:760px){main{grid-template-columns:1fr;height:auto}.viewport{height:62vh}aside{border-left:0;border-top:1px solid #292929}}`
  const script = `import * as THREE from './vendor/three.module.min.js';const canvas=document.querySelector('#twin'),scene=new THREE.Scene();scene.background=new THREE.Color(0xe9e8e6);const camera=new THREE.PerspectiveCamera(32,1,.1,100);camera.position.set(0,.1,7.2);const renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true});renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.12;const group=new THREE.Group();scene.add(group);if(canvas.dataset.model){let model;if(['usd','usda','usdc','usdz'].includes(canvas.dataset.format)){const{USDLoader}=await import('./vendor/loaders/USDLoader.js');model=await new USDLoader().loadAsync(canvas.dataset.model)}else{const{GLTFLoader}=await import('./vendor/loaders/GLTFLoader.js');model=(await new GLTFLoader().loadAsync(canvas.dataset.model)).scene}const bounds=new THREE.Box3().setFromObject(model),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3()),scale=3.55/Math.max(size.x,size.y,size.z,.001);model.scale.setScalar(scale);model.position.copy(center).multiplyScalar(-scale);group.add(model)}else if(canvas.dataset.image){const texture=await new THREE.TextureLoader().loadAsync(canvas.dataset.image);texture.colorSpace=THREE.SRGBColorSpace;const face=new THREE.Mesh(new THREE.PlaneGeometry(4.2,4.2),new THREE.MeshBasicMaterial({map:texture,transparent:true,alphaTest:.02,side:THREE.DoubleSide}));group.add(face);for(let i=1;i<=10;i++){const edge=new THREE.Mesh(new THREE.PlaneGeometry(4.2,4.2),new THREE.MeshBasicMaterial({map:texture,transparent:true,opacity:.07,alphaTest:.03,side:THREE.DoubleSide,depthWrite:false}));edge.position.z=-i*.018;group.add(edge)}}scene.add(new THREE.HemisphereLight(0xffffff,0x777777,2.4));const key=new THREE.DirectionalLight(0xffffff,3.2);key.position.set(4,6,4);scene.add(key);function resize(){const w=Math.max(1,canvas.clientWidth),h=Math.max(1,canvas.clientHeight);renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix()}new ResizeObserver(resize).observe(canvas);resize();let targetY=0,targetX=0,drag=false,lastX=0,lastY=0;canvas.addEventListener('pointerdown',e=>{drag=true;lastX=e.clientX;lastY=e.clientY;canvas.setPointerCapture(e.pointerId)});canvas.addEventListener('pointermove',e=>{if(!drag)return;targetY+=(e.clientX-lastX)*.006;targetX=Math.max(-.5,Math.min(.5,targetX+(e.clientY-lastY)*.003));lastX=e.clientX;lastY=e.clientY});canvas.addEventListener('pointerup',()=>drag=false);function draw(t){group.rotation.y+=(targetY-group.rotation.y)*.08;group.rotation.x+=(targetX-group.rotation.x)*.08;group.position.y=Math.sin(t*.0008)*.035;renderer.render(scene,camera);requestAnimationFrame(draw)}requestAnimationFrame(draw);`
  return { html, css, script, manifest: JSON.stringify(safeManifest, null, 2) }
}

async function loadPortableProductTwinModel(productTwin, origin) {
  const rawModelUrl = cleanText(productTwin?.preview?.modelUrl, 1200)
  if (productTwin?.preview?.kind !== 'model' || !rawModelUrl) return null

  const modelUrl = new URL(rawModelUrl, origin)
  const format = (cleanText(productTwin?.reconstruction?.modelFormat, 20) || path.extname(modelUrl.pathname).slice(1)).toLowerCase()
  if (!['glb', 'gltf', 'usd', 'usda', 'usdc', 'usdz'].includes(format)) {
    throw new Error(`Unsupported Product Twin model format: ${format || 'unknown'}.`)
  }

  const requestOrigin = new URL(origin).origin
  let buffer
  if (modelUrl.origin === requestOrigin) {
    const relativePath = decodeURIComponent(modelUrl.pathname).replace(/^\/+/, '')
    const root = relativePath.startsWith('uploads/') ? uploadDir : publicDir
    const localPath = path.resolve(root, relativePath.startsWith('uploads/') ? relativePath.slice('uploads/'.length) : relativePath)
    if (!localPath.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Invalid local Product Twin model path.')
    const metadata = await stat(localPath)
    if (metadata.size > 25_000_000) throw new Error('Product Twin model exceeds the 25 MB export limit.')
    buffer = await readFile(localPath)
  } else {
    let workerOrigin = ''
    try { workerOrigin = new URL(process.env.AMD_3D_WORKER_URL || '').origin } catch {}
    if (!workerOrigin || modelUrl.origin !== workerOrigin) {
      throw new Error('Only same-origin or configured AMD worker models can be packaged for export.')
    }
    const response = await fetch(modelUrl, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`Could not download Product Twin model (${response.status}).`)
    const declaredSize = Number(response.headers.get('content-length')) || 0
    if (declaredSize > 25_000_000) throw new Error('Product Twin model exceeds the 25 MB export limit.')
    buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > 25_000_000) throw new Error('Product Twin model exceeds the 25 MB export limit.')
  }
  return { buffer, fileName: `models/product.${format}`, format }
}

const exportCreativeEngineCss = `.hero{position:relative;isolation:isolate}.hero__eyebrow{display:block;margin:0 0 28px;color:var(--product-accent);font-size:12px;font-weight:850;text-transform:uppercase}.hero__copy{position:relative;z-index:8}.hero__visual{position:relative;overflow:hidden;isolation:isolate}.hero__frame{position:absolute;z-index:1;inset:7%;border:1px solid rgba(var(--product-accent-rgb),.3)}.hero__backdrop{position:absolute;z-index:0;top:50%;left:50%;width:120%;color:rgba(var(--product-accent-rgb),.1);font-family:var(--font-display);font-size:150px;font-weight:900;line-height:.76;text-align:center;text-transform:uppercase;transform:translate(-50%,-50%);white-space:nowrap}.hero__visual .hero__image{position:absolute;z-index:3;inset:10%;width:80%;height:80%;object-fit:contain;filter:drop-shadow(0 34px 28px rgba(0,0,0,.23));transform-origin:50% 70%}.hero__image--echo{z-index:2!important;opacity:0;filter:none!important}.hero__meta{position:absolute;z-index:6;top:28px;right:28px;display:grid;max-width:190px;gap:5px;text-align:right}.hero__meta span{font-size:10px;font-weight:800;text-transform:uppercase}.hero__meta strong{font-size:13px;line-height:1.2}.hero__visual canvas{z-index:5}.hero__visual:has(canvas.is-ready) .hero__image{opacity:0}.kinetic-rail{display:flex;width:max-content;min-width:200%;overflow:hidden;border-bottom:1px solid currentColor;background:var(--product-accent);color:#fff}.kinetic-rail>div{display:flex;min-width:50%;align-items:center;gap:28px;padding:19px 28px;animation:kinetic-rail 22s linear infinite}.kinetic-rail span{font-size:15px;font-weight:850;text-transform:uppercase;white-space:nowrap}.kinetic-rail i{font-size:20px;font-style:normal}@keyframes kinetic-rail{to{transform:translateX(-100%)}}.details{display:grid;grid-template-columns:minmax(0,.8fr) minmax(280px,.75fr) minmax(0,1fr);gap:5vw;align-items:start}.details__heading,.details__visual{position:sticky;top:92px}.details__heading h2{max-width:7ch}.details__visual{margin:0;padding:26px;overflow:hidden;border:1px solid currentColor;background:var(--product-paper)}.details__visual:before{position:absolute;inset:18px;border:1px solid rgba(var(--product-accent-rgb),.35);content:""}.details__visual img{position:relative;z-index:1;width:100%;height:360px;object-fit:contain;filter:drop-shadow(0 24px 20px rgba(0,0,0,.17))}.details__visual figcaption{position:relative;z-index:1;padding-top:18px;font-size:11px;line-height:1.45}.details ul{grid-template-columns:1fr;border-top:0;counter-reset:visible-detail}.details li{position:relative;min-height:94px;padding:22px 0 22px 42px;counter-increment:visible-detail}.details li:before{position:absolute;top:25px;left:0;color:var(--product-accent);font-size:11px;font-weight:850;content:"0" counter(visible-detail)}.story{display:grid;grid-template-columns:minmax(0,.85fr) minmax(320px,.65fr);gap:6vw;align-items:center}.story__lead h2{max-width:11ch}.story__visual{position:relative;display:grid;min-height:520px;place-items:center;overflow:hidden;border:1px solid currentColor}.story__visual:before{position:absolute;inset:0;background:var(--product-accent);opacity:.14;content:""}.story__visual img{position:relative;z-index:1;width:78%;height:390px;object-fit:contain;filter:drop-shadow(0 30px 24px rgba(0,0,0,.22));transform:rotate(3deg)}.story__visual span{position:absolute;z-index:2;right:20px;bottom:20px;left:20px;padding-top:14px;border-top:1px solid currentColor;font-size:12px;font-weight:750;line-height:1.35}.story__grid{grid-column:1/-1}.product{position:relative;overflow:hidden}.product:before{position:absolute;inset:18px;border:1px solid rgba(var(--product-accent-rgb),.24);content:""}.product img{position:relative;z-index:1;transition:transform .7s cubic-bezier(.16,1,.3,1)}.product:hover img{transform:scale(1.06) rotate(-1deg)}.final-cta{display:grid;min-height:78vh;grid-template-columns:minmax(0,.72fr) minmax(320px,.58fr);gap:7vw;align-items:center;overflow:hidden}.final-cta>div{position:relative;z-index:2}.final-cta>img{position:relative;z-index:1;width:100%;height:62vh;object-fit:contain;filter:drop-shadow(0 34px 28px rgba(0,0,0,.24));transform:rotate(5deg) scale(1.05)}@media(max-width:760px){.hero__backdrop{font-size:62px}.hero__frame{inset:14px}.hero__meta{top:24px;right:24px}.hero__visual{min-height:62vh!important}.hero__copy{padding:46px 22px 58px!important}.details,.story,.final-cta{display:grid;grid-template-columns:1fr;gap:44px}.details__heading,.details__visual{position:relative;top:auto}.details__visual img{height:70vw}.story__visual{min-height:110vw}.story__visual img{height:82vw}.story__grid{grid-column:auto}.final-cta>img{height:78vw;order:-1}}@media(prefers-reduced-motion:reduce){.kinetic-rail>div,.hero__image{animation:none!important}}`

function exportExperienceCss(experienceId) {
  const styles = {
    'editorial-monograph': 'body{background:var(--product-paper)}.hero{grid-template-columns:minmax(420px,.84fr) minmax(0,1.16fr);padding:0;background:var(--product-paper)}.hero__copy{align-self:stretch;display:flex;justify-content:center;flex-direction:column;max-width:none;padding:7vw 3vw 7vw 6vw}.hero__copy:after{position:absolute;top:7vw;right:0;bottom:7vw;width:1px;background:#111;content:""}.hero h1{max-width:9ch;font-size:96px;line-height:.86}.hero__visual{background:#fff}.hero__image--main{width:72%!important;transform:rotate(-3deg);animation:editorial-object 5s ease-in-out infinite alternate}.hero__image--echo-a{opacity:.12;transform:translateX(-28%) rotate(7deg) scale(.8)}.hero__image--echo-b{opacity:.08;transform:translateX(31%) rotate(-9deg) scale(.72)}.button,.kinetic-rail,.final-cta{background:var(--product-accent)}.signal-bar strong,.section-index{color:var(--product-accent)}.story{background:var(--product-dark);color:#fff}.story p{color:#fff}@keyframes editorial-object{from{transform:translateY(10px) rotate(-3deg)}to{transform:translateY(-14px) rotate(-1deg)}}',
    'botanical-cinema': 'body,.hero,.details,.story,.products,.review,.final-cta,footer{background:var(--product-dark);color:#fff;border-color:rgba(255,255,255,.2)}.hero{display:grid;grid-template-columns:minmax(390px,.72fr) minmax(0,1.28fr);padding:0}.hero__copy{padding:7vw 0 7vw 6vw}.hero h1{max-width:9ch;color:var(--product-contrast);font-size:92px;font-weight:900;line-height:.9;text-transform:uppercase}.hero p,.details li,.review li,footer{color:#c8d0cc}.button,.kinetic-rail{background:var(--product-contrast);color:var(--product-dark)}.signal-bar strong,.product figcaption,.section-index,.details li:before{color:var(--product-contrast)}.product{background:rgba(255,255,255,.04)}.details__visual{background:rgba(var(--product-accent-rgb),.12)}',
    'object-gallery': 'body{background:var(--product-paper)}.hero{display:block;min-height:calc(100vh - 64px);padding:0;background:var(--product-paper)}.hero__visual{min-height:calc(100vh - 64px);background:var(--product-paper)}.hero__copy{position:absolute;z-index:9;bottom:6vw;left:5vw;width:min(520px,38vw)}.hero h1{max-width:9ch;font-family:var(--font-serif);font-size:82px;font-weight:400;line-height:.88}.hero p{color:#111}.button,.kinetic-rail,.final-cta{background:var(--product-accent)}.signal-bar strong,.section-index,.details li:before{color:var(--product-accent)}.details,.story,.products,.review{background:#fff}.products__grid{border-color:var(--product-accent);background:var(--product-accent)}',
    'tactile-commerce': 'body{background:#fff}.hero{grid-template-columns:minmax(400px,.82fr) minmax(0,1.18fr);padding:0;background:var(--product-contrast);color:#111}.hero__copy{max-width:none;padding:7vw 2vw 7vw 5vw}.hero h1{max-width:8ch;font-size:96px;font-weight:900}.hero p{color:#111}.hero__visual{background:#fff}.hero__image--main{width:70%!important;transform:rotate(-4deg)}.hero__image--echo-a{opacity:1;transform:translate(-31%,-23%) rotate(12deg) scale(.48)}.hero__image--echo-b{opacity:1;transform:translate(34%,28%) rotate(8deg) scale(.44)}.button,.kinetic-rail,.final-cta{background:var(--product-accent)}.signal-bar{background:var(--product-contrast);color:#111}.signal-bar strong,.section-index,.details li:before{color:var(--product-accent)}.story,.review{background:var(--product-dark);color:#fff}.story p,.review p,.review li{color:#fff}.products__grid{gap:16px;border:0;background:transparent}.product{border:1px solid #111}',
  }
  return `body{--product-accent:#175cff;--product-accent-rgb:23,92,255;--product-contrast:#ff6b3d;--product-paper:#f4f7ff;--product-dark:#090d18}${exportCreativeEngineCss}${styles[normalizeExperienceId(experienceId)]}.kinetic-rail{width:100%;min-width:0}.kinetic-rail>div{flex:0 0 100%;min-width:100%}`
}

function exportExperienceScript(experienceId) {
  const adaptivePalette = `(async()=>{const image=document.querySelector('.hero__image--main');if(!image)return;await image.decode();const canvas=document.createElement('canvas');canvas.width=48;canvas.height=48;const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0,48,48);const pixels=context.getImageData(0,0,48,48).data,bins=new Map();for(let i=0;i<pixels.length;i+=16){const a=pixels[i+3],r=pixels[i],g=pixels[i+1],b=pixels[i+2],max=Math.max(r,g,b),min=Math.min(r,g,b),chroma=max-min,light=r*.2126+g*.7152+b*.0722;if(a<140||light<24||light>238||chroma<28)continue;const color=[Math.round(r/32)*32,Math.round(g/32)*32,Math.round(b/32)*32],key=color.join(','),entry=bins.get(key)||{color,score:0};entry.score+=1+chroma/80;bins.set(key,entry)}const accent=[...bins.values()].sort((a,b)=>b.score-a.score)[0]?.color||[23,92,255],mix=(target,amount)=>accent.map((value,index)=>Math.round(value+(target[index]-value)*amount)),hex=(color)=>'#'+color.map((value)=>Math.max(0,Math.min(255,value)).toString(16).padStart(2,'0')).join(''),contrast=accent.map((value)=>Math.round(255-value*.72));document.body.style.setProperty('--product-accent',hex(accent));document.body.style.setProperty('--product-accent-rgb',accent.join(','));document.body.style.setProperty('--product-contrast',hex(contrast));document.body.style.setProperty('--product-paper',hex(mix([255,255,255],.94)));document.body.style.setProperty('--product-dark',hex(mix([7,9,12],.82)))})().catch(()=>{});`
  const smoothScroll = `document.querySelectorAll('a[href^="#"]').forEach((link)=>link.addEventListener('click',(event)=>{const target=document.querySelector(link.getAttribute('href'));if(target){event.preventDefault();target.scrollIntoView({behavior:'smooth'});}}));`
  const reveal = `const observer=new IntersectionObserver((entries)=>entries.forEach((entry)=>entry.isIntersecting&&entry.target.classList.add('is-visible')),{threshold:.12});document.querySelectorAll('[data-reveal]').forEach((node)=>observer.observe(node));`
  const gsap = experienceUsesGsap(experienceId)
    ? `window.gsap&&window.gsap.fromTo('.hero__copy>*',{y:44,opacity:0},{y:0,opacity:1,duration:.9,stagger:.1,ease:'power3.out'});window.gsap&&window.gsap.fromTo('.hero__visual',{scale:1.06,opacity:0},{scale:1,opacity:1,duration:1.2,ease:'expo.out'});`
    : ''
  if (!experienceUsesThree(experienceId)) return `${adaptivePalette}${smoothScroll}${reveal}${gsap}`
  const gallery = experienceId === 'object-gallery'
  return `import * as THREE from './vendor/three.module.min.js';${smoothScroll}${reveal}${gsap}const canvas=document.querySelector('#product-scene');const scene=new THREE.Scene();scene.background=new THREE.Color(${gallery ? '0xe9edf4' : '0x050705'});const camera=new THREE.PerspectiveCamera(${gallery ? 31 : 35},1,.1,100);camera.position.set(0,${gallery ? '.2' : '.1'},${gallery ? '9.2' : '7.8'});const renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true});renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=${gallery ? '1.18' : '1.05'};const group=new THREE.Group();scene.add(group);const texture=await new THREE.TextureLoader().loadAsync(canvas.dataset.image);texture.colorSpace=THREE.SRGBColorSpace;const productBaseY=${gallery ? '.24' : '.18'},productSize=${gallery ? '3.7' : '4.05'};const product=new THREE.Mesh(new THREE.PlaneGeometry(productSize,productSize),new THREE.MeshBasicMaterial({map:texture,transparent:true,alphaTest:.02,side:THREE.DoubleSide}));product.position.set(0,productBaseY,.28);product.renderOrder=4;group.add(product);scene.add(new THREE.HemisphereLight(0xffffff,${gallery ? '0xaeb8c8' : '0x0b1408'},${gallery ? '2.2' : '1.5'}));const key=new THREE.DirectionalLight(${gallery ? '0xffffff' : '0x9dff20'},${gallery ? '4.2' : '3.4'});key.position.set(4,7,5);key.castShadow=true;scene.add(key);let pedestal=null,grid=null;${gallery ? 'pedestal=new THREE.Mesh(new THREE.CylinderGeometry(1.58,1.82,.52,64),new THREE.MeshStandardMaterial({color:0x2e63ff,roughness:.72,metalness:.08}));pedestal.position.set(0,-1.58,-.05);pedestal.castShadow=true;pedestal.receiveShadow=true;group.add(pedestal);const floor=new THREE.Mesh(new THREE.PlaneGeometry(18,18),new THREE.MeshStandardMaterial({color:0xdfe5ed,roughness:.92}));floor.rotation.x=-Math.PI/2;floor.position.y=-1.85;floor.receiveShadow=true;scene.add(floor);const wall=new THREE.Mesh(new THREE.PlaneGeometry(18,12),new THREE.MeshStandardMaterial({color:0xf3f5f8,roughness:1}));wall.position.z=-2.7;scene.add(wall);[-3.5,3.5].forEach((x)=>{const column=new THREE.Mesh(new THREE.BoxGeometry(.72,5.8,.72),new THREE.MeshStandardMaterial({color:0xe4e9f0,roughness:.96}));column.position.set(x,.65,-1.8);column.castShadow=true;scene.add(column)});' : 'pedestal=new THREE.Mesh(new THREE.BoxGeometry(3.7,.55,2.55),new THREE.MeshStandardMaterial({color:0x10150f,roughness:.88}));pedestal.position.set(0,-1.72,-.12);pedestal.castShadow=true;pedestal.receiveShadow=true;group.add(pedestal);grid=new THREE.GridHelper(14,20,0x9dff20,0x263122);grid.rotation.x=Math.PI/2;grid.position.z=-2.15;scene.add(grid);const floor=new THREE.Mesh(new THREE.PlaneGeometry(18,18),new THREE.MeshStandardMaterial({color:0x070a06,roughness:.95}));floor.rotation.x=-Math.PI/2;floor.position.y=-2;floor.receiveShadow=true;scene.add(floor);'}function resize(){const w=Math.max(1,canvas.clientWidth),h=Math.max(1,canvas.clientHeight);renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();group.position.x=w/h>1.2?${gallery ? '.42' : '1.65'}:0}new ResizeObserver(resize).observe(canvas);resize();const pointer={x:0,y:0};canvas.addEventListener('pointermove',(event)=>{const rect=canvas.getBoundingClientRect();pointer.x=Math.max(-1,Math.min(1,((event.clientX-rect.left)/Math.max(rect.width,1)-.5)*2));pointer.y=Math.max(-1,Math.min(1,((event.clientY-rect.top)/Math.max(rect.height,1)-.5)*2))});const startedAt=performance.now();function draw(now){const t=(now-startedAt)/1000;group.rotation.y+=(pointer.x*.14-group.rotation.y)*.04;group.rotation.x+=(-pointer.y*.06-group.rotation.x)*.04;product.position.y=productBaseY+Math.sin(t*.9)*.07;if(pedestal&&${gallery})pedestal.rotation.y=t*.08;if(grid)grid.position.x=Math.sin(t*.2)*.25;renderer.render(scene,camera);requestAnimationFrame(draw)}requestAnimationFrame(draw);`
}

function buildExportSiteLegacy(kit, assets, selectedExperienceId = defaultExperienceId) {
  const experienceId = normalizeExperienceId(selectedExperienceId)
  const experience = experienceCatalog[experienceId]
  const analysis = kit.productAnalysis || {}
  const hero = kit.hero || {}
  const seo = kit.seo || {}
  const product = englishSafeText(analysis.productType, 'Product', 100)
  const headline = englishSafeText(hero.headline, 'See the Product Up Close', 120)
  const subheading = englishSafeText(analysis.summary, hero.subheading || 'A visual product overview.', 260)
  const details = normalizeList(analysis.visibleDetails).slice(0, 6)
  const imageMarkup = assets.length
    ? assets.map((asset, index) => `<figure class="product${index === 0 ? ' product--hero' : ''}"><img src="images/${escapeHtml(asset.fileName, 80)}" alt="${escapeHtml(asset.label, 100)}"><figcaption>${escapeHtml(asset.label, 100)}</figcaption></figure>`).join('')
    : '<div class="product product--empty">Add exported product images here.</div>'
  const detailMarkup = details.length
    ? details.map((detail) => `<li>${escapeHtml(detail, 180)}</li>`).join('')
    : '<li>Confirm product specifications before publishing.</li>'
  const usesThree = experienceId === 'webgl-stage' || experienceId === 'spatial-3d'
  const heroVisual = assets[0]
    ? usesThree
      ? `<div class="hero__visual"><img class="hero__image hero__fallback" src="images/${escapeHtml(assets[0].fileName, 80)}" alt="${escapeHtml(assets[0].label, 100)}"><canvas id="product-scene" data-image="images/${escapeHtml(assets[0].fileName, 80)}" aria-label="Interactive product scene"></canvas></div>`
      : `<div class="hero__visual"><img class="hero__image" src="images/${escapeHtml(assets[0].fileName, 80)}" alt="${escapeHtml(assets[0].label, 100)}"></div>`
    : '<div class="hero__visual"></div>'
  const scripts = usesThree
    ? '<script type="module" src="script.js"></script>'
    : experienceId === 'gsap-story'
      ? '<script src="vendor/gsap.min.js"></script><script src="script.js"></script>'
      : '<script src="script.js"></script>'

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(seo.title || product, 180)}</title>
  <meta name="description" content="${escapeHtml(seo.description || subheading, 260)}">
  <link rel="stylesheet" href="styles.css">
</head>
<body data-experience="${experienceId}">
  <header><strong>${escapeHtml(product, 100)}</strong><span>${escapeHtml(experience.name, 60)}</span><a href="#details">Details</a></header>
  <main>
    <section class="hero">
      <div class="hero__copy"><h1>${escapeHtml(headline, 160)}</h1><p>${escapeHtml(subheading, 320)}</p><a class="button" href="#details">${escapeHtml(hero.primaryCta || 'View Details', 60)}</a></div>
      ${heroVisual}
    </section>
    <section id="details" class="details"><h2>What the photo shows</h2><ul>${detailMarkup}</ul></section>
    <section class="products"><h2>Product images</h2><div class="products__grid">${imageMarkup}</div></section>
  </main>
  <footer><span>Generated by Rukter.ai</span><span>Review all specifications before publishing.</span></footer>
  ${scripts}
</body>
</html>`

  const css = `:root{color-scheme:light;--ink:#111;--line:#d9d9d9;--muted:#606060;--red:#e11d2e;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;color:var(--ink);background:#fff}header,footer{display:flex;align-items:center;justify-content:space-between;gap:24px;min-height:64px;padding:0 5vw;border-bottom:1px solid var(--line)}header a,header span,footer{color:var(--muted);font-size:14px;text-decoration:none}.hero{display:grid;grid-template-columns:minmax(0,.9fr) minmax(320px,1.1fr);align-items:center;min-height:calc(100vh - 64px);padding:72px 5vw;border-bottom:1px solid var(--line)}.hero__copy{max-width:720px}.hero h1{margin:0;max-width:11ch;font-size:92px;line-height:.92;letter-spacing:0}.hero p{max-width:600px;margin:28px 0;color:var(--muted);font-size:21px;line-height:1.55}.hero__visual{position:relative;display:grid;min-width:0;min-height:620px;place-items:center}.hero__image{width:100%;height:620px;object-fit:contain}.hero__visual canvas{position:absolute;inset:0;width:100%;height:100%}.hero__visual:has(canvas) .hero__fallback{opacity:0}.button{display:inline-flex;min-height:48px;align-items:center;padding:0 22px;background:var(--ink);color:#fff;text-decoration:none;font-weight:750}.details,.products{padding:96px 5vw;border-bottom:1px solid var(--line)}h2{margin:0 0 40px;font-size:58px;line-height:1}.details ul{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:0;padding:0;list-style:none;border-top:1px solid var(--line)}.details li{padding:22px 22px 22px 0;border-bottom:1px solid var(--line);color:var(--muted);line-height:1.5}.products__grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line)}.product{margin:0;padding:24px;background:#fff}.product img{width:100%;aspect-ratio:1;object-fit:contain}.product figcaption{padding-top:14px;color:var(--muted);font-size:14px}.product--hero{grid-column:span 2}footer{min-height:84px;border:0}${exportExperienceCss(experienceId)}@media(max-width:760px){header span{display:none}.hero,.hero[data-layout]{position:relative;display:grid;grid-template-columns:1fr;min-height:auto;padding:0}.hero__copy{position:relative;left:auto;bottom:auto;width:auto;padding:42px 22px 58px;border:0}.hero h1{font-size:50px}.hero__visual{min-height:52vh;order:-1}.hero__image{height:52vh}.details,.products{padding:64px 22px}.details ul,.products__grid{grid-template-columns:1fr}.product--hero{grid-column:auto}footer{align-items:flex-start;flex-direction:column;justify-content:center}}`
  const portableCss = `${css}body{overflow-x:hidden}@media(max-width:760px){h2{font-size:42px;overflow-wrap:anywhere}}`
  const script = exportExperienceScript(experienceId)
  const detailsJson = JSON.stringify({
    generatedBy: 'Rukter.ai Launch Agent',
    generatedAt: new Date().toISOString(),
    experience: { id: experienceId, name: experience.name, engine: experience.engine },
    creativeDirection: kit.creativeDirection,
    productAnalysis: analysis,
    seo,
    productImages: assets.map((asset) => ({
      file: `images/${asset.fileName}`,
      label: asset.label,
      backgroundRemoved: asset.backgroundRemoved,
      foregroundCoverage: asset.foregroundCoverage,
      componentCount: asset.componentCount,
      matteQuality: asset.matteQuality,
      edgeDecontaminated: asset.edgeDecontaminated,
      isolationMethod: asset.isolationMethod,
      sourceBbox: asset.sourceBbox,
      rotationDegrees: asset.rotationDegrees,
    })),
    publishGuard: 'seller_review_required',
  }, null, 2)
  const vendorFiles = usesThree ? ['three.module.min.js', 'three.core.min.js'] : experienceId === 'gsap-story' ? ['gsap.min.js'] : []
  return { html, css: portableCss, script, detailsJson, vendorFiles, fontFiles: exportFontFiles, experienceId }
}

function buildExportSite(kit, assets, selectedExperienceId = defaultExperienceId) {
  const experienceId = normalizeExperienceId(selectedExperienceId)
  const experience = experienceCatalog[experienceId]
  const analysis = kit.productAnalysis || {}
  const hero = kit.hero || {}
  const brand = kit.brandAngle || {}
  const seo = kit.seo || {}
  const product = englishSafeText(analysis.productType, 'Product', 100)
  const shortProduct = conciseProductName(product)
  const headline = conciseHeroCopy(hero.headline, `${shortProduct}. In focus.`, 9)
  const subheading = conciseHeroCopy(hero.subheading, analysis.summary || 'A visual product overview.', 24)
  const details = normalizeList(analysis.visibleDetails).slice(0, 6)
  const reviewItems = normalizeList(analysis.needsReview).slice(0, 6)
  const layout = normalizeList(kit.storefrontLayout).slice(0, 4)
  const imageMarkup = assets.length
    ? assets.map((asset, index) => `<figure class="product${index === 0 ? ' product--hero' : ''}"><img src="images/${escapeHtml(asset.fileName, 80)}" alt="${escapeHtml(asset.label, 100)}"><figcaption><span>0${index + 1}</span>${escapeHtml(asset.label, 100)}</figcaption></figure>`).join('')
    : '<div class="product product--empty">Add exported product images here.</div>'
  const detailMarkup = (details.length ? details : ['Confirm product specifications before publishing.'])
    .map((detail) => `<li>${escapeHtml(detail, 180)}</li>`)
    .join('')
  const signalMarkup = (details.length ? details : ['Photo analyzed', 'Product isolated', 'Seller review required'])
    .slice(0, 3)
    .map((detail, index) => `<li><strong>0${index + 1}</strong><span>${escapeHtml(detail, 140)}</span></li>`)
    .join('')
  const storyMarkup = (layout.length ? layout : [{ section: 'Product Story', copy: subheading }])
    .map((section, index) => `<article><span>0${index + 1}</span><h3>${escapeHtml(section.section || 'Product section', 100)}</h3><p>${escapeHtml(section.copy || section.purpose || 'Seller-editable product content.', 240)}</p></article>`)
    .join('')
  const reviewMarkup = (reviewItems.length ? reviewItems : ['Confirm product specifications before publishing.'])
    .map((item) => `<li>${escapeHtml(item, 180)}</li>`)
    .join('')
  const usesThree = experienceUsesThree(experienceId)
  const usesGsap = experienceUsesGsap(experienceId)
  const primaryImagePath = assets[0] ? `images/${escapeHtml(assets[0].fileName, 80)}` : ''
  const primaryImageAlt = escapeHtml(assets[0]?.label || product, 100)
  const layeredImages = primaryImagePath
    ? `<img class="hero__image hero__image--echo hero__image--echo-a" src="${primaryImagePath}" alt="" aria-hidden="true"><img class="hero__image hero__image--echo hero__image--echo-b" src="${primaryImagePath}" alt="" aria-hidden="true"><img class="hero__image hero__image--main${usesThree ? ' hero__fallback' : ''}" src="${primaryImagePath}" alt="${primaryImageAlt}">`
    : ''
  const heroVisual = assets[0]
    ? usesThree
      ? `<div class="hero__visual"><span class="hero__backdrop">${escapeHtml(shortProduct, 80)}</span><span class="hero__frame"></span>${layeredImages}<canvas id="product-scene" data-image="${primaryImagePath}" aria-label="Interactive product scene"></canvas><div class="hero__meta"><span>One image</span><strong>${primaryImageAlt}</strong><span>Adaptive art direction</span></div></div>`
      : `<div class="hero__visual"><span class="hero__backdrop">${escapeHtml(shortProduct, 80)}</span><span class="hero__frame"></span>${layeredImages}<div class="hero__meta"><span>One image</span><strong>${primaryImageAlt}</strong><span>Adaptive art direction</span></div></div>`
    : '<div class="hero__visual"></div>'
  const scripts = `${usesGsap ? '<script src="vendor/gsap.min.js"></script>' : ''}${usesThree ? '<script type="module" src="script.js"></script>' : '<script src="script.js"></script>'}`
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(seo.title || product, 180)}</title>
  <meta name="description" content="${escapeHtml(seo.description || subheading, 260)}">
  <link rel="stylesheet" href="styles.css">
</head>
<body data-experience="${experienceId}">
  <header class="site-header"><strong>${escapeHtml(shortProduct, 100)}</strong><span>${escapeHtml(experience.name, 60)}</span><a href="#details">Explore</a></header>
  <main>
    <section class="hero" data-product="${escapeHtml(shortProduct, 80)}">
      <div class="hero__copy"><span class="hero__eyebrow">${escapeHtml(experience.name, 80)} / ${escapeHtml(kit.creativeDirection?.tone || 'Product-led', 120)}</span><h1>${escapeHtml(headline, 160)}</h1><p>${escapeHtml(subheading, 320)}</p><a class="button" href="#details">Explore product</a></div>
      ${heroVisual}
    </section>
    <div class="kinetic-rail" aria-hidden="true"><div><span>${escapeHtml(shortProduct, 80)}</span><i>+</i><span>${escapeHtml(kit.creativeDirection?.tone || 'Product-led', 120)}</span><i>+</i><span>Made from one image</span><i>+</i></div><div><span>${escapeHtml(shortProduct, 80)}</span><i>+</i><span>${escapeHtml(kit.creativeDirection?.tone || 'Product-led', 120)}</span><i>+</i><span>Made from one image</span><i>+</i></div></div>
    <ol class="signal-bar">${signalMarkup}</ol>
    <section id="details" class="details" data-reveal><div class="details__heading"><span class="section-index">02 / Evidence</span><h2>What the photo shows</h2></div>${primaryImagePath ? `<figure class="details__visual"><img src="${primaryImagePath}" alt="${primaryImageAlt}"><figcaption>${escapeHtml(analysis.confidence || 'Photo-grounded product analysis', 180)}</figcaption></figure>` : ''}<ul>${detailMarkup}</ul></section>
    <section class="story" data-reveal><div class="story__lead"><span class="section-index">03 / Page story</span><h2>${escapeHtml(brand.positioning || `${shortProduct} product story`, 160)}</h2></div>${primaryImagePath ? `<div class="story__visual"><img src="${primaryImagePath}" alt=""><span>${escapeHtml(brand.promise || subheading, 240)}</span></div>` : ''}<div class="story__grid">${storyMarkup}</div></section>
    <section class="products" data-reveal><span class="section-index">04 / Product assets</span><h2>Object gallery</h2><div class="products__grid">${imageMarkup}</div></section>
    <section class="review" data-reveal><div><span class="section-index">05 / Seller review</span><h2>Ready for the facts only you can confirm.</h2><p>${escapeHtml(analysis.summary || subheading, 360)}</p></div><div><h3>Confirm before publish</h3><ul>${reviewMarkup}</ul></div></section>
    <section class="final-cta" data-reveal><div><p>Generated from one product photo.</p><h2>Make the final details yours.</h2><a class="button" href="#details">Review the product</a></div>${primaryImagePath ? `<img src="${primaryImagePath}" alt="">` : ''}</section>
  </main>
  <footer><span>Generated by Rukter.ai</span><span>Seller review required before publishing.</span></footer>
  ${scripts}
</body>
</html>`
  const css = `@font-face{font-family:Manrope;src:url("fonts/manrope-variable.woff2") format("woff2");font-style:normal;font-weight:200 800;font-display:swap}@font-face{font-family:Archivo;src:url("fonts/archivo-variable.woff2") format("woff2");font-style:normal;font-weight:100 900;font-display:swap}@font-face{font-family:Instrument Serif;src:url("fonts/instrument-serif.woff2") format("woff2");font-style:normal;font-weight:400;font-display:swap}:root{color-scheme:light;--ink:#111;--line:#d6d8dc;--muted:#5c626a;--font-sans:Manrope,ui-sans-serif,system-ui,sans-serif;--font-display:Archivo,var(--font-sans);--font-serif:"Instrument Serif",Georgia,serif;font-family:var(--font-sans);letter-spacing:0}*{box-sizing:border-box;min-width:0}html{scroll-behavior:smooth}body{margin:0;color:var(--ink);background:#fff}a{color:inherit}.site-header,footer{display:flex;align-items:center;justify-content:space-between;gap:24px;min-height:64px;padding:0 5vw;border-bottom:1px solid var(--line)}.site-header a,.site-header span,footer{color:var(--muted);font-size:13px;text-decoration:none}.hero{display:grid;grid-template-columns:minmax(0,.9fr) minmax(320px,1.1fr);align-items:center;min-height:calc(100vh - 64px);padding:72px 5vw;border-bottom:1px solid var(--line)}.hero__copy{max-width:740px}.section-index{display:block;margin-bottom:30px;font-size:12px;font-weight:850;text-transform:uppercase}.hero h1{margin:0;max-width:11ch;font-family:var(--font-display);font-size:108px;line-height:.88;letter-spacing:0;overflow-wrap:anywhere}.hero p{max-width:600px;margin:30px 0;color:var(--muted);font-size:20px;line-height:1.55}.hero__visual{position:relative;display:grid;min-width:0;min-height:620px;place-items:center}.hero__image{position:relative;z-index:2;width:100%;height:620px;object-fit:contain}.hero__visual canvas{position:absolute;inset:0;width:100%;height:100%}.hero__visual:has(canvas) .hero__fallback{opacity:0}.button{position:relative;z-index:4;display:inline-flex;width:max-content;min-height:50px;align-items:center;padding:0 24px;background:var(--ink);color:#fff;text-decoration:none;font-weight:800}.signal-bar{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:0;padding:0;border-bottom:1px solid var(--line);list-style:none}.signal-bar li{display:flex;gap:18px;min-height:118px;align-items:center;padding:28px 5vw 28px 28px;border-right:1px solid var(--line)}.signal-bar li:last-child{border-right:0}.signal-bar strong{font-size:13px}.signal-bar span{font-weight:750;line-height:1.35}.details,.story,.products,.review,.final-cta{padding:104px 6vw;border-bottom:1px solid var(--line)}h2{margin:0 0 48px;max-width:13ch;font-family:var(--font-display);font-size:76px;line-height:.96;letter-spacing:0}.details ul{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:0;padding:0;border-top:1px solid currentColor;list-style:none}.details li{min-height:112px;padding:24px 24px 24px 0;border-bottom:1px solid var(--line);color:var(--muted);line-height:1.5}.story__grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-top:1px solid currentColor}.story article{padding:26px 24px 40px 0;border-bottom:1px solid currentColor}.story article span{font-size:12px}.story h3{margin:30px 0 12px;font-size:24px;line-height:1.05}.story p,.review p,.review li{color:var(--muted);line-height:1.6}.products__grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line)}.product{margin:0;padding:28px;background:#fff}.product:first-child:last-child{grid-column:1/-1}.product img{width:100%;height:min(64vw,720px);object-fit:contain}.product figcaption{display:flex;gap:14px;padding-top:16px;color:var(--muted);font-size:13px}.review{display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,.72fr);gap:8vw}.review h3{margin:0 0 24px;font-size:24px}.review ul{margin:0;padding-left:20px}.final-cta{min-height:68vh;display:flex;justify-content:center;flex-direction:column}.final-cta p{font-weight:800}.final-cta h2{max-width:10ch}.final-cta .button{width:max-content}footer{min-height:84px;border:0}[data-reveal]{opacity:0;transform:translateY(28px);transition:opacity .7s ease,transform .7s ease}[data-reveal].is-visible{opacity:1;transform:none}${exportExperienceCss(experienceId)}@media(max-width:1100px) and (min-width:761px){.hero h1{font-size:78px}h2{font-size:62px}}@media(max-width:760px){.site-header span{display:none}.hero,.hero[data-layout]{position:relative;display:grid;grid-template-columns:1fr;min-height:auto;padding:0}.hero__copy{position:relative;left:auto;bottom:auto;width:auto;max-width:none;padding:48px 22px 58px;border:0}.hero h1{font-size:52px}.hero__visual{min-height:56vh;order:-1}.hero__image{height:56vh}.hero__visual:after{display:none}.signal-bar,.details,.review{grid-template-columns:1fr}.signal-bar li{border-right:0;border-bottom:1px solid currentColor}.details,.story,.products,.review,.final-cta{padding:68px 22px}.details ul,.story__grid,.products__grid{grid-template-columns:1fr}.product,.product--hero,.product:first-child:last-child{grid-column:auto}.product img{height:70vw}.review{gap:48px}.final-cta{min-height:72vh}footer{align-items:flex-start;flex-direction:column;justify-content:center}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}[data-reveal]{opacity:1;transform:none;transition:none}}`
  const script = exportExperienceScript(experienceId)
  const detailsJson = JSON.stringify({
    generatedBy: 'Rukter.ai Launch Agent',
    generatedAt: new Date().toISOString(),
    experience: { id: experienceId, name: experience.name, engine: experience.engine },
    creativeDirection: kit.creativeDirection,
    productAnalysis: analysis,
    seo,
    productImages: assets.map((asset) => ({
      file: `images/${asset.fileName}`,
      label: asset.label,
      backgroundRemoved: asset.backgroundRemoved,
      foregroundCoverage: asset.foregroundCoverage,
      componentCount: asset.componentCount,
      matteQuality: asset.matteQuality,
      edgeDecontaminated: asset.edgeDecontaminated,
      isolationMethod: asset.isolationMethod,
      sourceBbox: asset.sourceBbox,
      rotationDegrees: asset.rotationDegrees,
    })),
    publishGuard: 'seller_review_required',
  }, null, 2)
  const vendorFiles = [
    ...(usesThree ? ['three.module.min.js', 'three.core.min.js'] : []),
    ...(usesGsap ? ['gsap.min.js'] : []),
  ]
  const portableCss = `${css}body{overflow-x:hidden}@media(max-width:760px){h2{font-size:42px;overflow-wrap:anywhere}}`
  return { html, css: portableCss, script, detailsJson, vendorFiles, fontFiles: exportFontFiles, experienceId }
}

async function handleExport(req, res) {
  try {
    const rawBody = await readBody(req)
    const parsed = rawBody ? JSON.parse(rawBody) : {}
    const kit = parsed.exportKind === 'product-twin'
      ? {
          ...(parsed.kit && typeof parsed.kit === 'object' ? parsed.kit : {}),
          productAnalysis: {
            ...(parsed.kit?.productAnalysis || {}),
            productType: cleanText(parsed.kit?.productAnalysis?.productType, 120) || 'Product Twin',
          },
        }
      : assertLaunchKitSchema(parsed.kit || {})
    const assets = cleanExportAssets(parsed.productAssets)
    if (parsed.exportKind === 'product-twin') {
      const modelAsset = await loadPortableProductTwinModel(parsed.productTwin || {}, publicOrigin(req))
      const twin = buildProductTwinExport(kit, assets, parsed.productTwin || {}, modelAsset?.fileName || '')
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': 'attachment; filename="rukter-product-twin.zip"',
        'cache-control': 'no-store',
      })
      const archive = new ZipArchive({ zlib: { level: 9 } })
      archive.on('error', (error) => res.destroy(error))
      archive.pipe(res)
      archive.append(twin.html, { name: 'viewer.html' })
      archive.append(twin.css, { name: 'viewer.css' })
      archive.append(twin.script, { name: 'viewer.js' })
      archive.append(twin.manifest, { name: 'product-twin.json' })
      if (modelAsset) archive.append(modelAsset.buffer, { name: modelAsset.fileName })
      for (const asset of assets) archive.append(asset.buffer, { name: `images/${asset.fileName}` })
      const vendorFiles = modelAsset
        ? [
            'three.module.min.js',
            'three.core.min.js',
            'loaders/GLTFLoader.js',
            'utils/BufferGeometryUtils.js',
            'utils/SkeletonUtils.js',
            'loaders/USDLoader.js',
            'loaders/usd/USDAParser.js',
            'loaders/usd/USDCParser.js',
            'loaders/usd/USDComposer.js',
            'libs/fflate.module.js',
          ]
        : ['three.module.min.js', 'three.core.min.js']
      for (const vendorFile of vendorFiles) {
        archive.append(await readFile(path.join(publicDir, 'vendor', vendorFile)), { name: `vendor/${vendorFile}` })
      }
      await archive.finalize()
      return
    }
    const site = buildExportSite(kit, assets, parsed.experienceId)
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': 'attachment; filename="rukter-landing-page.zip"',
      'cache-control': 'no-store',
    })
    const archive = new ZipArchive({ zlib: { level: 9 } })
    archive.on('error', (error) => res.destroy(error))
    archive.pipe(res)
    archive.append(site.html, { name: 'index.html' })
    archive.append(site.css, { name: 'styles.css' })
    archive.append(site.script, { name: 'script.js' })
    archive.append(site.detailsJson, { name: 'build-details.json' })
    for (const asset of assets) archive.append(asset.buffer, { name: `images/${asset.fileName}` })
    for (const vendorFile of site.vendorFiles) {
      archive.append(await readFile(path.join(publicDir, 'vendor', vendorFile)), { name: `vendor/${vendorFile}` })
    }
    for (const fontFile of site.fontFiles) {
      archive.append(await readFile(path.join(publicDir, 'fonts', fontFile)), { name: `fonts/${fontFile}` })
    }
    await archive.finalize()
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    } else {
      res.destroy(error)
    }
  }
}

function mcpAccessToken(req) {
  const headerToken = req.headers['x-rukter-mcp-access-token']
  if (typeof headerToken === 'string' && headerToken.trim()) return headerToken.trim()
  const cookieToken = readCookie(req, 'rk_ai_mcp_token')
  if (cookieToken) return cookieToken
  return process.env.RUKTER_MCP_ACCESS_TOKEN || ''
}

function mcpEndpoint() {
  return process.env.RUKTER_MCP_URL || 'https://rukter.com/mcp'
}

function mcpConnectUrl(req) {
  const origin = publicOrigin(req)
  const state = randomToken(24)
  const verifier = randomToken(48)
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.RUKTER_MCP_CLIENT_ID || 'rukter-ai-launch-agent',
    redirect_uri: `${origin}/oauth/callback`,
    resource: process.env.RUKTER_MCP_RESOURCE || 'https://rukter.com/mcp',
    scope: 'theme:read theme:write products:read',
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
    state,
  })
  return {
    url: `${process.env.RUKTER_OAUTH_AUTHORIZE_URL || 'https://rukter.com/oauth/authorize'}?${params.toString()}`,
    state,
    verifier,
  }
}

async function callMcpTool(accessToken, name, args) {
  const id = `rukter-ai-${Date.now()}`
  const response = await fetch(mcpEndpoint(), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = { raw: text }
  }
  if (!response.ok) {
    const error = new Error(`Rukter MCP request failed: ${response.status}`)
    error.status = response.status
    error.payload = payload
    error.wwwAuthenticate = response.headers.get('www-authenticate') || ''
    throw error
  }
  if (payload?.error) {
    const error = new Error(payload.error.message || 'Rukter MCP JSON-RPC error.')
    error.status = 502
    error.payload = payload
    throw error
  }
  return payload
}

async function handleCreateRukterDraft(req, res) {
  try {
    const accessToken = mcpAccessToken(req)
    if (!accessToken) {
      const connect = mcpConnectUrl(req)
      sendJson(res, 401, {
        status: 'auth_required',
        error: 'Rukter MCP access is not connected.',
        connectUrl: connect.url,
      })
      return
    }
    const rawBody = await readBody(req)
    const parsed = rawBody ? JSON.parse(rawBody) : {}
    const input = sanitizeLaunchInput(parsed.input || {})
    const kit = assertLaunchKitSchema(parsed.kit || {})
    const experienceId = normalizeExperienceId(parsed.experienceId)
    const productAssets = normalizeList(parsed.productAssets).slice(0, maxProductAssets).map((asset) => ({
      label: englishSafeText(asset?.label, 'Product', 80),
      url: cleanHttpsUrl(asset?.url),
    })).filter((asset) => asset.url)
    const mcpArguments = buildMcpDraftArguments(input, kit, experienceId, productAssets)
    const mcpResponse = await callMcpTool(accessToken, 'create_home_page_draft', mcpArguments)
    const structured = mcpResponse?.result?.structuredContent || {}
    const dashboardUrl = structured.dashboardUrl || process.env.RUKTER_DASHBOARD_URL || 'https://store-4.rukter.com/dashboard/theme'
    sendJson(res, 200, {
      status: structured.status || 'draft_requested',
      draftSaved: structured.draftSaved === true || structured.status === 'draft_saved',
      dashboardUrl,
      storefrontUrl: structured.storefrontUrl || '',
      mcpTool: 'create_home_page_draft',
      mcpArguments: {
        slug: mcpArguments.slug,
        qualityMode: mcpArguments.qualityMode,
        experienceId: mcpArguments.experienceId,
        experienceName: mcpArguments.experienceName,
        requiredCapabilities: mcpArguments.requiredCapabilities,
        creativeAssetCount: mcpArguments.creativeAssets?.length || 0,
        creativePageSchema: mcpArguments.creativePage?.schema || '',
        creativePageDocumentOnly: mcpArguments.creativePage?.documentOnly === true,
        creativePageAssetSlotCount: mcpArguments.creativePage?.document?.assetSlots?.length || 0,
        creativePageEditableCount: mcpArguments.creativePage?.document?.editables?.length || 0,
      },
      mcp: structured,
    })
  } catch (error) {
    const status = Number(error?.status) || 500
    if (status === 401) {
      const connect = mcpConnectUrl(req)
      sendJson(res, 401, {
        status: 'auth_required',
        error: 'Rukter MCP rejected the access token.',
        connectUrl: connect.url,
        wwwAuthenticate: error.wwwAuthenticate || '',
      })
      return
    }
    sendJson(res, status >= 400 && status < 600 ? status : 500, {
      error: error instanceof Error ? error.message : String(error),
      details: error?.payload || null,
    })
  }
}

async function handleOAuthStart(req, res) {
  const connect = mcpConnectUrl(req)
  redirect(res, connect.url, {
    'set-cookie': [
      cookieHeader('rk_ai_oauth_state', connect.state, { maxAge: 600 }),
      cookieHeader('rk_ai_oauth_verifier', connect.verifier, { maxAge: 600 }),
    ],
  })
}

async function handleOAuthCallback(req, res, url) {
  const state = url.searchParams.get('state') || ''
  const code = url.searchParams.get('code') || ''
  const expectedState = readCookie(req, 'rk_ai_oauth_state')
  const verifier = readCookie(req, 'rk_ai_oauth_verifier')
  if (!state || !code || state !== expectedState || !verifier) {
    redirect(res, '/?mcp=oauth_error')
    return
  }
  const origin = publicOrigin(req)
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: process.env.RUKTER_MCP_CLIENT_ID || 'rukter-ai-launch-agent',
    redirect_uri: `${origin}/oauth/callback`,
    resource: process.env.RUKTER_MCP_RESOURCE || 'https://rukter.com/mcp',
  })
  const response = await fetch(process.env.RUKTER_OAUTH_TOKEN_URL || 'https://rukter.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload?.access_token) {
    redirect(res, '/?mcp=oauth_error')
    return
  }
  redirect(res, '/?mcp=connected', {
    'set-cookie': [
      cookieHeader('rk_ai_mcp_token', payload.access_token, { maxAge: Math.min(oauthCookieMaxAge, Number(payload.expires_in) || oauthCookieMaxAge) }),
      cookieHeader('rk_ai_oauth_state', '', { maxAge: 0 }),
      cookieHeader('rk_ai_oauth_verifier', '', { maxAge: 0 }),
    ],
  })
}

async function serveStatic(req, res, pathname) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname
  const safePath = path.normalize(decodeURIComponent(requestedPath)).replace(/^(\.\.[/\\])+/, '')
  const filePath = path.join(publicDir, safePath)

  if (!filePath.startsWith(publicDir)) {
    sendText(res, 403, 'Forbidden')
    return
  }

  try {
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) {
      sendText(res, 404, 'Not found')
      return
    }
    const ext = path.extname(filePath)
    const body = await readFile(filePath)
    res.writeHead(200, {
      'content-type': mimeTypes[ext] || 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    sendText(res, 404, 'Not found')
  }
}

async function serveAmdWorkerFile(req, res, pathname) {
  const allowedFiles = new Set(['bootstrap.sh', 'app.py', 'requirements.txt', 'run_story_pipeline.py', 'run_story_pipeline.sh'])
  const fileName = path.basename(decodeURIComponent(pathname))
  if (!allowedFiles.has(fileName)) {
    sendText(res, 404, 'Not found')
    return
  }
  try {
    const body = await readFile(path.join(amdWorkerDir, fileName))
    res.writeHead(200, {
      'content-type': fileName.endsWith('.py') ? 'text/x-python; charset=utf-8' : 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=300',
    })
    res.end(body)
  } catch {
    sendText(res, 404, 'Not found')
  }
}

async function serveUpload(req, res, pathname) {
  const fileName = path.basename(pathname)
  const filePath = path.join(uploadDir, fileName)
  if (!filePath.startsWith(uploadDir)) {
    sendText(res, 403, 'Forbidden')
    return
  }
  try {
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) {
      sendText(res, 404, 'Not found')
      return
    }
    const ext = path.extname(filePath)
    const body = await readFile(filePath)
    res.writeHead(200, {
      'content-type': mimeTypes[ext] || 'application/octet-stream',
      'cache-control': 'public, max-age=86400',
    })
    res.end(body)
  } catch {
    sendText(res, 404, 'Not found')
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { status: 'ok', service: 'rukter-ai-launch-agent' })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/config') {
    sendJson(res, 200, {
      dashboardUrl: process.env.RUKTER_DASHBOARD_URL || 'https://store-4.rukter.com/dashboard/theme',
      canonicalUrl: process.env.RUKTER_CANONICAL_URL || 'https://rukter.com',
      fireworksConfigured: Boolean(process.env.FIREWORKS_API_KEY),
      visualCriticConfigured: Boolean(process.env.FIREWORKS_API_KEY),
      amd3dWorkerConfigured: Boolean(process.env.AMD_3D_WORKER_URL),
      productStoryConfigured: true,
      amdStoryOrchestratorConfigured: Boolean(gpuLeaseOrchestrator),
      amdGpuPublicEnabled: storyGpuEnabled(),
      amdGpuRegion: process.env.AMD_GPU_REGION || 'atl1',
      amdGpuSize: process.env.AMD_GPU_SIZE || 'gpu-mi300x1-192gb-devcloud',
      amdGpuLeaseTtlSeconds: gpuLeaseOrchestrator?.leaseTtlSeconds || 1800,
      amdGpuCapacityState: process.env.AMD_GPU_CAPACITY_STATE || 'unknown',
      amdGpuAvailabilityReason: process.env.AMD_GPU_AVAILABILITY_REASON || '',
      gpuZeroIdlePolicy: 'destroy_after_job',
      gpuPersistentPolicy: 'retain_tagged_worker',
      amdGpuPersistentTag: process.env.AMD_GPU_PERSISTENT_TAG || 'rukter-product-story-persistent',
      gpuQueuePolicy: 'fifo',
      gpuQueueConcurrency: 1,
      gpuQueueCapacity: amdStoryQueueMaxSize,
      storyLimits: productStoryLimits,
      visualCriticThreshold: 82,
      visualCriticRepairPasses: 2,
      criticRepairTokens,
      experienceIds: Object.keys(experienceCatalog),
      model: resolveFireworksModel(),
      visionModel: resolveFireworksVisionModel(),
      fallbackModels: resolveFireworksModels().slice(1),
      responseBudgetMs: hackathonResponseBudgetMs,
      requestTimeoutMs: fireworksRuntimeConfig().requestTimeoutMs,
      totalTimeoutMs: fireworksRuntimeConfig().totalTimeoutMs,
      maxTokens: fireworksRuntimeConfig().maxTokens,
      runtimePlatform: `${process.platform}/${process.arch === 'x64' ? 'amd64' : process.arch}`,
      mcpConfigured: Boolean(mcpAccessToken(req)),
      mcpEndpoint: mcpEndpoint(),
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/gpu-capacity') {
    if (!gpuLeaseOrchestrator) {
      sendJson(res, 503, {
        state: 'offline',
        available: false,
        publicEnabled: false,
        reason: 'The AMD GPU orchestrator is not configured.',
        checkedAt: new Date().toISOString(),
      })
      return
    }
    try {
      const capacity = await gpuLeaseOrchestrator.checkCapacity({ refresh: url.searchParams.get('refresh') === '1' })
      sendJson(res, 200, { ...capacity, publicEnabled: storyGpuEnabled(), billing: capacity.billing || 'inactive' })
    } catch (error) {
      sendJson(res, 503, {
        state: 'check_failed',
        available: false,
        publicEnabled: storyGpuEnabled(),
        reason: `AMD capacity could not be verified: ${error instanceof Error ? error.message : String(error)}`,
        checkedAt: new Date().toISOString(),
        billing: 'inactive',
      })
    }
    return
  }

  if (req.method === 'GET' && url.pathname === '/oauth/start') {
    await handleOAuthStart(req, res)
    return
  }

  if (req.method === 'GET' && url.pathname === '/oauth/callback') {
    await handleOAuthCallback(req, res, url)
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/product-image') {
    await handleProductImageUpload(req, res)
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/amd-story-assets') {
    await handleAmdStoryAssetUpload(req, res)
    return
  }

  if (req.method === 'POST' && url.pathname === '/v1/leases') {
    await handleStartGpuLease(req, res)
    return
  }

  const gpuLeaseMatch = url.pathname.match(/^\/v1\/leases\/(\d+)$/)
  if (req.method === 'GET' && gpuLeaseMatch) {
    await handleGetGpuLease(req, res, gpuLeaseMatch[1])
    return
  }

  const gpuLeaseReleaseMatch = url.pathname.match(/^\/v1\/leases\/(\d+)\/release$/)
  if (req.method === 'POST' && gpuLeaseReleaseMatch) {
    await handleReleaseGpuLease(req, res, gpuLeaseReleaseMatch[1])
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/story-jobs') {
    await handleCreateStoryJob(req, res)
    return
  }

  const storyJobMatch = url.pathname.match(/^\/api\/story-jobs\/([^/]+)$/)
  if (req.method === 'GET' && storyJobMatch) {
    handleGetStoryJob(res, decodeURIComponent(storyJobMatch[1]))
    return
  }

  const cancelStoryMatch = url.pathname.match(/^\/api\/story-jobs\/([^/]+)\/cancel$/)
  if (req.method === 'POST' && cancelStoryMatch) {
    const job = storyJobs.get(decodeURIComponent(cancelStoryMatch[1]))
    if (!job) {
      sendJson(res, 404, { error: 'Product Story job not found.' })
      return
    }
    cancelStoryJob(job)
    sendJson(res, 202, publicStoryJob(job))
    return
  }

  const releaseStoryMatch = url.pathname.match(/^\/api\/story-jobs\/([^/]+)\/release-gpu$/)
  if (req.method === 'POST' && releaseStoryMatch) {
    const job = storyJobs.get(decodeURIComponent(releaseStoryMatch[1]))
    if (!job) {
      sendJson(res, 404, { error: 'Product Story job not found.' })
      return
    }
    try {
      await releaseStoryGpu(job)
      sendJson(res, 200, publicStoryJob(job))
    } catch (error) {
      sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/launch-kit') {
    await handleLaunchKit(req, res)
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/design-critique') {
    await handleDesignCritique(req, res)
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/export') {
    await handleExport(req, res)
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/rukter-draft') {
    await handleCreateRukterDraft(req, res)
    return
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method not allowed')
    return
  }

  if (url.pathname.startsWith('/uploads/')) {
    await serveUpload(req, res, url.pathname)
    return
  }

  if (url.pathname.startsWith('/amd-worker/')) {
    await serveAmdWorkerFile(req, res, url.pathname)
    return
  }

  await serveStatic(req, res, url.pathname)
})

server.listen(port, () => {
  console.log(`Rukter.ai Launch Agent running at http://localhost:${port}`)
})

if (gpuLeaseOrchestrator) {
  const reap = () => {
    const activeLeaseIds = [...storyJobs.values()]
      .filter((job) => job.gpu?.billing === 'active_for_job' && job.gpu?.leaseId)
      .map((job) => job.gpu.leaseId)
    return gpuLeaseOrchestrator.reapExpiredLeases({ excludeLeaseIds: activeLeaseIds })
      .then((result) => {
        if (result.released.length) console.log(`Destroyed expired AMD GPU leases: ${result.released.join(', ')}`)
      })
      .catch((error) => console.error(`AMD GPU TTL reaper failed: ${error instanceof Error ? error.message : String(error)}`))
  }
  setTimeout(reap, 5_000).unref()
  setInterval(reap, 5 * 60_000).unref()
}
