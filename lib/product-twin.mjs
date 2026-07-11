const maxSourceViews = 6

function cleanText(value, fallback = '', max = 240) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return (text || fallback).slice(0, max)
}

function cleanUrl(value) {
  const text = cleanText(value, '', 1200)
  if (!text) return ''
  try {
    const url = new URL(text)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : ''
  } catch {
    return ''
  }
}

export function normalizeSourceViews(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, maxSourceViews).map((view, index) => ({
    id: cleanText(view?.id, `view-${index + 1}`, 80),
    name: cleanText(view?.name, `Source view ${index + 1}`, 120),
    type: cleanText(view?.type, 'image/jpeg', 80),
    size: Math.max(0, Number(view?.size) || 0),
    url: cleanUrl(view?.url),
    label: cleanText(view?.label, `View ${index + 1}`, 40),
  })).filter((view) => view.url)
}

export function normalizeSourceCapture(value) {
  const capture = value && typeof value === 'object' ? value : {}
  const allowedKinds = new Set(['single_photo', 'multi_photo', 'orbit_video'])
  const kind = allowedKinds.has(capture.kind) ? capture.kind : 'single_photo'
  return {
    kind,
    name: cleanText(capture.name, '', 160),
    type: cleanText(capture.type, kind === 'orbit_video' ? 'video/quicktime' : 'image/jpeg', 80),
    size: Math.max(0, Number(capture.size) || 0),
    durationMs: kind === 'orbit_video' ? Math.max(0, Number(capture.durationMs) || 0) : 0,
    extractedFrameCount: Math.max(0, Math.min(maxSourceViews, Number(capture.extractedFrameCount) || 0)),
  }
}

export function resolveProductTwinMode(sourceCount, reconstruction = {}) {
  const verifiedModelUrl = cleanUrl(reconstruction?.modelUrl)
  const verified = reconstruction?.status === 'verified' && Boolean(verifiedModelUrl)
  if (verified && sourceCount >= 2) return 'verified_multi_view_3d'
  if (sourceCount >= 2) return 'multi_view_capture'
  return 'single_photo_2_5d'
}

export function buildProductTwinManifest({ input = {}, kit = {}, productAssets = [], reconstruction = null } = {}) {
  const sourceViews = normalizeSourceViews(input.sourceImages)
  const fallbackSource = input.productImage?.url ? normalizeSourceViews([input.productImage]) : []
  const views = sourceViews.length ? sourceViews : fallbackSource
  const safeReconstruction = reconstruction && typeof reconstruction === 'object' ? reconstruction : {}
  const mode = resolveProductTwinMode(views.length, safeReconstruction)
  const analysis = kit.productAnalysis || {}
  const primaryAsset = Array.isArray(productAssets) ? productAssets[0] : null
  const visibleDetails = Array.isArray(analysis.visibleDetails) ? analysis.visibleDetails.slice(0, 6) : []
  const reviewItems = Array.isArray(analysis.needsReview) ? analysis.needsReview.slice(0, 6) : []
  const sourceCapture = normalizeSourceCapture(input.capture)

  const labels = {
    single_photo_2_5d: '2.5D Product Twin Preview',
    multi_view_capture: 'Multi-view Capture Preview',
    verified_multi_view_3d: 'Verified Multi-view 3D',
  }
  const truthNotes = {
    single_photo_2_5d: 'Depth and unseen surfaces are not verified from one photo.',
    multi_view_capture: 'Multiple source views are available, but 3D geometry has not been verified.',
    verified_multi_view_3d: 'Geometry was reconstructed from multiple views by the configured AMD worker.',
  }

  return {
    schema: 'rukter.product_twin.v1',
    mode,
    label: labels[mode],
    truthNote: truthNotes[mode],
    sourceCount: views.length,
    sourceCapture: {
      ...sourceCapture,
      extractedFrameCount: views.length || sourceCapture.extractedFrameCount,
    },
    sourceViews: views,
    preview: {
      kind: mode === 'verified_multi_view_3d' ? 'model' : 'texture_orbit_2_5d',
      imageUrl: cleanUrl(primaryAsset?.url) || cleanUrl(views[0]?.url),
      modelUrl: mode === 'verified_multi_view_3d' ? cleanUrl(safeReconstruction.modelUrl) : '',
    },
    reconstruction: {
      status: mode === 'verified_multi_view_3d' ? 'verified' : safeReconstruction.status || 'preview_only',
      provider: cleanText(safeReconstruction.provider, mode === 'verified_multi_view_3d' ? 'AMD GPU worker' : 'Rukter browser preview', 120),
      modelFormat: cleanText(safeReconstruction.modelFormat, '', 40),
      durationMs: Number.isFinite(Number(safeReconstruction.durationMs)) ? Number(safeReconstruction.durationMs) : null,
      evidenceId: cleanText(safeReconstruction.evidenceId, '', 160),
    },
    visualEvidence: [
      {
        id: 'product-identity',
        label: 'Product identity',
        value: cleanText(analysis.productType, 'Product identity requires review', 180),
        status: analysis.productType ? 'observed' : 'not_verifiable',
      },
      ...visibleDetails.map((detail, index) => ({
        id: `visible-detail-${index + 1}`,
        label: index === 0 ? 'Packaging text' : `Visible detail ${index + 1}`,
        value: cleanText(detail, 'Not verifiable', 260),
        status: 'observed',
      })),
      ...reviewItems.map((item, index) => ({
        id: `review-${index + 1}`,
        label: 'Not verifiable',
        value: cleanText(item, 'Seller review required', 260),
        status: 'not_verifiable',
      })),
    ].slice(0, 12),
    exportFiles: [
      'viewer.html',
      'viewer.css',
      'viewer.js',
      'product-twin.json',
      'images/product-1.webp',
      'vendor/three.module.min.js',
      'vendor/three.core.min.js',
    ],
    generatedAt: new Date().toISOString(),
  }
}

export const productTwinLimits = Object.freeze({ maxSourceViews })
