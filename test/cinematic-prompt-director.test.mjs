import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compileProductRenderPrompt,
  productCameraPreset,
} from '../lib/cinematic-prompt-director.mjs'

test('maps freeform product direction to one reliable camera preset', () => {
  assert.equal(productCameraPreset('Orbital dolly 180 degrees around the case.'), 'Arc')
  assert.equal(productCameraPreset('Slow push-in from medium to close.'), 'Dolly In')
  assert.equal(productCameraPreset('Controlled lateral move left.'), 'Dolly Left')
  assert.equal(productCameraPreset('', 'parallax-rise'), 'Crane Up')
})

test('compiles a short reference-locked I2V motion prompt', () => {
  const result = compileProductRenderPrompt({
    cameraDirection: 'Crane up, then orbit, then zoom into the shell badge.',
    motion: 'parallax-rise',
    lens: '50mm equivalent with natural perspective.',
    depthPlan: 'Background falls softly out of focus while the complete set stays sharp.',
    lightingTransition: 'A narrow rim light warms gradually and settles into even hero light.',
    environment: 'Dark reflective studio with no props.',
    sceneDynamics: 'Only reflection and background shadow drift behind the bottle.',
    allowPeople: false,
  })
  assert.equal(result.framework, 'reference-locked-mcsla-one-move')
  assert.equal(result.cameraPreset, 'Arc')
  assert.ok(result.wordCount <= 100)
  assert.match(result.prompt, /Reference lock: keep the provided product or product set unchanged/)
  assert.match(result.prompt, /Camera: Arc, one smooth continuous move/)
  assert.match(result.prompt, /Stage: dark neutral studio/)
  assert.match(result.prompt, /background reflection and visible material highlight/)
  assert.match(result.prompt, /frame remains product-only/)
  assert.doesNotMatch(result.prompt, /then orbit, then zoom/)
})

test('keeps Fireworks scene intelligence through bounded product-safe render cues', () => {
  const reflective = compileProductRenderPrompt({
    cameraDirection: 'Slow push-in.',
    environment: 'Dark reflective studio where extra cases materialize.',
    sceneDynamics: 'A specular reflection travels while a handle retracts.',
  })
  const atmospheric = compileProductRenderPrompt({
    cameraDirection: 'Slow push-in.',
    environment: 'Bright high-key studio.',
    sceneDynamics: 'A thin atmospheric haze shifts behind the shoe.',
  })

  assert.notEqual(reflective.prompt, atmospheric.prompt)
  assert.match(reflective.prompt, /dark neutral studio/)
  assert.match(reflective.prompt, /background reflection/)
  assert.match(atmospheric.prompt, /high-key neutral studio/)
  assert.match(atmospheric.prompt, /background haze/)
  assert.ok(reflective.wordCount <= 100)
  assert.ok(atmospheric.wordCount <= 100)
  assert.doesNotMatch(reflective.prompt, /materialize|retract|extra cases/i)
})
