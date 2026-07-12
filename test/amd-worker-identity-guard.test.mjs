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

test('ships the identity guard helper through every AMD worker bootstrap path', () => {
  const dockerfile = readFileSync(path.join(repoRoot, 'amd-worker', 'Dockerfile'), 'utf8')
  const bootstrap = readFileSync(path.join(repoRoot, 'amd-worker', 'bootstrap.sh'), 'utf8')
  const server = readFileSync(path.join(repoRoot, 'server.mjs'), 'utf8')
  assert.match(dockerfile, /identity_guard\.py/)
  assert.match(bootstrap, /identity_guard\.py/)
  assert.match(server, /identity_guard\.py/)
})

test('ships live GPU telemetry through every AMD worker bootstrap path', () => {
  const dockerfile = readFileSync(path.join(repoRoot, 'amd-worker', 'Dockerfile'), 'utf8')
  const bootstrap = readFileSync(path.join(repoRoot, 'amd-worker', 'bootstrap.sh'), 'utf8')
  const app = readFileSync(path.join(repoRoot, 'amd-worker', 'app.py'), 'utf8')
  assert.match(dockerfile, /gpu_telemetry\.py/)
  assert.match(bootstrap, /gpu_telemetry\.py/)
  assert.match(app, /collect_rocm_smi_metrics/)
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
