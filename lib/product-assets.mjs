const nonProductLabelPattern = /\b(?:barcode|browser\s+(?:chrome|ui)|phone\s+screen|price\s*(?:label|sticker|tag)?|qr\s*code|receipt|screenshot|shelf(?:\s+(?:edge|label|tag))?|store\s+sign|ui\s+(?:frame|panel))\b/i

function clampNumber(value, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return min
  return Math.min(max, Math.max(min, parsed))
}

export function normalizeBoundingBox(value) {
  const bbox = value && typeof value === 'object' ? value : {}
  const x = Math.round(clampNumber(bbox.x, 0, 980))
  const y = Math.round(clampNumber(bbox.y, 0, 980))
  return {
    x,
    y,
    width: Math.round(clampNumber(bbox.width, 20, 1000 - x)),
    height: Math.round(clampNumber(bbox.height, 20, 1000 - y)),
  }
}

export function normalizeProductDetections(value, fallbackLabel = 'Product', maxAssets = 4) {
  if (!Array.isArray(value)) return []
  return value.slice(0, maxAssets).map((item, index) => {
    const bbox = normalizeBoundingBox(item?.bbox)
    const label = typeof item?.label === 'string' && item.label.trim()
      ? item.label.trim().slice(0, 80)
      : `${fallbackLabel} ${index + 1}`
    const confidence = typeof item?.confidence === 'string' && item.confidence.trim()
      ? item.confidence.trim().slice(0, 40)
      : 'review'
    const requestedRotation = Math.round(clampNumber(item?.rotationDegrees, 0, 270) / 90) * 90
    const rotationDegrees = [0, 90, 180, 270].includes(requestedRotation) ? requestedRotation : 0
    return { label, bbox, confidence, rotationDegrees }
  }).filter((item) => item.bbox.width * item.bbox.height >= 4_000)
}

export function isLikelySellableDetection(detection) {
  const bbox = detection?.bbox || detection?.sourceBbox
  if (!bbox || nonProductLabelPattern.test(String(detection.label || ''))) return false
  if (/^fallback/i.test(String(detection.confidence || ''))) return true
  const { width, height } = normalizeBoundingBox(bbox)
  const aspect = width / Math.max(height, 1)
  return width >= 45
    && height >= 90
    && width * height >= 6_000
    && aspect >= 0.16
    && aspect <= 3.2
}

function intersectionArea(left, right) {
  const leftEdge = Math.max(left.x, right.x)
  const topEdge = Math.max(left.y, right.y)
  const rightEdge = Math.min(left.x + left.width, right.x + right.width)
  const bottomEdge = Math.min(left.y + left.height, right.y + right.height)
  return Math.max(0, rightEdge - leftEdge) * Math.max(0, bottomEdge - topEdge)
}

function isDuplicateBox(left, right) {
  const intersection = intersectionArea(left, right)
  if (!intersection) return false
  const leftArea = left.width * left.height
  const rightArea = right.width * right.height
  const union = leftArea + rightArea - intersection
  const overlap = union ? intersection / union : 0
  const containment = intersection / Math.max(1, Math.min(leftArea, rightArea))
  return overlap >= 0.68 || containment >= 0.88
}

export function dedupeProductDetections(detections, maxAssets = 4) {
  const unique = []
  for (const detection of detections) {
    if (!isLikelySellableDetection(detection)) continue
    if (unique.some((candidate) => isDuplicateBox(candidate.bbox, detection.bbox))) continue
    unique.push(detection)
    if (unique.length >= maxAssets) break
  }
  return unique
}

export function productAssetScore(asset) {
  const bbox = normalizeBoundingBox(asset?.sourceBbox)
  const areaRatio = (bbox.width * bbox.height) / 1_000_000
  const aspect = bbox.width / Math.max(bbox.height, 1)
  const areaScore = Math.min(areaRatio / 0.12, 1) * 34
  const heightScore = Math.min(bbox.height / 500, 1) * 22
  const aspectScore = aspect >= 0.28 && aspect <= 2.2
    ? 14
    : Math.max(0, 14 - Math.abs(Math.log2(Math.max(aspect, 0.01))) * 5)
  const matteScore = clampNumber(asset?.matteQuality, 0, 100) * 0.14
  const coverage = clampNumber(asset?.foregroundCoverage, 0, 100)
  const coverageScore = coverage >= 8 && coverage <= 82 ? 10 : 3
  const confidenceScore = /\bhigh\b/i.test(String(asset?.confidence || '')) ? 6 : 2
  const isolationScore = asset?.backgroundRemoved ? 12 : 0
  const fragmentationPenalty = Math.max(0, clampNumber(asset?.componentCount, 0, 1000) - 120) * 0.03
  return Math.round((areaScore + heightScore + aspectScore + matteScore + coverageScore + confidenceScore + isolationScore - fragmentationPenalty) * 10) / 10
}

export function selectProductAssets(candidates, maxAssets = 4) {
  const clean = (Array.isArray(candidates) ? candidates : []).filter((asset) => {
    if (!isLikelySellableDetection(asset)) return false
    if (asset?.cropFallback) return true
    return asset?.backgroundRemoved
      && clampNumber(asset.matteQuality, 0, 100) >= 80
      && asset.edgeDecontaminated
      && clampNumber(asset.componentCount, 0, 1000) >= 1
      && clampNumber(asset.foregroundCoverage, 0, 100) >= 8
      && clampNumber(asset.foregroundCoverage, 0, 100) <= 92
  })

  return [...clean]
    .sort((left, right) => productAssetScore(right) - productAssetScore(left))
    .filter((asset, index, sorted) => (
      sorted.findIndex((candidate) => isDuplicateBox(
        normalizeBoundingBox(candidate.sourceBbox),
        normalizeBoundingBox(asset.sourceBbox),
      )) === index
    ))
    .slice(0, maxAssets)
}
