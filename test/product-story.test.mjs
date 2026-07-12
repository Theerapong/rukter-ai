import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildProductStoryPlan,
  buildStoryAiTrace,
  createStoryActivity,
  normalizeStoryRequest,
  normalizeStoryStyle,
  productStorySteps,
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
  const request = normalizeStoryRequest({ mode: 'amd_cinematic', style: 'social_commerce', aspect: '16:9', durationSeconds: 30, sourceImages: [...sources, ...sources] })
  assert.equal(request.mode, 'amd_cinematic')
  assert.equal(request.style, 'social_commerce')
  assert.equal(request.aspect, '16:9')
  assert.equal(request.durationSeconds, 20)
  assert.equal(request.sourceImages.length, 8)
})

test('falls back to a safe video style for unknown style ids', () => {
  assert.equal(normalizeStoryStyle('unknown'), 'cinematic_film')
})

test('builds a source-preserving five-shot story without inventing product pixels', () => {
  const plan = buildProductStoryPlan({
    request: { mode: 'fast_story', sourceImages: sources },
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
