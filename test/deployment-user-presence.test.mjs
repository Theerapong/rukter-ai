import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const serverSource = await readFile(new URL('../server.mjs', import.meta.url), 'utf8')
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8')

function presenceHarness({ ttlMs = 1_000, maxSessions = 2 } = {}) {
  const start = serverSource.indexOf('function pruneStorySessionPresence')
  const end = serverSource.indexOf('\nfunction formatCount', start)
  assert.ok(start >= 0 && end > start, 'presence tracker functions must remain extractable')
  const functions = serverSource.slice(start, end)
  return Function('storySessionId', 'publicOrigin', 'sendJson', `
    const storySessionPresenceTtlMs = ${ttlMs}
    const storySessionPresenceMax = ${maxSessions}
    const activeStorySessionPresence = new Map()
    ${functions}
    return {
      mark: markVisibleStorySessionPresence,
      count: activeVisibleStorySessionCount,
      heartbeat: handleStoryPresence,
      sessionIds: () => [...activeStorySessionPresence.keys()],
    }
  `)(
    (req) => req.sessionId || '',
    () => 'https://rukter.ai',
    (res, statusCode, payload) => {
      res.statusCode = statusCode
      res.payload = payload
      res.ended = true
    },
  )
}

function mockResponse() {
  return {
    statusCode: 0,
    headers: {},
    ended: false,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode
      this.headers = headers
    },
    end(body) {
      this.body = body
      this.ended = true
    },
  }
}

test('visible session presence is unique, bounded, and expires automatically', () => {
  const presence = presenceHarness()
  const visible = (sessionId) => ({
    sessionId,
    headers: { 'x-rukter-story-presence': 'visible' },
  })

  assert.equal(presence.mark({ sessionId: 'ignored', headers: {} }, 1_000), false)
  assert.equal(presence.mark({ sessionId: '', headers: { 'x-rukter-story-presence': 'visible' } }, 1_000), false)
  assert.equal(presence.mark(visible('session-a'), 1_000), true)
  assert.equal(presence.mark(visible('session-a'), 1_100), true)
  assert.equal(presence.count(1_100), 1, 'repeat polls from one session are deduplicated')
  assert.equal(presence.mark(visible('session-b'), 1_200), true)
  assert.equal(presence.mark(visible('session-c'), 1_300), true)
  assert.deepEqual(presence.sessionIds(), ['session-b', 'session-c'], 'oldest presence is evicted at the hard bound')
  assert.equal(presence.count(2_300), 0, 'closed or hidden sessions expire without an explicit release')
})

test('only an explicit visible queue poll with a non-loopback story cookie marks presence', () => {
  const tracker = serverSource.slice(
    serverSource.indexOf('function markVisibleStorySessionPresence'),
    serverSource.indexOf('\nfunction activeVisibleStorySessionCount'),
  )
  const queueRoute = serverSource.slice(
    serverSource.indexOf("url.pathname === '/api/story-queue'"),
    serverSource.indexOf("url.pathname === '/oauth/start'"),
  )

  assert.match(tracker, /x-rukter-story-presence/)
  assert.match(tracker, /storySessionId\(req, \{ allowLoopback: false \}\)/)
  assert.match(queueRoute, /markVisibleStorySessionPresence\(req\)/)
  assert.match(queueRoute, /req\.method === 'POST' && url\.pathname === '\/api\/story-presence'/)
  assert.match(queueRoute, /handleStoryPresence\(req, res\)/)
  assert.doesNotMatch(serverSource.slice(
    serverSource.indexOf("url.pathname === '/v1/deployment-drain'"),
    serverSource.indexOf("url.pathname === '/v1/deployment-drain/release'"),
  ), /markVisibleStorySessionPresence/)
})

