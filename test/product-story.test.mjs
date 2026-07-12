import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  buildProductStoryPlan,
  buildStoryAiTrace,
  createStoryActivity,
  normalizeStoryRequest,
  normalizeStoryResolution,
  normalizeStoryStyle,
  productStoryLimits,
  productStorySteps,
  shouldSyncAmdQueuePreparation,
} from '../lib/product-story.mjs'
import { runAmdStoryJob } from '../lib/amd-story-orchestrator.mjs'

const sources = Array.from({ length: 5 }, (_, index) => ({
  id: `source-${index + 1}`,
  name: `photo-${index + 1}.jpg`,
  label: `View ${index + 1}`,
  type: 'image/jpeg',
  size: 120000,
  url: `https://rukter.ai/uploads/photo-${index + 1}.jpg`,
}))

test('normalizes Product Story requests to portable source images', () => {
  const request = normalizeStoryRequest({ mode: 'amd_cinematic', style: 'social_commerce', aspect: '16:9', durationSeconds: 30, renderResolution: 'detail', sourceImages: [...sources, ...sources] })
  assert.equal(request.mode, 'amd_cinematic')
  assert.equal(request.style, 'social_commerce')
  assert.equal(request.aspect, '16:9')
  assert.equal(request.durationSeconds, 20)
  assert.equal(request.renderResolution, 'detail')
  assert.equal(request.sourceImages.length, 8)
})

test('falls back to a safe video style for unknown style ids', () => {
  assert.equal(normalizeStoryStyle('unknown'), 'cinematic_film')
})

test('falls back to the fast render resolution for unknown resolution ids', () => {
  assert.equal(normalizeStoryResolution('unknown'), 'fast')
})

test('builds a fast AMD render budget with fewer pixels and shorter shots', () => {
  const plan = buildProductStoryPlan({
    request: { mode: 'amd_cinematic', renderResolution: 'fast', durationSeconds: 8, sourceImages: [sources[0]] },
    kit: {
      productAnalysis: { productType: 'Carry-on suitcase', visibleDetails: ['Ribbed shell'] },
      hero: { headline: 'Fast render proof' },
      brandAngle: {},
    },
  })
  assert.equal(plan.durationSeconds, 8)
  assert.equal(plan.renderResolution, 'fast')
  assert.equal(plan.output.width, 384)
  assert.equal(plan.output.height, 672)
  assert.ok(plan.shots.every((shot) => shot.generation.durationSeconds === 2))
})

test('accepts one source photo for a Product Story', () => {
  assert.equal(productStoryLimits.minImages, 1)
  const plan = buildProductStoryPlan({
    request: { mode: 'fast_story', sourceImages: [sources[0]] },
    kit: {
      productAnalysis: { productType: 'Serum bottle', visibleDetails: ['Front label'] },
      hero: { headline: 'Single view story', primaryCta: 'Explore product' },
      brandAngle: {},
    },
  })
  assert.equal(plan.shots.length, 1)
  assert.equal(plan.shots[0].sourceId, sources[0].id)
  assert.equal(plan.identityGuard.generativeProductAlteration, false)
})

test('keeps a one-photo AMD Cinematic job GPU-active with multiple directed shots', () => {
  assert.equal(productStoryLimits.minAmdCinematicShots, 4)
  const plan = buildProductStoryPlan({
    request: { mode: 'amd_cinematic', durationSeconds: 15, sourceImages: [sources[0]] },
    kit: {
      productAnalysis: { productType: 'Carry-on suitcase', visibleDetails: ['Ribbed shell'] },
      hero: { headline: 'One source, multiple GPU shots' },
      brandAngle: {},
    },
  })
  assert.equal(plan.shots.length, 4)
  assert.equal(plan.shots.at(-1).endSeconds, 15)
  assert.ok(plan.shots.every((shot) => shot.sourceId === sources[0].id))
  assert.ok(plan.shots.every((shot) => shot.sourceUrl === sources[0].url))
  assert.ok(new Set(plan.shots.map((shot) => shot.motion)).size > 1)
  assert.ok(plan.shots.every((shot) => shot.generation.task === 'text_guided_image_to_video'))
  assert.ok(plan.shots.every((shot) => shot.generation.runtime === 'AMD ROCm'))
  assert.equal(plan.identityGuard.rejectUnverifiedOutput, true)
})

