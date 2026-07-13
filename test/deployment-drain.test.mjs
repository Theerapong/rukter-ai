import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')

function admittedWorkloadHarness() {
  const start = server.indexOf('function responseIsTerminal')
  const end = server.indexOf('\nfunction normalizeGpuTelemetry', start)
  assert.ok(start >= 0 && end > start, 'admission functions must remain extractable')
  const admissionFunctions = server.slice(start, end)
  return Function(`
    let activeAdmittedRequests = 0
    let lastAdmissionActivityAtMs = 0
    const deploymentDrainCache = null
    const baseAmdQueueSnapshot = () => ({})
    const localDeploymentDrainLocked = () => false
    const inspectDurableDeploymentDrain = async () => ({ active: false })
    const deploymentDrainStatus = () => ({ active: false })
    const rejectDeploymentDrain = () => { throw new Error('unexpected drain rejection') }
    ${admissionFunctions}
    return {
      run: admitUserWorkload,
      activeCount: () => activeAdmittedRequests,
    }
  `)()
}

class MockResponse extends EventEmitter {
  constructor() {
    super()
    this.writableEnded = false
    this.writableFinished = false
    this.destroyed = false
    this.closed = false
  }

  finish() {
    this.writableEnded = true
    this.writableFinished = true
    this.emit('finish')
  }

  close() {
    this.destroyed = true
    this.closed = true
    this.emit('close')
  }

  destroy() {
    this.close()
  }
}

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

test('admission releases only after both handler and response settle in either order', async () => {
  const admission = admittedWorkloadHarness()
  const response = new MockResponse()
  let settleHandler
  const handlerPending = new Promise((resolve) => {
    settleHandler = resolve
  })

  const admitted = admission.run({}, response, () => handlerPending)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(admission.activeCount(), 1)
  assert.equal(response.listenerCount('close'), 1)
  assert.equal(response.listenerCount('finish'), 1)

  response.close()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(admission.activeCount(), 1, 'socket completion must not release work still running upstream')

  settleHandler()
  assert.equal(await admitted, true)
  assert.equal(admission.activeCount(), 0, 'handler settlement releases after a prior response close')

  const streamingResponse = new MockResponse()
  const streamingAdmission = admission.run({}, streamingResponse, async () => {})
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(admission.activeCount(), 1, 'handler completion must not release a response still streaming')
  streamingResponse.finish()
  assert.equal(await streamingAdmission, true)
  assert.equal(admission.activeCount(), 0, 'response finish releases after prior handler settlement')

  const rejectedResponse = new MockResponse()
  await assert.rejects(
    admission.run({}, rejectedResponse, async () => { throw new Error('handler failed') }),
    /handler failed/,
  )
  assert.equal(rejectedResponse.destroyed, true, 'an unexpected no-response rejection explicitly closes the response')
  assert.equal(admission.activeCount(), 0, 'handler rejection also releases admission through finally')
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
