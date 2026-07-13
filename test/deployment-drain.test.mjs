import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')

test('deployment drain exposes protected owned control routes and privacy-safe public state', () => {
  assert.match(server, /\/v1\/deployment-drain\/acquire/)
  assert.match(server, /\/v1\/deployment-drain\/release/)
  assert.match(server, /async function handleGetDeploymentDrain/)
  assert.match(server, /if \(!requireGpuControl\(req, res\)\) return/)
  assert.match(server, /function privacySafeDeploymentDrain/)
  assert.match(server, /deploymentDraining: configDrain\.admissionLocked/)
  assert.doesNotMatch(
    server.match(/function privacySafeDeploymentDrain[\s\S]*?\n}\n\nasync function publicAmdQueueSnapshot/)?.[0] || '',
    /drainId|persistentWorkerId|workerUrl|pipelineProcessPid/,
  )
})

test('new workload routes require admission while completion and cleanup routes remain available', () => {
  for (const route of [
    '/api/product-image',
    '/api/story-jobs',
    '/api/launch-kit',
    '/api/design-critique',
    '/api/export',
    '/api/rukter-draft',
  ]) {
    const routeIndex = server.indexOf(`url.pathname === '${route}'`, server.indexOf('const server = http.createServer'))
    assert.ok(routeIndex > 0, `missing ${route}`)
    assert.match(server.slice(routeIndex, routeIndex + 240), /admitUserWorkload/)
  }
  const assetCallback = server.indexOf("url.pathname === '/api/amd-story-assets'", server.indexOf('const server = http.createServer'))
  assert.doesNotMatch(server.slice(assetCallback, assetCallback + 180), /admitUserWorkload/)
  const cancelRoute = server.indexOf("const cancelStoryMatch = url.pathname.match", server.indexOf('const server = http.createServer'))
  assert.doesNotMatch(server.slice(cancelRoute, cancelRoute + 300), /admitUserWorkload/)
  const approvalRoute = server.indexOf("const approveStoryMatch = url.pathname.match", server.indexOf('const server = http.createServer'))
  assert.doesNotMatch(server.slice(approvalRoute, approvalRoute + 300), /admitUserWorkload/)
  const releaseRoute = server.indexOf("const releaseStoryMatch = url.pathname.match", server.indexOf('const server = http.createServer'))
  assert.doesNotMatch(server.slice(releaseRoute, releaseRoute + 300), /admitUserWorkload/)
})

test('deployment readiness requires queue, admission, quiet-window, and worker-process evidence', () => {
  const statusFunction = server.match(/function deploymentDrainStatus[\s\S]*?\n}\n\nfunction privacySafeDeploymentDrain/)?.[0] || ''
  assert.match(statusFunction, /activeAdmittedRequests === 0/)
  assert.match(statusFunction, /queueIdle/)
  assert.match(statusFunction, /workerActivity\?\.reachable === true/)
  assert.match(statusFunction, /workerActivity\?\.verifiable === true/)
  assert.match(statusFunction, /workerActivity\?\.idle === true/)
  assert.match(statusFunction, /deploymentDrainQuietWindowMs/)
  assert.match(server, /code: checkFailed \? 'deployment_drain_check_failed' : 'deployment_drain_active'/)
  assert.match(server, /res\.setHeader\('retry-after'/)
})