test('does not regress an active AMD job back into capacity checking', () => {
  assert.equal(shouldSyncAmdQueuePreparation('waiting_for_gpu'), true)
  assert.equal(shouldSyncAmdQueuePreparation('gpu_starting'), false)
  assert.equal(shouldSyncAmdQueuePreparation('generating'), false)
  assert.equal(shouldSyncAmdQueuePreparation('cancelling'), false)
})

test('builds a source-preserving five-shot story without inventing product pixels', () => {
  const plan = buildProductStoryPlan({
    request: { mode: 'fast_story', durationSeconds: 15, sourceImages: sources },
    kit: {
      productAnalysis: { productType: 'Serum bottle', visibleDetails: ['30 ml glass bottle', 'Dropper cap'] },
      hero: { headline: 'A closer look', primaryCta: 'Explore product' },
      brandAngle: { promise: 'Visible details, clearly presented' },
    },
  })
  assert.equal(plan.shots.length, 5)
  assert.equal(plan.durationSeconds, 15)
  assert.equal(plan.shots.at(-1).endSeconds, 15)
  assert.ok(plan.shots.every((shot) => shot.productPixelPolicy === 'source_preserved'))
  assert.ok(plan.shots.every((shot) => shot.generation.task === 'source_photo_animation'))
  assert.ok(plan.shots.every((shot) => shot.generation.runtime === 'Browser'))
  assert.equal(plan.identityGuard.generativeProductAlteration, false)
})

test('directs AMD Cinematic as verified multi-clip generation rather than browser motion', () => {
  const plan = buildProductStoryPlan({
    request: { mode: 'amd_cinematic', style: 'technical_demo', aspect: '16:9', sourceImages: sources },
    kit: { productAnalysis: { productType: 'Carry-on suitcase' }, hero: {}, brandAngle: {} },
  })
  assert.equal(plan.output.composition, 'amd_gpu_multiclip')
  assert.equal(plan.output.format, 'video/mp4')
  assert.equal(plan.styleLabel, 'Technical Demo')
  assert.equal(plan.identityGuard.rejectUnverifiedOutput, true)
  assert.ok(plan.shots.every((shot) => shot.generation.model === 'Wan2.2-TI2V-5B'))
  assert.ok(plan.shots.every((shot) => shot.generation.task === 'text_guided_image_to_video'))
  assert.ok(plan.shots.every((shot) => shot.generation.runtime === 'AMD ROCm'))
  assert.ok(plan.shots.every((shot) => shot.cinematicPrompt.includes('Clear evidence-led sequencing')))
  assert.ok(plan.shots.every((shot) => shot.cinematicPrompt.includes('No people, hands, fingers')))
  assert.ok(plan.shots.every((shot) => shot.negativePrompt.includes('hand')))
  assert.ok(plan.shots.every((shot) => shot.negativePrompt.includes('unrelated packaging')))
  assert.ok(plan.shots.every((shot) => shot.productPixelPolicy === 'reference_constrained_and_verified'))
})

test('creates a nine-step observable activity contract with an explicit GPU queue', () => {
  const activity = createStoryActivity()
  assert.equal(activity.length, productStorySteps.length)
  assert.deepEqual(activity.map((step) => step.status), Array(9).fill('pending'))
  assert.equal(activity.find((step) => step.id === 'vision_analysis').label, 'Fireworks vision brief')
  assert.equal(activity.find((step) => step.id === 'gpu_queue').label, 'AMD render queue')
  assert.equal(activity.find((step) => step.id === 'motion_shots').label, 'Text-guided video generation')
})

