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
  assert.match(pipeline, /shot\.get\("renderPrompt"\) or shot\.get\("cinematicPrompt"/)
  assert.match(pipeline, /shot\.get\("renderPrompt"\) or shot\["cinematicPrompt"\]/)
  assert.match(app, /STORY_PIPELINE_TIMEOUT_SECONDS/)
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
  assert.match(pipeline, /human_contamination_evidence/)
  assert.match(pipeline, /humanContaminationDetected/)
  assert.match(pipeline, /FAILURE_CODE_HUMAN_CONTAMINATION/)
  assert.match(pipeline, /detected = observed/)
  assert.match(pipeline, /"humanPolicy": "background_only"/)
  assert.match(storySource, /Product-centered commercial frame with no people/)
  assert.match(storySource, /no hands, no fingers, no arms, no body parts/)
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
  'FAILURE_CODE_HUMAN_CONTAMINATION', 'FAILURE_RETRY_INSTRUCTIONS', 'FAILURE_NEGATIVE_TERMS',
  'HUMAN_NEGATIVE_PATTERN', 'HUMAN_PROHIBITION_PATTERN', 'normalized_identity_locks',
  'retry_directives', 'apply_people_policy', 'evenly_spaced_frame_indices',
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
retry_prompt, retry_negative = namespace['retry_directives'](locks, ['ocr_retention_below_threshold'], True)
people_prompt, people_negative = namespace['apply_people_policy'](
    'No people or body parts may occlude the product. A model holds the product beside their face.',
    'person, human, warped logo',
    True,
)
print(json.dumps({
  'locks': locks,
  'retryPrompt': retry_prompt,
  'retryNegative': retry_negative,
  'peoplePrompt': people_prompt,
  'peopleNegative': people_negative,
  'indices': namespace['evenly_spaced_frame_indices'](17, 5),
}))
`)

  assert.deepEqual(result.locks, ['amber glass bottle', 'black dropper cap'])
  assert.match(result.retryPrompt, /amber glass bottle/)
  assert.match(result.retryPrompt, /packaging text/)
  assert.doesNotMatch(result.retryNegative, /person|human|hand/i)
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
  assert.match(pipeline, /detected = observed/)
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
