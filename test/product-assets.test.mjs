import assert from 'node:assert/strict'
import test from 'node:test'
import {
  dedupeProductDetections,
  isLikelySellableDetection,
  normalizeProductDetections,
  productAssetScore,
  selectProductAssets,
} from '../lib/product-assets.mjs'

test('rejects shelf labels and screenshot UI detections', () => {
  const detections = normalizeProductDetections([
    { label: 'Yellow price tag', bbox: { x: 120, y: 330, width: 180, height: 42 }, confidence: 'high' },
    { label: 'Browser UI frame', bbox: { x: 0, y: 0, width: 1000, height: 80 }, confidence: 'high' },
    { label: 'Clean & Clear cleanser', bbox: { x: 210, y: 370, width: 150, height: 260 }, confidence: 'high' },
  ])

  assert.equal(isLikelySellableDetection(detections[0]), false)
  assert.equal(isLikelySellableDetection(detections[1]), false)
  assert.equal(isLikelySellableDetection(detections[2]), true)
})

test('deduplicates overlapping product boxes', () => {
  const detections = normalizeProductDetections([
    { label: 'Cleanser bottle', bbox: { x: 210, y: 370, width: 150, height: 260 }, confidence: 'high' },
    { label: 'Cleanser bottle duplicate', bbox: { x: 216, y: 376, width: 145, height: 250 }, confidence: 'medium' },
    { label: 'Collagen mask box', bbox: { x: 430, y: 350, width: 230, height: 280 }, confidence: 'high' },
  ])

  assert.deepEqual(
    dedupeProductDetections(detections).map((item) => item.label),
    ['Cleanser bottle', 'Collagen mask box'],
  )
})

test('normalizes product orientation to a supported clockwise rotation', () => {
  const [upsideDown, approximate] = normalizeProductDetections([
    { label: 'Soap pack', bbox: { x: 100, y: 100, width: 700, height: 400 }, confidence: 'high', rotationDegrees: 180 },
    { label: 'Bottle', bbox: { x: 200, y: 80, width: 300, height: 800 }, confidence: 'high', rotationDegrees: 82 },
  ])

  assert.equal(upsideDown.rotationDegrees, 180)
  assert.equal(approximate.rotationDegrees, 90)
})

test('ranks a complete package ahead of a wide shelf fragment', () => {
  const common = {
    backgroundRemoved: true,
    matteQuality: 91,
    edgeDecontaminated: true,
    componentCount: 18,
    foregroundCoverage: 42,
    confidence: 'high',
  }
  const shelfFragment = {
    ...common,
    label: 'Clean & Clear acne clearing cleanser',
    sourceBbox: { x: 100, y: 330, width: 300, height: 84 },
  }
  const completeBottle = {
    ...common,
    label: 'Clean & Clear acne clearing cleanser',
    sourceBbox: { x: 210, y: 370, width: 150, height: 260 },
  }

  assert.ok(productAssetScore(completeBottle) > productAssetScore(shelfFragment))
  assert.deepEqual(selectProductAssets([shelfFragment, completeBottle]), [completeBottle])
})

test('does not return a misleading asset when every candidate fails quality gates', () => {
  const rejected = selectProductAssets([{
    label: 'Shelf price label',
    sourceBbox: { x: 100, y: 330, width: 300, height: 60 },
    backgroundRemoved: true,
    matteQuality: 93,
    edgeDecontaminated: true,
    componentCount: 4,
    foregroundCoverage: 2,
    confidence: 'high',
  }])

  assert.deepEqual(rejected, [])
})

test('keeps a complete bounding-box crop when the alpha matte destroys the product', () => {
  const crop = {
    label: 'Mediheal Collagen Ampoule Pad package',
    sourceBbox: { x: 584, y: 620, width: 220, height: 260 },
    backgroundRemoved: false,
    cropFallback: true,
    matteQuality: 0,
    edgeDecontaminated: false,
    componentCount: 270,
    foregroundCoverage: 5,
    confidence: 'high',
  }

  assert.deepEqual(selectProductAssets([crop]), [crop])
})
