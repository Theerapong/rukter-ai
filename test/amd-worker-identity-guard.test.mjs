import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const python = process.env.PYTHON_BIN || process.env.PYTHON || 'python3'
const probe = spawnSync(python, ['-c', 'import numpy; from PIL import Image'], { cwd: repoRoot, encoding: 'utf8' })
const skipReason = probe.status === 0 ? false : 'Python image dependencies are unavailable'

function runIdentityGuard(script) {
  const result = spawnSync(python, ['-c', script], { cwd: repoRoot, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout)
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
