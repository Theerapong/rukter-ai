import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  amdCinematicShotRange,
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
  const request = normalizeStoryRequest({
    mode: 'amd_cinematic',
    style: 'social_commerce',
    aspect: '16:9',
    durationSeconds: 30,
    renderResolution: 'detail',
    direction: {
      campaignGoal: 'Launch a new product',
      scenePolicy: 'Clean studio with restrained atmosphere',
      peoplePolicy: 'No people',
    },
    sourceImages: [...sources, ...sources],
  })
  assert.equal(request.mode, 'amd_cinematic')
  assert.equal(request.style, 'social_commerce')
  assert.equal(request.aspect, '16:9')
  assert.equal(request.durationSeconds, 20)
  assert.equal(request.renderResolution, 'detail')
  assert.equal(request.direction.campaignGoal, 'Launch a new product')
  assert.equal(request.direction.scenePolicy, 'Clean studio with restrained atmosphere')
  assert.equal(request.direction.peoplePolicy, 'No people')
  assert.equal(request.sourceImages.length, 8)
})

test('compiles Product DNA and Fireworks shot directives into product-specific prompts', () => {
  const plan = buildProductStoryPlan({
    request: {
      mode: 'amd_cinematic',
      style: 'luxury_editorial',
      direction: {
        campaignGoal: 'Reveal the formulation through visible packaging detail',
        scenePolicy: 'Dark reflective studio',
        peoplePolicy: 'No people',
      },
      sourceImages: sources.slice(0, 2),
    },
    kit: {
      productAnalysis: {
        productType: 'Serum bottle',
        summary: 'An amber glass serum bottle with a black dropper cap.',
        visibleDetails: ['Amber cylindrical bottle', 'Black dropper cap', 'White rectangular front label'],
      },
      productDNA: {
        category: 'Serum bottle',
        identitySummary: 'Amber glass bottle with a black dropper and white front label.',
        identityLocks: ['Amber cylindrical glass body', 'Black ribbed dropper cap'],
        materials: ['amber glass', 'black plastic'],
        colors: ['amber', 'black', 'white'],
        brandMarks: ['small centered leaf mark'],
        visibleText: ['RUKTER SERUM'],
        visualRisks: ['small front-label text may warp'],
      },
      videoDirection: {
        concept: 'Light traces the unchanged bottle geometry.',
        storyArc: 'Establish, inspect, reveal.',
        pacing: 'Slow editorial pacing.',
        scenePolicy: 'Dark reflective studio.',
        shots: [{
          purpose: 'Reveal the front label and dropper construction.',
          sourceViewIndex: 2,
          caption: 'Form, held in light',
          camera: 'Slow five-degree orbit around the label side.',
          lighting: 'Narrow amber rim light with a soft front fill.',
          environment: 'Dark neutral studio with no props.',
          action: 'Move the camera only; keep the bottle stationary.',
          transition: 'Cut on a matching highlight.',
          shotRole: 'macro-to-hero label reveal with a stable complete bottle end frame.',
          lens: '70mm macro product lens resolving into a full bottle view.',
          depthPlan: 'Begin close on label depth, then settle focus across the dropper and bottle.',
          lightingTransition: 'Amber rim light sweeps from cap edge to front label.',
          sceneDynamics: 'Only reflection and background shadow drift behind the bottle.',
          composition: 'Bottle remains large, centered, and complete with clean label margins.',
          stagecraft: 'Dark reflective stage with no props or extra skincare objects.',
          identityLocks: ['White rectangular front-label geometry'],
          allowedChanges: ['camera position', 'studio lighting'],
          forbiddenChanges: ['dropper shape', 'label text'],
          allowPeople: true,
        }],
      },
      hero: {},
      brandAngle: {},
    },
  })

  assert.equal(plan.schema, 'rukter.product_story.v2')
  assert.equal(plan.shots[0].sourceId, sources[1].id)
  assert.equal(plan.director.campaignGoal, 'Reveal the formulation through visible packaging detail')
  assert.match(plan.shots[0].cinematicPrompt, /Amber cylindrical glass body/)
  assert.match(plan.shots[0].cinematicPrompt, /Black dropper cap/)
  assert.match(plan.shots[0].cinematicPrompt, /RUKTER SERUM/)
  assert.match(plan.shots[0].cinematicPrompt, /small front-label text may warp/)
  assert.match(plan.shots[0].cinematicPrompt, /Slow five-degree orbit around the label side/)
  assert.match(plan.shots[0].cinematicPrompt, /Shot role: macro-to-hero label reveal/)
  assert.match(plan.shots[0].cinematicPrompt, /Lens and framing: 70mm macro product lens/)
  assert.match(plan.shots[0].cinematicPrompt, /Depth plan: Begin close on label depth/)
  assert.match(plan.shots[0].cinematicPrompt, /Lighting transition: Amber rim light sweeps/)
  assert.match(plan.shots[0].cinematicPrompt, /Scene dynamics: Only reflection and background shadow drift/)
  assert.match(plan.shots[0].cinematicPrompt, /moving product film, not a still catalog image/)
  assert.equal(plan.shots[0].director.lens, '70mm macro product lens resolving into a full bottle view.')
  assert.equal(plan.shots[0].director.sceneDynamics, 'Only reflection and background shadow drift behind the bottle.')
  assert.match(plan.shots[0].negativePrompt, /changed label text/)
  assert.doesNotMatch(plan.shots[0].negativePrompt, /luggage|wheels|handles|shell pattern/i)
  assert.equal(plan.shots[0].allowPeople, false, 'an explicit no-people request must override the AI directive')

  const contextualPlan = buildProductStoryPlan({
    request: {
      mode: 'amd_cinematic',
      direction: {
        campaignGoal: 'Show scale in a real setting',
        scenePolicy: 'Context is allowed when the product remains unobstructed',
        peoplePolicy: 'Non-occluding people are allowed',
      },
      sourceImages: [sources[0]],
    },
    kit: {
      productAnalysis: { productType: 'Product', visibleDetails: ['Complete visible silhouette'] },
      videoDirection: {
        shots: [{ allowPeople: true }],
      },
      hero: {},
      brandAngle: {},
    },
  })
  assert.equal(contextualPlan.shots[0].allowPeople, true)
  assert.match(contextualPlan.shots[0].cinematicPrompt, /People may appear only as non-occluding context/)
  assert.doesNotMatch(contextualPlan.shots[0].negativePrompt, /(?:^|, )(?:person|human|hand|body part)(?:,|$)/)
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
  assert.equal(plan.shots.length, 2)
  assert.ok(plan.shots.every((shot) => shot.generation.durationSeconds === 4))
  assert.ok(plan.shots.every((shot) => shot.director.renderFramework === 'reference-locked-mcsla-one-move'))
  assert.ok(plan.shots.every((shot) => shot.renderPrompt.split(/\s+/).length <= 100))
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

test('keeps AMD shot counts duration-aware so each render beat has enough time', () => {
  assert.equal(productStoryLimits.minAmdCinematicShots, 2)
  assert.deepEqual(amdCinematicShotRange(8), { min: 2, max: 2 })
  assert.deepEqual(amdCinematicShotRange(15), { min: 3, max: 3 })
  assert.deepEqual(amdCinematicShotRange(20), { min: 4, max: 5 })
  const plan = buildProductStoryPlan({
    request: { mode: 'amd_cinematic', durationSeconds: 15, sourceImages: [sources[0]] },
    kit: {
      productAnalysis: { productType: 'Carry-on suitcase', visibleDetails: ['Ribbed shell'] },
      hero: { headline: 'One source, multiple GPU shots' },
      brandAngle: {},
    },
  })
  assert.equal(plan.shots.length, 3)
  assert.equal(plan.shots.at(-1).endSeconds, 15)
  assert.ok(plan.shots.every((shot) => shot.sourceId === sources[0].id))
  assert.ok(plan.shots.every((shot) => shot.sourceUrl === sources[0].url))
  assert.ok(new Set(plan.shots.map((shot) => shot.motion)).size > 1)
  assert.ok(plan.shots.every((shot) => shot.generation.task === 'text_guided_image_to_video'))
  assert.ok(plan.shots.every((shot) => shot.generation.runtime === 'AMD ROCm'))
  assert.equal(plan.identityGuard.rejectUnverifiedOutput, true)
})

test('uses only evidence-supported directed shots without repeating a group-shot plan', () => {
  const directed = [
    { purpose: 'Establish the unchanged seven-item set.', shotRole: 'locked_group_establish' },
    { purpose: 'Finish on the unchanged complete set.', shotRole: 'locked_group_hero' },
    { purpose: 'Unsupported extra detail.', shotRole: 'unsupported_extra' },
  ]
  const plan = buildProductStoryPlan({
    request: { mode: 'amd_cinematic', durationSeconds: 8, sourceImages: [sources[0]] },
    kit: {
      productAnalysis: { productType: 'Seven-piece luggage set', visibleDetails: ['Seven cases in one fixed arrangement'] },
      productDNA: { identityLocks: ['Seven cases in one fixed arrangement'] },
      videoDirection: { shots: directed },
      hero: {},
      brandAngle: {},
    },
  })
  assert.equal(plan.shots.length, 2)
  assert.deepEqual(plan.shots.map((shot) => shot.director.shotRole), ['locked_group_establish', 'locked_group_hero'])
  assert.ok(plan.shots.every((shot) => /Reference\/color lock: preserve supplied product\/set exactly/i.test(shot.renderPrompt)))
  assert.ok(plan.shots.every((shot) => /exact source hue\/saturation/i.test(shot.renderPrompt)))
  assert.ok(plan.shots.every((shot) => /Group lock: all items inside frame; preserve source spacing\/overlap\/clearance/i.test(shot.renderPrompt)))
  assert.ok(plan.shots.every((shot) => shot.director.requestedCameraPreset !== 'Arc' || shot.director.cameraSafety === 'arc_disabled_without_structured_view_evidence'))
  assert.ok(plan.shots.every((shot) => !shot.renderPrompt.includes('unsupported_extra')))
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
  assert.ok(plan.shots.every((shot) => shot.cinematicPrompt.includes('A precise evidence-led product film')))
  assert.ok(plan.shots.every((shot) => shot.cinematicPrompt.includes('Depth plan:')))
  assert.ok(plan.shots.every((shot) => shot.cinematicPrompt.includes('Lighting transition:')))
  assert.ok(plan.shots.every((shot) => shot.cinematicPrompt.includes('Scene dynamics:')))
  assert.ok(plan.shots.every((shot) => shot.cinematicPrompt.includes('moving product film, not a still catalog image')))
  assert.ok(plan.shots.every((shot) => shot.director.lens))
  assert.ok(plan.shots.every((shot) => shot.cinematicPrompt.includes('Product-centered commercial frame with no people')))
  assert.ok(plan.shots.every((shot) => shot.cinematicPrompt.includes('no hands, no fingers, no arms, no body parts')))
  assert.ok(plan.shots.every((shot) => shot.negativePrompt.includes('hand')))
  assert.ok(plan.shots.every((shot) => shot.negativePrompt.includes('body part')))
  assert.ok(plan.shots.every((shot) => shot.negativePrompt.includes('occluding prop')))
  assert.ok(plan.shots.every((shot) => shot.negativePrompt.includes('foreign object')))
  assert.ok(plan.shots.every((shot) => shot.negativePrompt.includes('extra object at frame edge')))
  assert.ok(plan.shots.every((shot) => shot.negativePrompt.includes('unverified accessory')))
  assert.ok(plan.shots.every((shot) => shot.productPixelPolicy === 'generative_reference_constrained_check_required'))
  assert.equal(plan.identityGuard.generativeProductAlteration, true)
  assert.equal(plan.identityGuard.packagingText, 'ocr_retention_check_required_if_detectable')
})

test('does not negatively prompt real pen, tool, utensil, or lifestyle products out of the scene', () => {
  const plan = buildProductStoryPlan({
    request: {
      mode: 'amd_cinematic',
      direction: {
        campaignGoal: 'Show the writing instrument in use-context detail',
        scenePolicy: 'Lifestyle context on a quiet writing desk',
        peoplePolicy: 'No people or body parts may appear.',
      },
      sourceImages: [sources[0]],
    },
    kit: {
      productAnalysis: { productType: 'Fountain pen', visibleDetails: ['Black barrel', 'Gold nib'] },
      productDNA: {
        category: 'Fountain pen',
        identitySummary: 'Black fountain pen with a gold nib.',
        identityLocks: ['Black barrel', 'Gold nib'],
        components: ['cap', 'barrel', 'nib'],
      },
      videoDirection: {
        concept: 'A precise writing ritual.',
        shots: [{
          environment: 'A quiet writing desk with paper kept behind the unobstructed pen.',
          allowPeople: false,
        }],
      },
    },
  })
  assert.match(plan.shots[0].cinematicPrompt, /quiet writing desk/i)
  assert.match(plan.shots[0].cinematicPrompt, /following the approved scene and environment direction/i)
  assert.doesNotMatch(plan.shots[0].negativePrompt, /\b(?:pen|tools?|utensils?|lifestyle scene|typography)\b/i)
  assert.match(plan.shots[0].cinematicPrompt, /preserve every source-printed mark and character/i)
})

test('preserves non-Latin packaging text as identity evidence instead of transliterating it', () => {
  const plan = buildProductStoryPlan({
    request: { mode: 'amd_cinematic', sourceImages: [sources[0]] },
    kit: {
      productAnalysis: { productType: 'Tea package', visibleDetails: ['Front label'] },
      productDNA: {
        category: 'Tea package',
        identitySummary: 'Green tea package with a centered Thai label.',
        identityLocks: ['Exact front label text: รักไทย'],
        visibleText: ['รักไทย'],
      },
    },
  })
  assert.match(plan.shots[0].cinematicPrompt, /รักไทย/u)
  const serverSource = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  assert.match(serverSource, /productDNA\.visibleText must reproduce the exact visible source characters/)
  assert.match(serverSource, /unicodeIdentityFields/)
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

test('labels ROCm telemetry as an instant worker sample, not an AMD Insights chart', () => {
  const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  const htmlSource = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  assert.match(htmlSource, />ROCm now</)
  assert.match(appSource, /compute now/)
  assert.match(appSource, /VRAM now/)
  assert.match(appSource, /Instant ROCm worker sample from rocm-smi/)
  assert.match(appSource, /AMD DevCloud Insights charts are averaged/)
  assert.match(appSource, /\['ROCm now', friendlyGpuLoad/)
})

test('waits for the live AMD queue to become idle before production deploy', () => {
  const ciSource = readFileSync(new URL('../.gitlab-ci.yml', import.meta.url), 'utf8')
  const waitScript = readFileSync(new URL('../scripts/wait-live-amd-queue-idle.sh', import.meta.url), 'utf8')
  assert.match(ciSource, /bash scripts\/wait-live-amd-queue-idle\.sh/)
  assert.match(waitScript, /api\/story-queue/)
  assert.match(waitScript, /activeJobPresent/)
  assert.match(waitScript, /queuedJobs/)
  assert.match(waitScript, /inProgressJobs/)
  assert.match(waitScript, /awaitingApprovalJobs/)
})

test('keeps the public AMD GPU path on an always-on persistent Droplet', () => {
  const serverSource = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  const smokeSource = readFileSync(new URL('../scripts/smoke.mjs', import.meta.url), 'utf8')
  const bootstrapSource = readFileSync(new URL('../scripts/bootstrap-persistent-amd.sh', import.meta.url), 'utf8')
  const terraformSource = readFileSync(new URL('../infra/terraform/environments/digitalocean/main.tf', import.meta.url), 'utf8')
  assert.match(serverSource, /AMD_GPU_ALWAYS_ON/)
  assert.match(serverSource, /function storyGpuEnabled\(\)[\s\S]*?return amdGpuAlwaysOnEnabled/)
  assert.match(serverSource, /ensurePersistentLease/)
  assert.match(serverSource, /always_on_tagged_worker/)
  assert.match(appSource, /AMD GPU ready/)
  assert.match(appSource, /Always-on AMD MI300X is active/)
  assert.match(smokeSource, /amdGpuAlwaysOn !== true/)
  assert.match(bootstrapSource, /No persistent AMD Droplet is active; creating/)
  assert.match(bootstrapSource, /Refusing to keep duplicate always-on GPUs/)
  assert.match(terraformSource, /AMD_GPU_ALWAYS_ON/)
})

test('builds a truthful Fireworks trace with observations and directed video prompts', () => {
  const plan = buildProductStoryPlan({
    request: { mode: 'amd_cinematic', durationSeconds: 20, sourceImages: sources },
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
  assert.match(trace.prompts[0].prompt, /Observed identity details that must remain visibly unchanged: Ribbed shell; Four spinner wheels/)
  assert.equal(trace.generation.task, 'text_guided_image_to_video')
})

test('gates AMD rendering behind an owner session approval and trusted uploads', () => {
  const serverSource = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  const storySchemaSource = serverSource.slice(
    serverSource.indexOf('const productStoryResponseFormat'),
    serverSource.indexOf('const mimeTypes'),
  )
  const storyPromptSource = serverSource.slice(
    serverSource.indexOf('function buildProductStoryAgentPrompt'),
    serverSource.indexOf('function extractJsonObject'),
  )
  assert.match(serverSource, /ensureStorySession\(req, res\)/)
  assert.match(serverSource, /rk_ai_story_session/)
  assert.match(serverSource, /ownerSessionId/)
  assert.match(serverSource, /ownedStoryJob\(req, res/)
  assert.match(serverSource, /storyUploadGuard\(ownerSessionId\)/)
  assert.match(serverSource, /story_session_upload_rate_limit/)
  assert.match(serverSource, /status = 'awaiting_approval'/)
  assert.match(serverSource, /job\.requestedMode === 'amd_cinematic' && generated\.mode !== 'fireworks_inference'/)
  assert.match(serverSource, /Fireworks Product DNA unavailable; AMD render was not started/)
  assert.match(serverSource, /awaitingApprovalJobs/)
  assert.match(serverSource, /planningJobs/)
  assert.match(serverSource, /inProgressJobs/)
  assert.match(serverSource, /Owner approval window expired/)
  assert.match(serverSource, /\/api\\\/story-jobs\\\/\(\[\^\/\]\+\)\\\/approve/)
  assert.match(serverSource, /amdStoryQueue\.reserve\(job\.id\)/)
  assert.match(serverSource, /code: 'story_approval_stale'/)
  assert.match(serverSource, /normalizeAmdFailureEvidence/)
  assert.match(serverSource, /failureEvidence: job\.failureEvidence/)
  assert.match(serverSource, /validateStorySourceAssets/)
  assert.match(serverSource, /same-origin \/uploads assets/)
  assert.match(serverSource, /productImage: primarySource/)
  assert.doesNotMatch(serverSource, /\.\.\.suppliedProductImage/)
  assert.match(serverSource, /function storyGlobalCreateGuard/)
  assert.match(serverSource, /storyPlanningActiveMax/)
  assert.match(serverSource, /function storyGlobalUploadGuard/)
  assert.match(serverSource, /limitInputPixels: maxUploadPixels/)
  assert.match(serverSource, /ensureUploadStorageCapacity/)
  assert.match(serverSource, /writeUploadWithinQuota\(path\.join\(uploadDir, fileName\), video\)/)
  assert.match(serverSource, /pruneStaleUploads/)
  assert.match(serverSource, /metadata\.pageHeight/)
  assert.match(serverSource, /allowPeople: \{ type: 'boolean' \}/)
  assert.match(serverSource, /defaultFireworksMaxTokens = 4096/)
  assert.match(serverSource, /name: 'RukterProductStoryPlan'/)
  assert.match(serverSource, /required: \['productAnalysis', 'productDNA', 'videoDirection'\]/)
  assert.match(serverSource, /defaultFireworksStoryRequestTimeoutMs = 90_000/)
  assert.match(serverSource, /defaultFireworksStoryTotalTimeoutMs = 95_000/)
  assert.match(serverSource, /const maxAttempts = 1/)
  assert.match(storySchemaSource, /productAnalysis: launchKitResponseFormat/)
  assert.match(storySchemaSource, /productDNA: launchKitResponseFormat/)
  assert.match(storySchemaSource, /videoDirection: launchKitResponseFormat/)
  assert.doesNotMatch(storySchemaSource, /productDetections|storefrontLayout|mediaPlan|seo|socialCaptions/)
  assert.match(storyPromptSource, /Campaign goal:/)
  assert.match(storyPromptSource, /Scene policy:/)
  assert.match(storyPromptSource, /People policy:/)
  assert.match(storyPromptSource, /shotRole, lens, depthPlan, lightingTransition, sceneDynamics, composition, and stagecraft/)
  assert.match(storyPromptSource, /real cinematic progression, not static catalog stills/)
  assert.match(storyPromptSource, /product set or collection/)
  assert.match(storyPromptSource, /full visible group as a locked product identity/)
  assert.match(storyPromptSource, /keep every visible item fully inside the frame/)
  assert.match(storyPromptSource, /Single-view evidence rule/)
  assert.match(storyPromptSource, /do not request an Arc or orbit/)
  assert.match(storyPromptSource, /Treat this as image-to-video/)
  assert.match(storyPromptSource, /exactly one primary camera move per shot/)
  assert.match(storyPromptSource, /Create exactly/)
  assert.doesNotMatch(storyPromptSource, /Create 4 or 5 directed shots/)
  assert.match(serverSource, /lightingTransition: \{ type: 'string' \}/)
  assert.match(serverSource, /sceneDynamics: \{ type: 'string' \}/)
  assert.match(storyPromptSource, /visibleText must reproduce exact source characters/)
  assert.doesNotMatch(storyPromptSource, /storefrontLayout|mediaPlan|socialCaptions|dashboardReview/)
  assert.match(serverSource, /gpuZeroIdlePolicy: amdGpuAlwaysOnEnabled \? 'disabled_for_persistent'/)
  assert.match(serverSource, /amdGpuAutoShutdown: false/)
  assert.match(serverSource, /The persistent AMD worker remains online and credits continue/)
  assert.match(serverSource, /status: 'persistent_online'/)
  assert.match(serverSource, /releasePolicy: 'retain_after_job'/)
  assert.match(serverSource, /if \(!persistent && leaseId && orchestratorUrl\)/)
  assert.doesNotMatch(serverSource, /Cancelling the active render and destroying its AMD GPU/)
  const planningBlock = serverSource.slice(
    serverSource.indexOf("job.status = 'awaiting_approval'"),
    serverSource.indexOf('function approveStoryJob'),
  )
  assert.doesNotMatch(planningBlock, /amdStoryQueue\.(?:reserve|markReady)/)
  assert.doesNotMatch(planningBlock, /GPU billing has not started/)
})

test('always releases an AMD GPU lease after worker failure', async () => {
  const requests = []
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET' })
    if (url.endsWith('/v1/leases')) return new Response(JSON.stringify({ id: 'lease-1', status: 'ready', workerUrl: 'https://worker.example', gpuDevice: 'AMD Instinct MI300X', releasePolicy: 'destroy_after_job' }))
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
  const requests = []
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET' })
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
  assert.ok(!requests.some((request) => request.url.endsWith('/v1/leases/584070698/release')))
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
  assert.ok(!requests.some((request) => request.url.endsWith('/v1/leases/584070698/release')))
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
  assert.ok(!requests.some((request) => request.url.endsWith('/v1/leases/584070698/release')))
})

test('preserves typed worker failure evidence while retaining the persistent GPU', async () => {
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/v1/leases')) {
      return new Response(JSON.stringify({
        id: '584070698',
        status: 'ready',
        workerUrl: 'https://worker.example',
        releasePolicy: 'retain_after_job',
      }))
    }
    if (url.endsWith('/v1/story-jobs') && options.method === 'POST') {
      return new Response(JSON.stringify({ jobId: 'worker-job-evidence' }))
    }
    if (url.endsWith('/v1/story-jobs/worker-job-evidence') && options.method !== 'POST') {
      return new Response(JSON.stringify({
        status: 'failed',
        error: 'Product identity verification failed for shot 1.',
        failureCodes: ['clip_similarity_below_threshold'],
        attemptHistory: [{ attempt: 1, failureCodes: ['clip_similarity_below_threshold'] }],
        evidence: {
          identityVerified: false,
          shot: 1,
          failureCodes: ['clip_similarity_below_threshold'],
          attemptHistory: [{ attempt: 1, clipSimilarityMin: 0.42 }],
        },
      }))
    }
    if (url.endsWith('/v1/story-jobs/worker-job-evidence/cancel')) {
      return new Response(JSON.stringify({ status: 'cancelled' }))
    }
    return new Response('{}')
  }
  await assert.rejects(() => runAmdStoryJob({
    orchestratorUrl: 'https://orchestrator.example',
    story: {},
    sourceImages: sources,
    fetchImpl,
    pollIntervalMs: 1,
  }), (error) => {
    assert.equal(error.code, 'amd_worker_story_failed')
    assert.deepEqual(error.failureCodes, ['clip_similarity_below_threshold'])
    assert.equal(error.evidence.shot, 1)
    assert.equal(error.attemptHistory.length, 1)
    return true
  })
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
        releasePolicy: 'destroy_after_job',
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
    if (url.endsWith('/v1/leases')) return new Response(JSON.stringify({ id: 'lease-2', status: 'ready', workerUrl: 'https://worker.example', releasePolicy: 'destroy_after_job' }))
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
