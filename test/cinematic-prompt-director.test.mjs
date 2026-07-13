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
    sourceViewCount: 2,
    allowPeople: false,
  })
  assert.equal(result.framework, 'reference-locked-mcsla-one-move')
  assert.equal(result.requestedCameraPreset, 'Arc')
  assert.equal(result.cameraPreset, 'Crane Up')
  assert.ok(result.wordCount <= 100)
  assert.match(result.prompt, /Reference lock: preserve supplied product\/set exactly/)
  assert.match(result.prompt, /Camera: Crane Up, one smooth constant-speed move/)
  assert.match(result.prompt, /Stage: dark neutral studio/)
  assert.match(result.prompt, /background reflection and visible material highlight/)
  assert.match(result.prompt, /Product-only frame/)
  assert.doesNotMatch(result.prompt, /then orbit, then zoom/)
})

test('keeps single-view camera motion on the visible face and preserves full framing', () => {
  const result = compileProductRenderPrompt({
    cameraDirection: 'Arc 35 degrees until the unseen right profile dominates.',
    environment: 'Background darkens slightly to light grey.',
    lightingTransition: 'Cool light becomes 10% warmer by the end frame.',
    sceneDynamics: 'Only light temperature changes while the product remains static.',
    sourceViewCount: 1,
    preserveFullGroup: true,
  })

  assert.equal(result.requestedCameraPreset, 'Arc')
  assert.equal(result.cameraPreset, 'Dolly In')
  assert.match(result.prompt, /Single-view: stay on the visible face/)
  assert.match(result.prompt, /Group framing: keep every item fully visible throughout/)
  assert.match(result.prompt, /Stage: clean neutral product studio/)
  assert.match(result.prompt, /background color temperature shifts once/)
  assert.match(result.prompt, /key-light temperature shift/)
  assert.doesNotMatch(result.prompt, /unseen right profile|Arc 35|dark neutral studio/)
  assert.ok(result.wordCount <= 100)
})

test('does not treat multiple unverified uploads as proof that an Arc can reveal unseen geometry', () => {
  const result = compileProductRenderPrompt({
    cameraDirection: 'Arc around the unseen rear profile.',
    sourceViewCount: 2,
  })
  assert.equal(result.requestedCameraPreset, 'Arc')
  assert.equal(result.cameraPreset, 'Dolly In')
  assert.equal(result.cameraSafety, 'arc_disabled_without_structured_view_evidence')
  assert.doesNotMatch(result.prompt, /unseen rear|Camera: Arc/)
})

test('does not invert negated or stable stage and temperature directions', () => {
  const stable = compileProductRenderPrompt({
    environment: 'Bright studio with no black background and avoid dark tones.',
    lightingTransition: 'Color temperature remains constant and stable.',
    sceneDynamics: 'Do not shift color temperature; background depth moves once.',
  })
  assert.match(stable.prompt, /Stage: high-key neutral studio/)
  assert.doesNotMatch(stable.prompt, /temperature shift|dark neutral studio/)

  const naturalLanguageNegation = compileProductRenderPrompt({
    environment: 'Bright studio; avoid using a dark or black background.',
    lightingTransition: 'Do not allow the color temperature to shift during the shot.',
    sceneDynamics: 'Background depth moves once without changing color temperature.',
  })
  assert.match(naturalLanguageNegation.prompt, /Stage: high-key neutral studio/)
  assert.doesNotMatch(naturalLanguageNegation.prompt, /temperature shift|dark neutral studio/)

  const singleProduct = compileProductRenderPrompt({
    cameraDirection: 'Dolly In for a material detail, then settle on the complete product.',
    preserveFullGroup: false,
  })
  assert.doesNotMatch(singleProduct.prompt, /Group framing/)
  assert.match(singleProduct.prompt, /complete hero frame/)
})

test('keeps Fireworks scene intelligence through bounded product-safe render cues', () => {
  const reflective = compileProductRenderPrompt({
    cameraDirection: 'Slow push-in.',
    environment: 'Dark reflective studio where extra cases materialize.',
    sceneDynamics: 'A specular reflection travels while a handle retracts.',
    sourceViewCount: 2,
  })
  const atmospheric = compileProductRenderPrompt({
    cameraDirection: 'Slow push-in.',
    environment: 'Bright high-key studio.',
    sceneDynamics: 'A thin atmospheric haze shifts behind the shoe.',
    sourceViewCount: 2,
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