test('keeps Activity trace details collapsed until the user expands them', () => {
  const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  assert.match(appSource, /const expandedActivitySteps = new Set\(\)/)
  assert.doesNotMatch(appSource, /new Set\(\[['"]vision_analysis/)
})

test('does not ask sellers to specify a market in the frontend', () => {
  const storyHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  const storySource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  const twinHtml = readFileSync(new URL('../public/product-twin.html', import.meta.url), 'utf8')
  const twinSource = readFileSync(new URL('../public/product-twin.js', import.meta.url), 'utf8')
  for (const source of [storyHtml, storySource, twinHtml, twinSource]) {
    assert.doesNotMatch(source, /id=["']market["']/)
    assert.doesNotMatch(source, />Market</)
    assert.doesNotMatch(source, /market:\s*market/)
  }
})

test('keeps ready AMD videos from rendering as a black empty player before playback', () => {
  const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  const htmlSource = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  assert.match(htmlSource, /<video id="generatedVideo"[^>]+preload="metadata"/)
  assert.match(appSource, /function firstStoryPoster/)
  assert.match(appSource, /generatedVideo\.poster = poster/)
  assert.match(appSource, /if \(generatedVideo\.getAttribute\('src'\) !== videoUrl\)/)
})

test('lets sellers choose video length and render resolution in the frontend', () => {
  const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  const htmlSource = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  assert.match(htmlSource, /id="durationSeconds"/)
  assert.match(htmlSource, /id="renderResolution"/)
  assert.match(htmlSource, /8 sec · fastest/)
  assert.match(appSource, /durationSeconds: Number\(durationSeconds\.value\) \|\| 8/)
  assert.match(appSource, /renderResolution: renderResolution\.value/)
  assert.match(appSource, /Number\(plan\.output\?\.width\)/)
})

test('shows privacy-safe AMD queue details from the runtime badge', () => {
  const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  const htmlSource = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  const serverSource = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  assert.match(htmlSource, /id="queuePopover"/)
  assert.match(htmlSource, /aria-controls="queuePopover"/)
  assert.match(appSource, /function renderQueueDetails/)
  assert.match(appSource, /\/api\/story-queue/)
  assert.match(appSource, /anonymous job/)
  assert.match(serverSource, /function publicAmdQueueSnapshot/)
  assert.match(serverSource, /other job ids and user details are not exposed/)
})

test('waits for the live AMD queue to become idle before production deploy', () => {
  const ciSource = readFileSync(new URL('../.gitlab-ci.yml', import.meta.url), 'utf8')
  const waitScript = readFileSync(new URL('../scripts/wait-live-amd-queue-idle.sh', import.meta.url), 'utf8')
  assert.match(ciSource, /bash scripts\/wait-live-amd-queue-idle\.sh/)
  assert.match(waitScript, /api\/story-queue/)
  assert.match(waitScript, /activeJobPresent/)
  assert.match(waitScript, /queuedJobs/)
})

test('builds a truthful Fireworks trace with observations and directed video prompts', () => {
  const plan = buildProductStoryPlan({
    request: { mode: 'amd_cinematic', sourceImages: sources },
    kit: {
      productAnalysis: {
        productType: 'Carry-on suitcase',
        summary: 'A ribbed hard-shell suitcase with four spinner wheels.',
        visibleDetails: ['Ribbed shell', 'Four spinner wheels'],
        confidence: 'High for visible form.',
        needsReview: ['Confirm shell material.'],
      },
      hero: {},
      brandAngle: {},
    },
  })
  const trace = buildStoryAiTrace({
    kit: {
      productAnalysis: {
        productType: 'Carry-on suitcase',
        summary: 'A ribbed hard-shell suitcase with four spinner wheels.',
        visibleDetails: ['Ribbed shell', 'Four spinner wheels'],
        confidence: 'High for visible form.',
        needsReview: ['Confirm shell material.'],
      },
    },
    mode: 'fireworks_inference',
    model: 'accounts/fireworks/models/kimi-k2p6',
    sourceCount: 5,
    plan,
    inferenceMeta: { durationMs: 8420, attempts: [{ model: 'accounts/fireworks/models/kimi-k2p6', status: 'ok' }] },
  })
  assert.equal(trace.provider, 'Fireworks AI')
  assert.equal(trace.gemmaActive, false)
  assert.equal(trace.sourceCount, 5)
  assert.equal(trace.inferenceDurationMs, 8420)
  assert.equal(trace.inferenceAttempts, 1)
  assert.deepEqual(trace.observations, ['Ribbed shell', 'Four spinner wheels'])
  assert.equal(trace.prompts.length, 5)
  assert.match(trace.prompts[0].prompt, /exact product identity/)
  assert.equal(trace.generation.task, 'text_guided_image_to_video')
})

test('always releases an AMD GPU lease after worker failure', async () => {
  const requests = []
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET' })
    if (url.endsWith('/v1/leases')) return new Response(JSON.stringify({ id: 'lease-1', status: 'ready', workerUrl: 'https://worker.example', gpuDevice: 'AMD Instinct MI300X' }))
    if (url.endsWith('/v1/story-jobs')) return new Response(JSON.stringify({ error: 'worker failed' }), { status: 500 })
    if (url.endsWith('/release')) return new Response(JSON.stringify({ status: 'released' }))
    return new Response('{}')
  }
  await assert.rejects(() => runAmdStoryJob({
    orchestratorUrl: 'https://orchestrator.example',
    story: {},
    sourceImages: sources,
    fetchImpl,
    pollIntervalMs: 1,
  }), /worker failed/)
  assert.ok(requests.some((request) => request.url.endsWith('/v1/leases/lease-1/release')))
})

test('retains a persistent AMD GPU lease after worker failure', async () => {
  const events = []
  const fetchImpl = async (url) => {
    if (url.endsWith('/v1/leases')) {
      return new Response(JSON.stringify({
        id: '584070698',
        status: 'ready',
        workerUrl: 'https://worker.example',
        gpuDevice: 'AMD Instinct MI300X',
        releasePolicy: 'retain_after_job',
      }))
    }
    if (url.endsWith('/v1/story-jobs')) return new Response(JSON.stringify({ error: 'worker failed' }), { status: 500 })
    if (url.endsWith('/release')) {
      return new Response(JSON.stringify({
        id: '584070698',
        status: 'retained',
        billing: 'persistent_active',
        releasePolicy: 'retain_after_job',
      }))
    }
    return new Response('{}')
  }
  await assert.rejects(() => runAmdStoryJob({
    orchestratorUrl: 'https://orchestrator.example',
    story: {},
    sourceImages: sources,
    fetchImpl,
    pollIntervalMs: 1,
    onEvent: (event) => events.push(event.type),
  }), /worker failed/)
  assert.ok(events.includes('lease_retained'))
  assert.ok(!events.includes('lease_released'))
})

test('cancels the active persistent worker job before retaining the GPU', async () => {
  const requests = []
  const events = []
  const controller = new AbortController()
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET' })
    if (url.endsWith('/v1/leases')) {
      return new Response(JSON.stringify({
        id: '584070698',
        status: 'ready',
        workerUrl: 'https://worker.example',
        releasePolicy: 'retain_after_job',
      }))
    }
    if (url.endsWith('/v1/story-jobs') && options.method === 'POST') {
      setImmediate(() => controller.abort(new Error('Cancelled by user.')))
      return new Response(JSON.stringify({ jobId: 'worker-job-persistent' }))
    }
    if (url.endsWith('/v1/story-jobs/worker-job-persistent/cancel')) {
      return new Response(JSON.stringify({ status: 'cancelled' }))
    }
    if (url.endsWith('/release')) {
      return new Response(JSON.stringify({ status: 'retained', releasePolicy: 'retain_after_job' }))
    }
    return new Response('{}')
  }
  await assert.rejects(() => runAmdStoryJob({
    orchestratorUrl: 'https://orchestrator.example',
    story: {},
    sourceImages: sources,
    signal: controller.signal,
    fetchImpl,
    pollIntervalMs: 1,
    onEvent: (event) => events.push(event.type),
  }), /Cancelled by user/)
  assert.ok(requests.some((request) => request.url.endsWith('/v1/story-jobs/worker-job-persistent/cancel')))
  assert.ok(events.includes('lease_retained'))
})

test('cancels an unfinished persistent worker job after a polling failure', async () => {
  const requests = []
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET' })
    if (url.endsWith('/v1/leases')) {
      return new Response(JSON.stringify({
        id: '584070698',
        status: 'ready',
        workerUrl: 'https://worker.example',
        releasePolicy: 'retain_after_job',
      }))
    }
    if (url.endsWith('/v1/story-jobs') && options.method === 'POST') {
      return new Response(JSON.stringify({ jobId: 'worker-job-unfinished' }))
    }
    if (url.endsWith('/v1/story-jobs/worker-job-unfinished') && options.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'worker status unavailable' }), { status: 502 })
    }
    if (url.endsWith('/v1/story-jobs/worker-job-unfinished/cancel')) {
      return new Response(JSON.stringify({ status: 'cancelled' }))
    }
    if (url.endsWith('/release')) {
      return new Response(JSON.stringify({ status: 'retained', releasePolicy: 'retain_after_job' }))
    }
    return new Response('{}')
  }
  await assert.rejects(() => runAmdStoryJob({
    orchestratorUrl: 'https://orchestrator.example',
    story: {},
    sourceImages: sources,
    fetchImpl,
    pollIntervalMs: 1,
  }), /worker status unavailable/)
  assert.ok(requests.some((request) => request.url.endsWith('/v1/story-jobs/worker-job-unfinished/cancel')))
  assert.ok(requests.some((request) => request.url.endsWith('/v1/leases/584070698/release')))
})

