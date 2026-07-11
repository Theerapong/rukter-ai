import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildProductTwinManifest,
  normalizeSourceCapture,
  normalizeSourceViews,
  resolveProductTwinMode,
} from '../lib/product-twin.mjs'

const source = (index) => ({
  id: `source-${index}`,
  name: `view-${index}.jpg`,
  type: 'image/jpeg',
  size: 120000,
  url: `https://rukter.ai/uploads/view-${index}.jpg`,
  label: `View ${index}`,
})

test('keeps one photo explicitly in 2.5D preview mode', () => {
  assert.equal(resolveProductTwinMode(1), 'single_photo_2_5d')
  const manifest = buildProductTwinManifest({
    input: { sourceImages: [source(1)] },
    kit: { productAnalysis: { productType: 'Amber serum bottle', visibleDetails: ['30 ml'], needsReview: ['Ingredients are not readable'] } },
    productAssets: [{ url: 'https://rukter.ai/uploads/product.webp' }],
  })

  assert.equal(manifest.mode, 'single_photo_2_5d')
  assert.match(manifest.truthNote, /not verified/i)
  assert.equal(manifest.preview.kind, 'texture_orbit_2_5d')
  assert.ok(manifest.visualEvidence.some((item) => item.status === 'not_verifiable'))
})

test('does not call multiple photos verified 3D without a verified model', () => {
  assert.equal(resolveProductTwinMode(4, { status: 'preview_only' }), 'multi_view_capture')
  assert.equal(resolveProductTwinMode(4, { status: 'verified' }), 'multi_view_capture')
})

test('requires a verified model URL for verified multi-view 3D', () => {
  const reconstruction = {
    status: 'verified',
    modelUrl: 'https://amd-worker.example/twins/product.glb',
    modelFormat: 'glb',
    evidenceId: 'amd-run-42',
  }
  assert.equal(resolveProductTwinMode(4, reconstruction), 'verified_multi_view_3d')
  const manifest = buildProductTwinManifest({
    input: { sourceImages: [source(1), source(2), source(3), source(4)] },
    kit: { productAnalysis: { productType: 'Serum bottle', visibleDetails: [], needsReview: [] } },
    reconstruction,
  })
  assert.equal(manifest.preview.kind, 'model')
  assert.equal(manifest.preview.modelUrl, reconstruction.modelUrl)
  assert.equal(manifest.reconstruction.status, 'verified')
})

test('normalizes at most six portable source views', () => {
  const views = normalizeSourceViews(Array.from({ length: 8 }, (_, index) => source(index + 1)))
  assert.equal(views.length, 6)
  assert.ok(views.every((view) => view.url.startsWith('https://')))
})

test('records orbit video provenance without storing the video payload', () => {
  const capture = normalizeSourceCapture({
    kind: 'orbit_video',
    name: 'product.MOV',
    type: 'video/quicktime',
    size: 66_908_658,
    durationMs: 22_938,
    extractedFrameCount: 6,
    dataUrl: 'data:video/quicktime;base64,not-portable',
  })
  assert.deepEqual(capture, {
    kind: 'orbit_video',
    name: 'product.MOV',
    type: 'video/quicktime',
    size: 66_908_658,
    durationMs: 22_938,
    extractedFrameCount: 6,
  })

  const manifest = buildProductTwinManifest({
    input: { sourceImages: [source(1), source(2), source(3)], capture },
    kit: { productAnalysis: {} },
  })
  assert.equal(manifest.sourceCapture.kind, 'orbit_video')
  assert.equal(manifest.sourceCapture.extractedFrameCount, 3)
  assert.equal(manifest.mode, 'multi_view_capture')
})