test('presence-only heartbeat requires session, same origin, and explicit visibility without leaking state', () => {
  const presence = presenceHarness()

  const noSession = mockResponse()
  assert.equal(presence.heartbeat({ sessionId: '', headers: {} }, noSession, 1_000), false)
  assert.equal(noSession.statusCode, 401)
  assert.equal(presence.count(1_000), 0)

  const crossOrigin = mockResponse()
  assert.equal(presence.heartbeat({
    sessionId: 'session-a',
    headers: { origin: 'https://attacker.example', 'x-rukter-story-presence': 'visible' },
  }, crossOrigin, 1_000), false)
  assert.equal(crossOrigin.statusCode, 403)
  assert.equal(presence.count(1_000), 0)

  const hidden = mockResponse()
  assert.equal(presence.heartbeat({
    sessionId: 'session-a',
    headers: { origin: 'https://rukter.ai', 'x-rukter-story-presence': 'hidden' },
  }, hidden, 1_000), false)
  assert.equal(hidden.statusCode, 400)
  assert.equal(presence.count(1_000), 0)

  const visible = mockResponse()
  assert.equal(presence.heartbeat({
    sessionId: 'session-a',
    headers: { origin: 'https://rukter.ai', 'x-rukter-story-presence': 'visible' },
  }, visible, 1_000), true)
  assert.equal(visible.statusCode, 204)
  assert.equal(visible.headers['cache-control'], 'no-store')
  assert.equal(visible.body, undefined)
  assert.equal(visible.payload, undefined)
  assert.equal(presence.count(1_000), 1)
})

test('deployment readiness waits for zero visible users while public state leaks no sessions', () => {
  const status = serverSource.slice(
    serverSource.indexOf('function deploymentDrainStatus'),
    serverSource.indexOf('\nfunction privacySafeDeploymentDrain'),
  )
  const publicDrain = serverSource.slice(
    serverSource.indexOf('function privacySafeDeploymentDrain'),
    serverSource.indexOf('\nasync function publicAmdQueueSnapshot'),
  )
  const protectedPayload = serverSource.slice(
    serverSource.indexOf('async function deploymentControlPayload'),
    serverSource.indexOf('\nasync function handleAcquireDeploymentDrain'),
  )

  assert.match(status, /const activeUserSessions = activeVisibleStorySessionCount\(\)/)
  assert.match(status, /activeUserSessions === 0/)
  assert.match(status, /activeUserSessions,/)
  assert.doesNotMatch(publicDrain, /activeUserSessions|sessionId|activeStorySessionPresence/)
  assert.match(protectedPayload, /\.\.\.snapshot\.deploymentDrain/)
})

test('browser queue polling sends presence only for a visible document', () => {
  const refresh = appSource.slice(
    appSource.indexOf('async function refreshQueueDetails'),
    appSource.indexOf('\nfunction setQueuePopoverOpen'),
  )
  assert.match(refresh, /document\.visibilityState === 'visible'/)
  assert.match(refresh, /'x-rukter-story-presence': 'visible'/)
  assert.match(refresh, /credentials: 'same-origin'/)
  assert.match(appSource, /document\.addEventListener\('visibilitychange'/)
  assert.match(appSource, /if \(document\.visibilityState === 'visible'\) \{[\s\S]*void refreshStoryPresence\(\)[\s\S]*void refreshQueueDetails\(\)/)
})

test('browser starts a dedicated presence heartbeat before asynchronous capacity refresh', () => {
  const heartbeat = appSource.slice(
    appSource.indexOf('async function refreshStoryPresence'),
    appSource.indexOf('\nfunction setQueuePopoverOpen'),
  )
  const configLoad = appSource.slice(
    appSource.indexOf('async function loadConfig'),
    appSource.indexOf('\nasync function resumeStoryFromUrl'),
  )
  const startup = appSource.slice(appSource.indexOf('loadConfig().then'))

  assert.match(heartbeat, /fetch\('\/api\/story-presence'/)
  assert.match(heartbeat, /method: 'POST'/)
  assert.match(heartbeat, /document\.visibilityState !== 'visible'/)
  assert.match(heartbeat, /'x-rukter-story-presence': 'visible'/)
  assert.match(heartbeat, /credentials: 'same-origin'/)
  assert.match(configLoad, /config = await response\.json\(\)[\s\S]*void refreshStoryPresence\(\)/)
  assert.match(configLoad, /if \(config\.amdGpuPublicEnabled\) void checkGpuCapacity\(\)/)
  assert.doesNotMatch(configLoad, /await checkGpuCapacity\(\)/)
  assert.match(startup, /setInterval\([\s\S]*void refreshStoryPresence\(\)[\s\S]*void refreshQueueDetails\(\)/)
})