test('polls an asynchronous MI300X lease until the ROCm worker is ready', async () => {
  const events = []
  let leaseReads = 0
  const fetchImpl = async (url) => {
    if (url.endsWith('/v1/leases')) return new Response(JSON.stringify({ id: 'lease-async', status: 'provisioning', phase: 'droplet_starting' }))
    if (url.endsWith('/v1/leases/lease-async')) {
      leaseReads += 1
      return new Response(JSON.stringify({
        id: 'lease-async',
        status: 'ready',
        workerUrl: 'https://worker.example',
        gpuDevice: 'AMD Instinct MI300X',
        rocmVersion: '7.2.4',
      }))
    }
    if (url.endsWith('/v1/story-jobs')) return new Response(JSON.stringify({ error: 'stop after readiness proof' }), { status: 500 })
    if (url.endsWith('/release')) return new Response(JSON.stringify({ status: 'released' }))
    return new Response('{}')
  }
  await assert.rejects(() => runAmdStoryJob({
    orchestratorUrl: 'https://orchestrator.example',
    story: {},
    sourceImages: sources,
    fetchImpl,
    pollIntervalMs: 1,
    onEvent: (event) => events.push(event.type),
  }), /stop after readiness proof/)
  assert.equal(leaseReads, 1)
  assert.ok(events.includes('lease_progress'))
  assert.ok(events.includes('lease_ready'))
  assert.ok(events.includes('lease_released'))
})

test('reports a failed GPU destroy instead of claiming billing stopped', async () => {
  const events = []
  const fetchImpl = async (url) => {
    if (url.endsWith('/v1/leases')) return new Response(JSON.stringify({ id: 'lease-2', status: 'ready', workerUrl: 'https://worker.example' }))
    if (url.endsWith('/v1/story-jobs')) return new Response(JSON.stringify({ jobId: 'worker-job-1' }))
    if (url.includes('/v1/story-jobs/worker-job-1')) {
      return new Response(JSON.stringify({ status: 'ready', videoUrl: 'https://cdn.example/story.mp4', evidence: { identityVerified: true } }))
    }
    if (url.endsWith('/release')) return new Response(JSON.stringify({ error: 'destroy failed' }), { status: 503 })
    return new Response('{}')
  }
  await assert.rejects(() => runAmdStoryJob({
    orchestratorUrl: 'https://orchestrator.example',
    story: {},
    sourceImages: sources,
    fetchImpl,
    pollIntervalMs: 1,
    onEvent: (event) => events.push(event.type),
  }), /release failed/)
  assert.ok(events.includes('lease_release_failed'))
  assert.ok(!events.includes('lease_released'))
})
