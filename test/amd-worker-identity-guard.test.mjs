import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const python = process.env.PYTHON_BIN || process.env.PYTHON || 'python3'
const probe = spawnSync(python, ['-c', 'import numpy; from PIL import Image'], { cwd: repoRoot, encoding: 'utf8' })
const skipReason = probe.status === 0 ? false : 'Python image dependencies are unavailable'

function runWorkerScript(script) {
  const result = spawnSync(python, ['-c', script], { cwd: repoRoot, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout)
}

function runIdentityGuard(script) {
  return runWorkerScript(script)
}

test('classifies overlay OCR as annotation instead of product identity', { skip: skipReason }, () => {
  const result = runIdentityGuard(`
import json, sys
sys.path.insert(0, 'amd-worker')
from PIL import Image, ImageDraw
from identity_guard import OcrToken, product_ocr_evidence

image = Image.new('RGB', (400, 400), 'white')
draw = ImageDraw.Draw(image)
draw.rectangle((0, 0, 399, 58), fill=(45, 45, 50))
draw.rectangle((120, 100, 280, 320), fill=(70, 72, 76))
draw.line((80, 360, 320, 360), fill=(220, 40, 40), width=4)
tokens = [
    OcrToken('BANNER999', 112, 18, 120, 24),
    OcrToken('BRAND123', 158, 188, 86, 22),
    OcrToken('CAPTION555', 128, 340, 126, 28),
]
evidence = product_ocr_evidence(image, tokens)
print(json.dumps({
    'productTokens': sorted(evidence['productTokens']),
    'annotationTokens': sorted(evidence['annotationTokens']),
    'mode': evidence['mode'],
}))
`)
  assert.deepEqual(result.productTokens, ['brand123'])
  assert.deepEqual(result.annotationTokens, ['banner999', 'caption555'])
  assert.equal(result.mode, 'product_surface_only')
})

test('keeps OCR as identity evidence when no product foreground can be isolated', { skip: skipReason }, () => {
  const result = runIdentityGuard(`
import json, sys
sys.path.insert(0, 'amd-worker')
from PIL import Image
from identity_guard import OcrToken, product_ocr_evidence

image = Image.new('RGB', (220, 160), 'white')
evidence = product_ocr_evidence(image, [OcrToken('SERIAL999', 60, 60, 92, 24)])
print(json.dumps({
    'productTokens': sorted(evidence['productTokens']),
    'annotationTokens': sorted(evidence['annotationTokens']),
    'mode': evidence['mode'],
}))
`)
  assert.deepEqual(result.productTokens, ['serial999'])
  assert.deepEqual(result.annotationTokens, [])
  assert.equal(result.mode, 'product_surface')
})

test('does not hard-gate identity on a single OCR token', { skip: skipReason }, () => {
  const result = runIdentityGuard(`
import json, sys
sys.path.insert(0, 'amd-worker')
from identity_guard import requires_ocr_retention

print(json.dumps({
    'singleToken': requires_ocr_retention(1, 0.7637, 0.90, 2),
    'twoTokens': requires_ocr_retention(2, 0.7637, 0.90, 2),
    'clipFallback': requires_ocr_retention(3, 0.95, 0.90, 2),
}))
`)
  assert.equal(result.singleToken, false)
  assert.equal(result.twoTokens, true)
  assert.equal(result.clipFallback, false)
})

test('keeps Thai packaging tokens as OCR identity evidence', { skip: skipReason }, () => {
  const result = runIdentityGuard(`
import json, sys
sys.path.insert(0, 'amd-worker')
from identity_guard import OcrToken
print(json.dumps({'tokens': sorted(OcrToken('รักไทย 123', 0, 0, 10, 10).normalized)}, ensure_ascii=False))
`)
  assert.ok(result.tokens.includes('รักไทย'))
  assert.ok(result.tokens.includes('123'))
})

test('detects product color-distribution drift independently of product position', { skip: skipReason }, () => {
  const result = runIdentityGuard(`
import json, sys
sys.path.insert(0, 'amd-worker')
from PIL import Image, ImageDraw
from identity_guard import product_color_evidence

source = Image.new('RGB', (320, 240), 'white')
draw = ImageDraw.Draw(source)
draw.rectangle((30, 40, 145, 210), fill=(35, 105, 190))
draw.rectangle((175, 40, 290, 210), fill=(235, 185, 35))

preserved = Image.new('RGB', (320, 240), 'white')
draw = ImageDraw.Draw(preserved)
draw.rectangle((42, 38, 157, 208), fill=(40, 110, 195))
draw.rectangle((163, 38, 278, 208), fill=(230, 180, 38))

drifted = Image.new('RGB', (320, 240), 'white')
draw = ImageDraw.Draw(drifted)
draw.rectangle((42, 38, 157, 208), fill=(20, 45, 55))
draw.rectangle((163, 38, 278, 208), fill=(65, 38, 20))
draw.ellipse((0, 120, 90, 260), fill=(220, 150, 120))

print(json.dumps({
  'preserved': product_color_evidence(source, [preserved], 0.20),
  'drifted': product_color_evidence(source, [drifted], 0.20),
  'defaultThreshold': product_color_evidence(source, [preserved])['colorDistributionThreshold'],
}))
`)
  assert.equal(result.preserved.colorDistributionRequired, true)
  assert.ok(result.preserved.colorDistributionMin >= 0.20)
  assert.ok(result.drifted.colorDistributionMin < 0.20)
  assert.equal(result.defaultThreshold, 0.48)
})

test('detects a disconnected foreign object entering from a frame edge', { skip: skipReason }, () => {
  const result = runIdentityGuard(`
import json, sys
sys.path.insert(0, 'amd-worker')
from PIL import Image, ImageDraw
from identity_guard import edge_intrusion_evidence

source = Image.new('RGB', (320, 240), 'white')
ImageDraw.Draw(source).rectangle((80, 35, 240, 220), fill=(30, 130, 205))

preserved = source.copy()

shifted_product = Image.new('RGB', (320, 240), 'white')
ImageDraw.Draw(shifted_product).rectangle((0, 35, 250, 220), fill=(30, 130, 205))

contaminated = source.copy()
ImageDraw.Draw(contaminated).rectangle((300, 70, 319, 165), fill=(20, 25, 30))

narrow_source = Image.new('RGB', (320, 240), 'white')
ImageDraw.Draw(narrow_source).rectangle((140, 25, 175, 220), fill=(30, 130, 205))
narrow_panned = Image.new('RGB', (320, 240), 'white')
ImageDraw.Draw(narrow_panned).rectangle((0, 25, 35, 220), fill=(30, 130, 205))

set_source = Image.new('RGB', (320, 240), 'white')
ImageDraw.Draw(set_source).rectangle((55, 45, 115, 210), fill=(30, 130, 205))
ImageDraw.Draw(set_source).rectangle((205, 65, 260, 210), fill=(205, 100, 35))
set_panned = Image.new('RGB', (320, 240), 'white')
ImageDraw.Draw(set_panned).rectangle((20, 45, 80, 210), fill=(30, 130, 205))
ImageDraw.Draw(set_panned).rectangle((264, 65, 319, 210), fill=(205, 100, 35))

gradient = Image.new('RGB', (320, 240), 'white')
gradient_pixels = gradient.load()
for y in range(240):
  for x in range(320):
    value = 245 - round(45 * x / 319)
    gradient_pixels[x, y] = (value, value, value)
ImageDraw.Draw(gradient).rectangle((80, 35, 240, 220), fill=(30, 130, 205))

edge_source = source.copy()
ImageDraw.Draw(edge_source).rectangle((300, 70, 319, 165), fill=(190, 90, 25))
opposite_edge_intrusion = edge_source.copy()
ImageDraw.Draw(opposite_edge_intrusion).rectangle((0, 75, 12, 155), fill=(20, 25, 30))

collision_source = Image.new('RGB', (320, 240), 'white')
ImageDraw.Draw(collision_source).rectangle((130, 90, 190, 150), fill=(30, 130, 205))
lookalike_intrusion = collision_source.copy()
ImageDraw.Draw(lookalike_intrusion).rectangle((0, 85, 70, 155), fill=(30, 130, 205))

lookalike_background = Image.new('RGB', (320, 240), 'white')
ImageDraw.Draw(lookalike_background).rectangle((0, 90, 60, 150), fill=(30, 130, 205))
ImageDraw.Draw(lookalike_background).rectangle((130, 35, 192, 97), fill=(30, 130, 205))

print(json.dumps({
  'preserved': edge_intrusion_evidence(source, [preserved], 0.0025),
  'shiftedProduct': edge_intrusion_evidence(source, [shifted_product], 0.0025),
  'contaminated': edge_intrusion_evidence(source, [contaminated], 0.0025),
  'narrowPanned': edge_intrusion_evidence(narrow_source, [narrow_panned], 0.0025),
  'setPanned': edge_intrusion_evidence(set_source, [set_panned], 0.0025),
  'gradient': edge_intrusion_evidence(source, [gradient], 0.0025),
  'oppositeEdge': edge_intrusion_evidence(edge_source, [opposite_edge_intrusion], 0.0025),
  'lookalikeIntrusion': edge_intrusion_evidence(collision_source, [lookalike_intrusion], 0.0025),
  'lookalikeBackground': edge_intrusion_evidence(collision_source, [lookalike_background], 0.0025),
}))
`)

  assert.equal(result.preserved.edgeIntrusionDetected, false)
  assert.equal(result.shiftedProduct.edgeIntrusionDetected, false)
  assert.equal(result.narrowPanned.edgeIntrusionDetected, false)
  assert.equal(result.setPanned.edgeIntrusionDetected, false)
  assert.equal(result.gradient.edgeIntrusionDetected, false)
  assert.equal(result.contaminated.edgeIntrusionDetected, true)
  assert.ok(result.contaminated.edgeIntrusionAreaMax > 0.0025)
  assert.deepEqual(result.contaminated.edgeIntrusionEdges, ['right'])
  assert.equal(result.contaminated.edgeIntrusionComponentCount, 1)
  assert.equal(result.contaminated.edgeIntrusionUnmatchedComponents.length, 1)
  assert.equal(result.oppositeEdge.edgeIntrusionDetected, true)
  assert.deepEqual(result.oppositeEdge.edgeIntrusionEdges, ['left'])
  assert.equal(result.lookalikeIntrusion.edgeIntrusionDetected, true)
  assert.deepEqual(result.lookalikeIntrusion.edgeIntrusionEdges, ['left'])
  assert.equal(result.lookalikeBackground.edgeIntrusionDetected, false)
})

test('ships the identity guard helper through every AMD worker bootstrap path', () => {
  const dockerfile = readFileSync(path.join(repoRoot, 'amd-worker', 'Dockerfile'), 'utf8')
  const bootstrap = readFileSync(path.join(repoRoot, 'amd-worker', 'bootstrap.sh'), 'utf8')
  const server = readFileSync(path.join(repoRoot, 'server.mjs'), 'utf8')
  assert.match(dockerfile, /identity_guard\.py/)
  assert.match(dockerfile, /tesseract-ocr-tha/)
  assert.match(bootstrap, /identity_guard\.py/)
  assert.match(bootstrap, /tesseract-ocr-tha/)
  assert.match(server, /identity_guard\.py/)
  const identityGuard = readFileSync(path.join(repoRoot, 'amd-worker', 'identity_guard.py'), 'utf8')
  assert.match(identityGuard, /OCR_LANGUAGES/)
  assert.match(identityGuard, /\\u0E00-\\u0E7F/)
})

test('ships live GPU telemetry through every AMD worker bootstrap path', () => {
  const dockerfile = readFileSync(path.join(repoRoot, 'amd-worker', 'Dockerfile'), 'utf8')
  const bootstrap = readFileSync(path.join(repoRoot, 'amd-worker', 'bootstrap.sh'), 'utf8')
  const app = readFileSync(path.join(repoRoot, 'amd-worker', 'app.py'), 'utf8')
  const server = readFileSync(path.join(repoRoot, 'server.mjs'), 'utf8')
  assert.match(dockerfile, /gpu_telemetry\.py/)
  assert.match(bootstrap, /gpu_telemetry\.py/)
  assert.match(app, /collect_rocm_smi_metrics/)
  assert.match(server, /gpu_telemetry\.py/)
})

test('worker uses requested story output dimensions and short render shots', () => {
  const pipeline = readFileSync(path.join(repoRoot, 'amd-worker', 'run_story_pipeline.py'), 'utf8')
  const app = readFileSync(path.join(repoRoot, 'amd-worker', 'app.py'), 'utf8')
  assert.match(pipeline, /output = story\.get\("output", \{\}\)/)
  assert.match(pipeline, /output\.get\("width"\)/)
  assert.match(pipeline, /output\.get\("height"\)/)
  assert.match(pipeline, /max\(2, min\(5/)
  assert.match(pipeline, /STORY_INFERENCE_STEP_BUDGET_PER_PASS/)
  assert.match(pipeline, /story_inference_steps\(total_shots\)/)
  assert.match(pipeline, /def trim_uniform_background/)
  assert.match(pipeline, /sensitive_threshold/)
  assert.match(pipeline, /boundary_drift/)
  assert.match(pipeline, /identity_source = resize_contain\(source_image, width, height, trim_background=False\)/)
  assert.match(pipeline, /identity_evidence\(identity_source, frames/)
  assert.match(pipeline, /product_color_distribution_drift/)
  assert.match(pipeline, /WAN_COLOR_DISTRIBUTION_THRESHOLD", "0\.48"/)
  assert.match(pipeline, /product_color_evidence\(source, samples, COLOR_DISTRIBUTION_THRESHOLD\)/)
  assert.match(pipeline, /foreign_edge_intrusion/)
  assert.match(pipeline, /edge_intrusion_evidence\(source, samples, EDGE_INTRUSION_THRESHOLD\)/)
  assert.match(pipeline, /shot\.get\("renderPrompt"\) or shot\.get\("cinematicPrompt"/)
  assert.match(pipeline, /shot\.get\("renderPrompt"\) or shot\["cinematicPrompt"\]/)
  assert.match(pipeline, /first_attempt_identity_directive\(identity_locks, retrying\)/)
  assert.ok(
    pipeline.indexOf('first_attempt_identity_directive(identity_locks, retrying)')
      < pipeline.indexOf('apply_people_policy(prompt, negative_prompt, allow_people)'),
  )
  assert.match(app, /STORY_PIPELINE_TIMEOUT_SECONDS/)
  assert.match(app, /cinematicPrompt: str = Field\(min_length=1, max_length=12_000\)/)
  assert.doesNotMatch(app, /timeout=18 \* 60/)
})

test('background trim rejects a low-contrast product crop driven by one dark component', { skip: skipReason }, () => {
  const result = runWorkerScript(`
import __future__, ast, json, numpy as np
from PIL import Image, ImageDraw

source = open('amd-worker/run_story_pipeline.py', encoding='utf-8').read()
tree = ast.parse(source)
selected = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'trim_uniform_background']
namespace = {
    'np': np,
    'Image': Image,
    'BACKGROUND_TRIM_TOLERANCE': 18,
    'BACKGROUND_TRIM_PADDING_RATIO': 0.06,
}
module = ast.Module(body=selected, type_ignores=[])
exec(compile(ast.fix_missing_locations(module), 'amd-worker/run_story_pipeline.py', 'exec', flags=__future__.annotations.compiler_flag), namespace)
trim = namespace['trim_uniform_background']

light_product = Image.new('RGB', (300, 300), 'white')
draw = ImageDraw.Draw(light_product)
draw.rectangle((45, 70, 255, 270), fill=(245, 245, 245))
draw.rectangle((105, 20, 195, 80), fill=(45, 45, 45))
protected = trim(light_product)

panel_product = Image.new('RGB', (300, 300), 'white')
draw = ImageDraw.Draw(panel_product)
draw.rectangle((20, 20, 280, 280), fill=(245, 245, 245))
draw.rectangle((75, 75, 225, 225), fill=(45, 45, 45))
panel_protected = trim(panel_product)

confident_product = Image.new('RGB', (400, 300), 'white')
ImageDraw.Draw(confident_product).rectangle((100, 60, 300, 240), fill=(70, 70, 70))
trimmed = trim(confident_product)
print(json.dumps({'protected': protected.size, 'panelProtected': panel_protected.size, 'trimmed': trimmed.size}))
`)
  assert.deepEqual(result.protected, [300, 300])
  assert.deepEqual(result.panelProtected, [300, 300])
  assert.ok(result.trimmed[0] < 400)
  assert.ok(result.trimmed[1] < 300)
})

test('worker rejects human hands and body parts as product-story contamination', () => {
  const pipeline = readFileSync(path.join(repoRoot, 'amd-worker', 'run_story_pipeline.py'), 'utf8')
  const storySource = readFileSync(path.join(repoRoot, 'lib', 'product-story.mjs'), 'utf8')
  assert.match(pipeline, /HUMAN_CONTAMINATION_PROMPTS/)
  assert.match(pipeline, /HUMAN_OCCLUSION_PROMPTS/)
  assert.match(pipeline, /human_contamination_evidence/)
  assert.match(pipeline, /human_contamination_decision/)
  assert.match(pipeline, /humanContaminationDetected/)
  assert.match(pipeline, /FAILURE_CODE_HUMAN_CONTAMINATION/)
  assert.match(pipeline, /detected = decision\["detected"\]/)
  assert.match(pipeline, /humanContaminationSourceDelta/)
  assert.match(pipeline, /"humanPolicy": "background_only"/)
  assert.match(storySource, /Product-centered commercial frame with no people/)
  assert.match(storySource, /no hands, no fingers, no arms, no body parts/)
})

test('detects newly introduced human presence relative to the source without rejecting allowed background people', { skip: skipReason }, () => {
  const result = runWorkerScript(`
import __future__, ast, json, numpy as np
source = open('amd-worker/run_story_pipeline.py', encoding='utf-8').read()
tree = ast.parse(source)
selected = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'human_contamination_decision']
namespace = {
    'np': np,
    'HUMAN_CONTAMINATION_THRESHOLD': 0.225,
    'HUMAN_CONTAMINATION_MARGIN': 0.012,
    'HUMAN_CONTAMINATION_SOURCE_DELTA': 0.015,
}
module = ast.Module(body=selected, type_ignores=[])
exec(compile(ast.fix_missing_locations(module), 'amd-worker/run_story_pipeline.py', 'exec', flags=__future__.annotations.compiler_flag), namespace)
decide = namespace['human_contamination_decision']
new_character = decide(
    np.array([[0.2000, 0.1900], [0.2350, 0.2371]]),
    np.array([[0.1400], [0.2535]]),
    np.array([0.2300, 0.1800]),
    False,
)
same_as_source = decide(np.array([[0.2500, 0.1900]]), np.array([[0.2000]]), np.array([0.2490, 0.1800]), False)
edge_hair_regression = decide(np.array([[0.2258, 0.1900]]), np.array([[0.2405]]), np.array([0.2093, 0.1800]), False)
below_absolute_threshold = decide(np.array([[0.2249, 0.1900]]), np.array([[0.2000]]), np.array([0.1900, 0.1800]), False)
below_novelty_delta = decide(np.array([[0.2258, 0.1900]]), np.array([[0.2405]]), np.array([0.2110, 0.1800]), False)
allowed_background = decide(np.array([[0.2371, 0.1900]]), np.array([[0.2535]]), np.array([0.2137, 0.1800]), True)
allowed_occlusion = decide(np.array([[0.2500, 0.1900]]), np.array([[0.2200]]), np.array([0.2137, 0.1800]), True)
allowed_new_occlusion = decide(np.array([[0.2700, 0.1900]]), np.array([[0.2200]]), np.array([0.2400, 0.1800]), True)
allowed_unchanged_source = decide(np.array([[0.2410, 0.1900]]), np.array([[0.2000]]), np.array([0.2400, 0.1800]), True)
print(json.dumps({
    'newCharacter': new_character['detected'],
    'newCharacterIndex': new_character['worstIndex'],
    'newCharacterPromptIndex': new_character['worstPromptIndex'],
    'newCharacterSourceDelta': new_character['sourceDelta'],
    'sameAsSource': same_as_source['detected'],
    'edgeHairRegression': edge_hair_regression['detected'],
    'edgeHairSourceDelta': edge_hair_regression['sourceDelta'],
    'belowAbsoluteThreshold': below_absolute_threshold['detected'],
    'belowNoveltyDelta': below_novelty_delta['detected'],
    'allowedBackground': allowed_background['detected'],
    'allowedOcclusion': allowed_occlusion['detected'],
    'allowedNewOcclusion': allowed_new_occlusion['detected'],
    'allowedUnchangedSource': allowed_unchanged_source['detected'],
}))
`)

  assert.equal(result.newCharacter, true)
  assert.equal(result.newCharacterIndex, 1)
  assert.equal(result.newCharacterPromptIndex, 1)
  assert.ok(result.newCharacterSourceDelta > 0.05)
  assert.equal(result.sameAsSource, false)
  assert.equal(result.edgeHairRegression, true)
  assert.ok(result.edgeHairSourceDelta > 0.015)
  assert.equal(result.belowAbsoluteThreshold, false)
  assert.equal(result.belowNoveltyDelta, false)
  assert.equal(result.allowedBackground, false)
  assert.equal(result.allowedOcclusion, true)
  assert.equal(result.allowedNewOcclusion, true)
  assert.equal(result.allowedUnchangedSource, false)
})

test('uses positive-only clean prompts and covers illustrated people entering from frame edges', () => {
  const pipeline = readFileSync(path.join(repoRoot, 'amd-worker', 'run_story_pipeline.py'), 'utf8')
  const cleanBank = pipeline.slice(
    pipeline.indexOf('CLEAN_PRODUCT_PROMPTS = ['),
    pipeline.indexOf('ALLOWED_PEOPLE_SAFE_PROMPTS ='),
  )
  const allowedPeopleSafeBank = pipeline.slice(
    pipeline.indexOf('ALLOWED_PEOPLE_SAFE_PROMPTS = ['),
    pipeline.indexOf('DEFAULT_IDENTITY_LOCKS ='),
  )
  const presenceBank = pipeline.slice(
    pipeline.indexOf('HUMAN_CONTAMINATION_PROMPTS = ['),
    pipeline.indexOf('HUMAN_OCCLUSION_PROMPTS ='),
  )

  assert.doesNotMatch(cleanBank, /\b(?:person|people|human|hand|body|face|head|character)\b/i)
  assert.match(allowedPeopleSafeBank, /behind.*fully visible.*separate/i)
  assert.match(allowedPeopleSafeBank, /unobstructed.*foreground.*farther.*background/i)
  assert.doesNotMatch(allowedPeopleSafeBank, /\b(?:not|non|touch|touching|overlap|overlapping|blocking|occlusion)\b/i)
  assert.match(presenceBank, /cartoon.*anime.*illustrated/i)
  assert.match(presenceBank, /face.*head.*hair.*shoulder.*torso.*frame edge/i)
})

test('parses rocm-smi JSON telemetry into bounded GPU metrics', () => {
  const result = runWorkerScript(`
import json, sys
sys.path.insert(0, 'amd-worker')
from gpu_telemetry import parse_rocm_smi_json

raw = json.dumps({
  'card0': {
    'GPU use (%)': '87%',
    'GPU Memory Allocated (VRAM%)': '34%',
    'Average Graphics Package Power (W)': '412.5 W',
    'Temperature (Sensor edge) (C)': '72.4c',
  }
})
print(json.dumps(parse_rocm_smi_json(raw)))
`)
  assert.equal(result.available, true)
  assert.equal(result.utilizationPct, 87)
  assert.equal(result.vramPct, 34)
  assert.equal(result.powerWatts, 412.5)
  assert.equal(result.temperatureC, 72.4)
})

test('preserves zero-valued rocm-smi telemetry samples', () => {
  const result = runWorkerScript(`
import json, sys
sys.path.insert(0, 'amd-worker')
from gpu_telemetry import parse_rocm_smi_json

raw = json.dumps({'card0': {'GPU use (%)': '0%', 'GPU Memory Allocated (VRAM%)': '0%', 'Average Graphics Package Power (W)': '0 W'}})
print(json.dumps(parse_rocm_smi_json(raw)))
`)
  assert.equal(result.available, true)
  assert.equal(result.utilizationPct, 0)
  assert.equal(result.vramPct, 0)
  assert.equal(result.powerWatts, 0)
})

test('builds product-agnostic retries from identity locks and typed failure codes', () => {
  const pipeline = readFileSync(path.join(repoRoot, 'amd-worker', 'run_story_pipeline.py'), 'utf8')

  assert.doesNotMatch(pipeline, /\b(?:luggage|wheels|handles|shell pattern)\b/i)
  assert.match(pipeline, /normalized_identity_locks/)
  assert.match(pipeline, /FAILURE_RETRY_INSTRUCTIONS/)
  assert.match(pipeline, /clip_similarity_below_threshold/)
  assert.match(pipeline, /ocr_retention_below_threshold/)
  assert.match(pipeline, /human_product_occlusion/)
  assert.match(pipeline, /foreign_edge_intrusion/)
  assert.match(pipeline, /"attemptHistory"/)
  assert.match(pipeline, /"observedFailureCodes"/)
})

test('unwraps tensor and Transformers 5 CLIP feature outputs before normalization', () => {
  const result = runWorkerScript(`
import __future__, ast, json, types
source = open('amd-worker/run_story_pipeline.py', encoding='utf-8').read()
tree = ast.parse(source)
selected = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'clip_feature_tensor']

class FakeTensor:
    def __init__(self, label, ndim=2):
        self.label = label
        self.ndim = ndim
    def __getitem__(self, _key):
        return FakeTensor(self.label + '-pooled', 2)

namespace = {'torch': types.SimpleNamespace(Tensor=FakeTensor)}
module = ast.Module(body=selected, type_ignores=[])
exec(compile(ast.fix_missing_locations(module), 'amd-worker/run_story_pipeline.py', 'exec', flags=__future__.annotations.compiler_flag), namespace)
unwrap = namespace['clip_feature_tensor']
print(json.dumps({
  'direct': unwrap(FakeTensor('direct'), 'text').label,
  'textEmbeds': unwrap(types.SimpleNamespace(text_embeds=FakeTensor('text-embeds'), pooler_output=FakeTensor('pooler')), 'text').label,
  'pooler': unwrap(types.SimpleNamespace(pooler_output=FakeTensor('projected-pooler')), 'text').label,
  'sequence': unwrap(types.SimpleNamespace(last_hidden_state=FakeTensor('sequence', 3)), 'image').label,
}))
`)

  assert.deepEqual(result, {
    direct: 'direct',
    textEmbeds: 'text-embeds',
    pooler: 'projected-pooler',
    sequence: 'sequence-pooled',
  })
})

test('uses the current shot locks and local failure type when constructing a retry', () => {
  const result = runWorkerScript(`
import __future__, ast, json, re
source = open('amd-worker/run_story_pipeline.py', encoding='utf-8').read()
tree = ast.parse(source)
names = {
  'DEFAULT_IDENTITY_LOCKS', 'FAILURE_CODE_CLIP_SIMILARITY', 'FAILURE_CODE_OCR_RETENTION',
  'FAILURE_CODE_HUMAN_CONTAMINATION', 'FAILURE_CODE_COLOR_DISTRIBUTION', 'FAILURE_CODE_EDGE_INTRUSION',
  'FAILURE_RETRY_INSTRUCTIONS', 'FAILURE_NEGATIVE_TERMS', 'PREVENTIVE_HUMAN_NEGATIVE_TERMS',
  'HUMAN_NEGATIVE_PATTERN', 'HUMAN_PROHIBITION_PATTERN', 'normalized_identity_locks',
  'IDENTITY_STRUCTURE_PATTERN', 'IDENTITY_COLOR_PATTERN', 'IDENTITY_POSITION_PATTERN',
  'first_attempt_identity_directive', 'retry_directives', 'apply_people_policy', 'evenly_spaced_frame_indices',
}
selected = []
for node in tree.body:
    if isinstance(node, ast.Import) and any(alias.name == 're' for alias in node.names):
        selected.append(node)
    elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names:
        selected.append(node)
    elif isinstance(node, (ast.Assign, ast.AnnAssign)):
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        if any(isinstance(target, ast.Name) and target.id in names for target in targets):
            selected.append(node)
module = ast.Module(body=selected, type_ignores=[])
namespace = {}
exec(compile(ast.fix_missing_locations(module), 'amd-worker/run_story_pipeline.py', 'exec', flags=__future__.annotations.compiler_flag), namespace)
locks = namespace['normalized_identity_locks']({'identityLocks': ['amber glass bottle', 'black dropper cap']})
first_identity_prompt = namespace['first_attempt_identity_directive']([
  'Four dual-caster wheels visible on every piece',
  'Seven total pieces: four larger rear, three smaller front',
  'Exact color assignment: rear-left teal, rear-center navy, front-center magenta, front-right yellow',
], False)
retry_identity_prompt = namespace['first_attempt_identity_directive']([
  'Seven total pieces: four larger rear, three smaller front',
  'Exact color assignment: rear-left teal, rear-center navy, front-center magenta, front-right yellow',
], True)
retry_prompt, retry_negative = namespace['retry_directives'](locks, ['ocr_retention_below_threshold'], True)
product_retry_prompt, product_retry_negative = namespace['retry_directives'](locks, ['ocr_retention_below_threshold'], False)
edge_retry_prompt, edge_retry_negative = namespace['retry_directives'](locks, ['foreign_edge_intrusion'], False)
people_prompt, people_negative = namespace['apply_people_policy'](
    'No people or body parts may occlude the product. A model holds the product beside their face.',
    'person, human, warped logo',
    True,
)
print(json.dumps({
  'locks': locks,
  'firstIdentityPrompt': first_identity_prompt,
  'retryIdentityPrompt': retry_identity_prompt,
  'retryPrompt': retry_prompt,
  'retryNegative': retry_negative,
  'productRetryPrompt': product_retry_prompt,
  'productRetryNegative': product_retry_negative,
  'edgeRetryPrompt': edge_retry_prompt,
  'edgeRetryNegative': edge_retry_negative,
  'peoplePrompt': people_prompt,
  'peopleNegative': people_negative,
  'indices': namespace['evenly_spaced_frame_indices'](17, 5),
}))
`)

  assert.deepEqual(result.locks, ['amber glass bottle', 'black dropper cap'])
  assert.match(result.firstIdentityPrompt, /Seven total pieces/)
  assert.match(result.firstIdentityPrompt, /front-right yellow/)
  assert.doesNotMatch(result.firstIdentityPrompt, /dual-caster wheels/)
  assert.ok(result.firstIdentityPrompt.length <= 620)
  assert.equal(result.retryIdentityPrompt, '')
  assert.match(result.retryPrompt, /amber glass bottle/)
  assert.match(result.retryPrompt, /packaging text/)
  assert.doesNotMatch(result.retryNegative, /person|human|hand/i)
  assert.match(result.productRetryNegative, /not present in reference/i)
  assert.doesNotMatch(result.productRetryNegative, /\b(?:face|head|hair|cartoon|anime)\b/i)
  assert.match(result.edgeRetryPrompt, /reduce camera displacement/i)
  assert.match(result.edgeRetryPrompt, /restore every frame edge and corner to its source appearance/i)
  assert.match(result.edgeRetryPrompt, /slab-like surface or plane extending inward from a border/i)
  assert.match(result.edgeRetryNegative, /foreign disconnected edge object not present in source/i)
  assert.doesNotMatch(result.edgeRetryPrompt, /pale|bottom-left/i)
  assert.doesNotMatch(result.peoplePrompt, /No people/i)
  assert.match(result.peoplePrompt, /people are allowed/i)
  assert.equal(result.peopleNegative, 'warped logo')
  assert.deepEqual(result.indices, [0, 4, 8, 12, 16])
})

test('samples five frames, preserves the full source, and applies per-shot people policy', () => {
  const pipeline = readFileSync(path.join(repoRoot, 'amd-worker', 'run_story_pipeline.py'), 'utf8')

  assert.match(pipeline, /evenly_spaced_frame_indices\(len\(frames\), 5\)/)
  assert.match(pipeline, /ImageOps\.contain/)
  assert.doesNotMatch(pipeline, /def resize_cover/)
  assert.match(pipeline, /allow_people = shot\.get\("allowPeople"\) is True/)
  assert.match(pipeline, /detected = decision\["detected"\]/)
  assert.match(pipeline, /HUMAN_PROHIBITION_PATTERN\.sub/)
})

test('restricts source downloads to the configured origin without redirects or oversized payloads', () => {
  const pipeline = readFileSync(path.join(repoRoot, 'amd-worker', 'run_story_pipeline.py'), 'utf8')

  assert.match(pipeline, /RUKTER_SOURCE_ORIGIN/)
  assert.match(pipeline, /configured_source_origin/)
  assert.match(pipeline, /allow_redirects=False/)
  assert.match(pipeline, /ALLOWED_SOURCE_MIME_TYPES/)
  assert.match(pipeline, /SOURCE_MAX_BYTES/)
  assert.match(pipeline, /SOURCE_MAX_PIXELS/)
  assert.match(pipeline, /SOURCE_MAX_DIMENSION/)
  assert.match(pipeline, /Image\.MAX_IMAGE_PIXELS/)
})

test('validates worker story payloads and fails closed when the worker token is absent', () => {
  const app = readFileSync(path.join(repoRoot, 'amd-worker', 'app.py'), 'utf8')

  assert.match(app, /class StoryShotRequest/)
  assert.match(app, /class StoryPayloadRequest/)
  assert.match(app, /Every shot sourceUrl must reference sourceImages/)
  assert.match(app, /WORKER_TOKEN is required before this worker can accept jobs/)
  assert.match(app, /authConfigured/)
  assert.match(app, /PROCESS_DIAGNOSTIC_CHARS/)
})

test('reports truthful worker activity without exposing a job id', () => {
  const result = runWorkerScript(`
import __future__, ast, json

source = open('amd-worker/app.py', encoding='utf-8').read()
tree = ast.parse(source)
names = {'pipeline_process_is_present', 'worker_activity_snapshot'}
selected = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
module = ast.Module(body=selected, type_ignores=[])

class MissingProcessGroup:
    def killpg(self, _pid, _signal):
        raise ProcessLookupError()

class PresentProcessGroup:
    def killpg(self, _pid, _signal):
        return None

class Process:
    def __init__(self, pid, returncode):
        self.pid = pid
        self.returncode = returncode

namespace = {'os': MissingProcessGroup(), 'active_job_id': None, 'active_process': None}
exec(compile(ast.fix_missing_locations(module), 'amd-worker/app.py', 'exec', flags=__future__.annotations.compiler_flag), namespace)

idle = namespace['worker_activity_snapshot']()
namespace['active_job_id'] = 'private-job-id'
namespace['active_process'] = Process(4321, None)
running = namespace['worker_activity_snapshot']()
namespace['active_job_id'] = None
namespace['active_process'] = Process(4321, 0)
finished = namespace['worker_activity_snapshot']()
namespace['os'] = PresentProcessGroup()
descendant = namespace['worker_activity_snapshot']()

print(json.dumps({'idle': idle, 'running': running, 'finished': finished, 'descendant': descendant}))
`)

  assert.deepEqual(result.idle, {
    activeJobPresent: false,
    pipelineProcessPresent: false,
    pipelineProcessPid: null,
  })
  assert.deepEqual(result.running, {
    activeJobPresent: true,
    pipelineProcessPresent: true,
    pipelineProcessPid: 4321,
  })
  assert.equal(result.finished.pipelineProcessPresent, false)
  assert.equal(result.descendant.pipelineProcessPresent, true)
  assert.ok(!JSON.stringify(result).includes('private-job-id'))
})

test('refuses persistent worker restarts until health and process probes are idle', () => {
  const app = readFileSync(path.join(repoRoot, 'amd-worker', 'app.py'), 'utf8')
  const workerBootstrap = readFileSync(path.join(repoRoot, 'amd-worker', 'bootstrap.sh'), 'utf8')
  const persistentBootstrap = readFileSync(path.join(repoRoot, 'scripts', 'bootstrap-persistent-amd.sh'), 'utf8')

  assert.match(app, /WORKER_UPDATE_LOCK/)
  assert.match(app, /activeJobPresent/)
  assert.match(app, /pipelineProcessPresent/)
  assert.match(app, /pipelineProcessPid/)
  assert.match(workerBootstrap, /assert_worker_idle_for_update/)
  assert.match(workerBootstrap, /docker top rukter-amd-worker/)
  assert.match(workerBootstrap, /Refusing to update or restart the persistent AMD worker/)
  assert.match(workerBootstrap, /systemctl restart rukter-amd-worker\.service/)
  assert.match(persistentBootstrap, /assert_remote_worker_idle_for_update/)
  assert.match(persistentBootstrap, /Refusing to bootstrap the persistent AMD worker/)
  assert.match(persistentBootstrap, /\.activeJobPresent == false/)
  assert.match(persistentBootstrap, /\.pipelineProcessPresent == false/)
  assert.match(persistentBootstrap, /will remain online/)
})

test('filters progress chatter and reports the worker process exit signal', () => {
  const result = runWorkerScript(`
import __future__, ast, json, re, signal
source = open('amd-worker/app.py', encoding='utf-8').read()
tree = ast.parse(source)
names = {'pipeline_exit_detail', 'pipeline_failure_details', 'concise_pipeline_failure'}
selected = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
module = ast.Module(body=selected, type_ignores=[])
namespace = {'json': json, 're': re, 'signal': signal}
exec(compile(ast.fix_missing_locations(module), 'amd-worker/app.py', 'exec', flags=__future__.annotations.compiler_flag), namespace)
message = namespace['concise_pipeline_failure'](
    'RUKTER_PROGRESS {"progress": 44}\\nlast useful stdout\\n',
    'last useful stderr\\n',
    -9,
)
print(json.dumps({'message': message}))
`)

  assert.doesNotMatch(result.message, /RUKTER_PROGRESS/)
  assert.match(result.message, /last useful stdout/)
  assert.match(result.message, /last useful stderr/)
  assert.match(result.message, /SIGKILL/)
  assert.match(result.message, /returncode=-9/)
})
