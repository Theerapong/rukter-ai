import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const zoneId = 'a'.repeat(32)
const rulesetId = 'b'.repeat(32)
const phase = 'http_request_firewall_custom'
const zoneName = 'rukter.ai'
const token = 'cf-test-token-never-log-this-value'

async function run(action, env) {
  return await new Promise((resolve) => {
    const child = spawn('bash', ['scripts/deployment-edge-gate.sh', action], {
      cwd: repoDir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

async function installCurlArgvProbe(ctx) {
  const binDir = path.join(ctx.tmp, 'bin')
  const argvLog = path.join(ctx.tmp, 'curl-argv.log')
  const curlShim = path.join(binDir, 'curl')
  await mkdir(binDir)
  await writeFile(curlShim, `#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do
  printf 'ARG:%s\\n' "$arg" >> "\${CURL_ARGV_LOG}"
  case "$arg" in
    @/*)
      if mode="$(stat -f '%Lp' "\${arg#@}" 2>/dev/null)"; then :; else mode="$(stat -c '%a' "\${arg#@}")"; fi
      [[ "$mode" == "600" ]]
      printf 'HEADER:%s\\n' "\${arg#@}" >> "\${CURL_ARGV_LOG}"
      ;;
  esac
done
exec "\${REAL_CURL}" "$@"
`)
  await chmod(curlShim, 0o700)
  ctx.env.PATH = `${binDir}:${process.env.PATH}`
  ctx.env.CURL_ARGV_LOG = argvLog
  ctx.env.REAL_CURL = '/usr/bin/curl'
  return argvLog
}

function ownerForCommit(commit) {
  return `rukter-ci-${commit}`
}

function fingerprint(owner) {
  return crypto.createHash('sha256').update(owner).digest('hex').slice(0, 16)
}

function gateIdentity(owner, signingToken = token) {
  const ownerFingerprint = fingerprint(owner)
  const headerKey = `X-Rukter-Deploy-Gate-${ownerFingerprint}`
  return {
    headerKey,
    headerValue: crypto.createHmac('sha256', signingToken).update(headerKey).digest('hex'),
    ref: `rukter_deploy_gate_${ownerFingerprint}`,
  }
}

const workerSourcePaths = new Set([
  '/amd-worker/bootstrap.sh',
  '/amd-worker/app.py',
  '/amd-worker/gpu_telemetry.py',
  '/amd-worker/identity_guard.py',
  '/amd-worker/requirements.txt',
  '/amd-worker/run_story_pipeline.py',
  '/amd-worker/run_story_pipeline.sh',
])

function uploadSourceExemptionExpression() {
  return '(starts_with(http.request.uri.path, "/uploads/") and len(http.request.uri.path) in {49 50} and http.request.uri.path.extension in {"png" "jpg" "webp" "avif" "gif" "mp4"} and substring(http.request.uri.path, 17, 18) eq "-" and substring(http.request.uri.path, 22, 23) eq "-" and substring(http.request.uri.path, 27, 28) eq "-" and substring(http.request.uri.path, 32, 33) eq "-" and substring(http.request.uri.path, 45, 46) eq "." and not (substring(http.request.uri.path, 9) contains "/") and not (substring(http.request.uri.path, 9) contains "%") and not (substring(http.request.uri.path, 9) contains "\\\\") and not (substring(http.request.uri.path, 9) contains ".."))'
}

function amdWorkerSourceExemptionExpression() {
  return '(http.request.uri.path in {"/amd-worker/bootstrap.sh" "/amd-worker/app.py" "/amd-worker/gpu_telemetry.py" "/amd-worker/identity_guard.py" "/amd-worker/requirements.txt" "/amd-worker/run_story_pipeline.py" "/amd-worker/run_story_pipeline.sh"})'
}

function gateRule(owner, expires, id = 'c'.repeat(32), signingToken = token) {
  const { headerKey, headerValue, ref } = gateIdentity(owner, signingToken)
  const headerName = headerKey.toLowerCase()
  return {
    id,
    action: 'block',
    expression: `(http.host in {"${zoneName}" "www.${zoneName}"} and http.request.timestamp.sec lt ${expires} and not any(http.request.headers["${headerName}"][*] eq "${headerValue}") and not ((http.request.method in {"GET" "HEAD"}) and (${uploadSourceExemptionExpression()} or ${amdWorkerSourceExemptionExpression()})) and not (http.request.method eq "POST" and http.request.uri.path eq "/api/amd-story-assets") and not (http.request.method eq "POST" and http.request.uri.path eq "/api/story-presence"))`,
    description: `Rukter deploy gate owner=${owner} expires=${expires}`,
    ref,
    enabled: true,
  }
}

function isSafeUploadSourcePath(rawPath, normalizedPath) {
  const path = normalizedPath
  if (!path.startsWith('/uploads/') || ![49, 50].includes(Buffer.byteLength(path))) return false
  if (!['png', 'jpg', 'webp', 'avif', 'gif', 'mp4'].includes(path.split('.').at(-1))) return false
  if (path[17] !== '-' || path[22] !== '-' || path[27] !== '-' || path[32] !== '-' || path[45] !== '.') return false
  const fileName = path.slice(9)
  return !fileName.includes('/') && !fileName.includes('%') && !fileName.includes('\\') && !fileName.includes('..')
}

function unrelatedRule(id = 'd'.repeat(32)) {
  return {
    id,
    action: 'skip',
    expression: '(http.request.uri.path eq "/unrelated")',
    description: 'Merchant-owned unrelated rule',
    ref: 'merchant_unrelated_rule',
    enabled: true,
  }
}

function queueBody() {
  return {
    activeJobPresent: false,
    queuedJobs: 0,
    readyJobs: 0,
    preparingJobs: 0,
    inProgressJobs: 0,
    planningJobs: 0,
    awaitingApprovalJobs: 0,
  }
}

async function startCloudflareMock(t, options = {}) {
  const calls = []
  let nextRuleId = 1
  let failNextRulesetFetch = false
  let ruleset = options.missingEntrypoint
    ? null
    : {
        id: rulesetId,
        name: 'Rukter production firewall',
        description: 'Existing custom firewall rules',
        kind: 'zone',
        phase,
        rules: structuredClone(options.rules ?? [unrelatedRule()]),
      }

  function responseRuleset() {
    const response = structuredClone(ruleset)
    if (options.omitEmptyRules && response?.rules?.length === 0) {
      delete response.rules
    }
    return response
  }

  function sendJson(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json' })
    if (status !== 204) res.end(JSON.stringify(value))
    else res.end()
  }

  function freshGate() {
    const now = Math.floor(Date.now() / 1000)
    return ruleset?.rules.find((rule) => {
      if (!rule.ref?.startsWith('rukter_deploy_gate_')) return false
      const expires = Number(rule.description?.match(/ expires=(\d{10,12})$/)?.[1] ?? 0)
      return expires > now && rule.enabled === true
    })
  }

  function gateBypassMatches(req, rule) {
    const match = rule.expression?.match(/http\.request\.headers\["([^"]+)"\]\[\*\] eq "([a-f0-9]{64})"/)
    if (!match) return false
    const received = req.headers[match[1]]
    return Array.isArray(received) ? received.includes(match[2]) : received === match[2]
  }

  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    calls.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      body,
      headers: { ...req.headers },
    })

    const rawPath = String(req.url || '/').split('?', 1)[0]
    const url = new URL(req.url, 'http://mock.local')
    const normalizedPath = url.pathname
    const isApi = url.pathname.startsWith('/client/v4/')
    if (isApi && req.headers.authorization !== `Bearer ${token}`) {
      sendJson(res, 403, { success: false, errors: [{ code: 9109 }] })
      return
    }

    if (req.method === 'GET' && url.pathname === '/client/v4/zones') {
      sendJson(res, 200, {
        success: true,
        result: [{ id: zoneId, name: zoneName, status: 'active' }],
        result_info: { total_count: 1 },
      })
      return
    }

    const entrypointPath = `/client/v4/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`
    if (req.method === 'GET' && url.pathname === entrypointPath) {
      if (!ruleset) {
        sendJson(res, 404, { success: false, errors: [{ code: 10000 }] })
      } else {
        sendJson(res, 200, { success: true, result: responseRuleset() })
      }
      return
    }

    if (req.method === 'POST' && url.pathname === `/client/v4/zones/${zoneId}/rulesets`) {
      const payload = JSON.parse(body)
      assert.equal(payload.kind, 'zone')
      assert.equal(payload.phase, phase)
      assert.equal(ruleset, null, 'entrypoint creation must happen only when absent')
      ruleset = {
        id: rulesetId,
        name: payload.name,
        description: payload.description,
        kind: payload.kind,
        phase: payload.phase,
        rules: [],
      }
      sendJson(res, 201, { success: true, result: responseRuleset() })
      return
    }

    if (req.method === 'GET' && url.pathname === `/client/v4/zones/${zoneId}/rulesets/${rulesetId}`) {
      if (failNextRulesetFetch) {
        failNextRulesetFetch = false
        sendJson(res, 500, { success: false, errors: [{ code: 10001 }] })
        return
      }
      sendJson(res, 200, { success: true, result: responseRuleset() })
      return
    }

    if (req.method === 'POST' && url.pathname === `/client/v4/zones/${zoneId}/rulesets/${rulesetId}/rules`) {
      const payload = JSON.parse(body)
      const id = (nextRuleId++).toString(16).padStart(32, 'e').slice(-32)
      const stored = { ...payload, id }
      delete stored.position
      if (payload.position?.index === 1) ruleset.rules.unshift(stored)
      else ruleset.rules.push(stored)
      sendJson(res, 201, { success: true, result: responseRuleset() })
      return
    }

    const rulePath = url.pathname.match(new RegExp(`^/client/v4/zones/${zoneId}/rulesets/${rulesetId}/rules/([a-f0-9]{32})$`))
    if (rulePath && req.method === 'PATCH') {
      const payload = JSON.parse(body)
      const index = ruleset.rules.findIndex((rule) => rule.id === rulePath[1])
      if (index < 0) {
        sendJson(res, 404, { success: false, errors: [{ code: 10000 }] })
        return
      }
      const [existing] = ruleset.rules.splice(index, 1)
      const stored = { ...existing, ...payload, id: existing.id }
      delete stored.position
      if (payload.position?.index === 1) ruleset.rules.unshift(stored)
      else ruleset.rules.splice(index, 0, stored)
      if (options.failRulesetFetchAfterPatch) failNextRulesetFetch = true
      sendJson(res, 200, { success: true, result: responseRuleset() })
      return
    }

    if (rulePath && req.method === 'DELETE') {
      ruleset.rules = ruleset.rules.filter((rule) => rule.id !== rulePath[1])
      sendJson(res, 200, { success: true, result: responseRuleset() })
      return
    }

    const gate = freshGate()
    if (gate) {
      const sourceRead = req.method === 'GET' || req.method === 'HEAD'
      const uploadsExempt = sourceRead && isSafeUploadSourcePath(rawPath, normalizedPath)
      const workerSourceExempt = sourceRead && workerSourcePaths.has(normalizedPath)
      const assetUploadExempt = req.method === 'POST' && normalizedPath === '/api/amd-story-assets'
      const presenceExempt = req.method === 'POST' && normalizedPath === '/api/story-presence'
      if (!uploadsExempt && !workerSourceExempt && !assetUploadExempt && !presenceExempt && !gateBypassMatches(req, gate)) {
        sendJson(res, 403, { error: 'cloudflare gate' })
        return
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/story-queue') {
      sendJson(res, 200, queueBody())
      return
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/uploads/')) {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && workerSourcePaths.has(url.pathname)) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(req.method === 'HEAD' ? undefined : '#!/usr/bin/env bash\n')
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/amd-story-assets') {
      sendJson(res, 401, { error: 'worker token required' })
      return
    }
    if (!options.legacyPresenceRoute && req.method === 'POST' && url.pathname === '/api/story-presence') {
      sendJson(res, 401, { error: 'story session required' })
      return
    }
    sendJson(res, 404, { error: 'not found' })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return {
    calls,
    get ruleset() { return structuredClone(ruleset) },
    removeRule(ruleId) {
      ruleset.rules = ruleset.rules.filter((rule) => rule.id !== ruleId)
    },
    url: `http://127.0.0.1:${server.address().port}`,
  }
}

async function setup(t, options = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rukter-cloudflare-gate-'))
  const stateFile = path.join(tmp, 'deployment-edge-gate.json')
  const mock = await startCloudflareMock(t, options)
  const commit = options.commit ?? '0123456789abcdef0123456789abcdef01234567'
  return {
    tmp,
    commit,
    owner: ownerForCommit(commit),
    stateFile,
    mock,
    env: {
      RUKTER_AI_CLOUDFLARE_API_TOKEN: token,
      DEPLOYMENT_EDGE_GATE_TEST_MODE: 'true',
      DEPLOYMENT_EDGE_GATE_API_URL: `${mock.url}/client/v4`,
      DEPLOYMENT_EDGE_GATE_PUBLIC_URL: mock.url,
      DEPLOYMENT_EDGE_GATE_STATE_FILE: stateFile,
      DEPLOYMENT_EDGE_GATE_TTL_SECONDS: '300',
      DEPLOYMENT_EDGE_GATE_VERIFY_ATTEMPTS: '3',
      DEPLOYMENT_EDGE_GATE_VERIFY_INTERVAL_SECONDS: '0',
      CI_COMMIT_SHA: commit,
      CI: '',
      GITLAB_CI: '',
    },
  }
}

async function httpStatus(url, options) {
  const response = await fetch(url, options)
  return response.status
}

test('production mode rejects test endpoints and CI rejects test-mode overrides before any request', async (t) => {
  const productionCtx = await setup(t)
  const productionResult = await run('acquire', {
    ...productionCtx.env,
    DEPLOYMENT_EDGE_GATE_PRODUCTION: 'true',
    DEPLOYMENT_EDGE_GATE_TEST_MODE: 'false',
  })
  assert.notEqual(productionResult.code, 0)
  assert.match(productionResult.stderr, /official Cloudflare API URL/)
  assert.equal(productionCtx.mock.calls.length, 0)

  const ciCtx = await setup(t)
  const ciResult = await run('acquire', {
    ...ciCtx.env,
    CI: 'true',
    GITLAB_CI: 'true',
  })
  assert.notEqual(ciResult.code, 0)
  assert.match(ciResult.stderr, /test overrides are forbidden/)
  assert.equal(ciCtx.mock.calls.length, 0)
})

test('Cloudflare lifecycle keeps the owned gate first, preserves unrelated rules, and verifies exact exemptions', async (t) => {
  const ctx = await setup(t)
  const identity = gateIdentity(ctx.owner)
  const curlArgvLog = await installCurlArgvProbe(ctx)
  const acquire = await run('acquire', ctx.env)
  assert.equal(acquire.code, 0, acquire.stderr)
  assert.doesNotMatch(`${acquire.stdout}${acquire.stderr}`, new RegExp(token))
  assert.doesNotMatch(`${acquire.stdout}${acquire.stderr}`, new RegExp(identity.headerValue))

  const state = JSON.parse(await readFile(ctx.stateFile, 'utf8'))
  assert.equal((await stat(ctx.stateFile)).mode & 0o777, 0o600)
  assert.equal(state.owner, ctx.owner)
  assert.equal(state.zone_id, zoneId)
  assert.equal(state.ruleset_id, rulesetId)
  assert.equal(state.rule_ref, identity.ref)
  assert.equal(state.header_key, identity.headerKey)
  assert.equal(state.header_value, identity.headerValue)
  assert.equal('ruleset' in state, false)
  assert.equal('expression' in state, false)

  assert.equal(ctx.mock.ruleset.rules[0].id, state.rule_id)
  assert.ok(ctx.mock.ruleset.rules.some((rule) => rule.ref === 'merchant_unrelated_rule'))
  const createCall = ctx.mock.calls.find((call) => call.method === 'POST' && call.url.endsWith('/rules'))
  assert.equal(JSON.parse(createCall.body).position.index, 1)

  assert.equal(await httpStatus(`${ctx.mock.url}/api/story-queue`), 403)
  assert.equal(await httpStatus(`${ctx.mock.url}/api/story-queue`, {
    headers: { [identity.headerKey]: identity.headerValue },
  }), 200)
  const safeImagePath = '/uploads/00000000-0000-4000-8000-000000000000.webp'
  const safeVideoPath = '/uploads/00000000-0000-4000-8000-000000000000.mp4'
  assert.equal(await httpStatus(`${ctx.mock.url}${safeImagePath}`), 404)
  assert.equal(await httpStatus(`${ctx.mock.url}${safeImagePath}`, { method: 'HEAD' }), 404)
  assert.equal(await httpStatus(`${ctx.mock.url}${safeVideoPath}`), 404)
  assert.equal(await httpStatus(`${ctx.mock.url}/uploads/input.jpg`), 403)
  assert.equal(await httpStatus(`${ctx.mock.url}/uploads/00000000-0000-4000-8000-000000000000.jpeg`), 403)
  assert.equal(await httpStatus(`${ctx.mock.url}/amd-worker/bootstrap.sh`), 200)
  assert.equal(await httpStatus(`${ctx.mock.url}/amd-worker/bootstrap.sh`, { method: 'HEAD' }), 200)
  assert.equal(await httpStatus(`${ctx.mock.url}/amd-worker/not-allowed.sh`), 403)
  assert.equal(await httpStatus(`${ctx.mock.url}/api/amd-story-assets`, { method: 'POST' }), 401)
  assert.equal(await httpStatus(`${ctx.mock.url}/api/story-presence`, { method: 'POST' }), 401)
  assert.equal(await httpStatus(`${ctx.mock.url}/api/story-presence`), 403)
  for (const traversalPath of [
    '/uploads/../api/story-queue',
    '/uploads/%2e%2e/api/story-queue',
    '/uploads/00000000-0000-4000-8000-000000000000.webp%2f..%2fapi%2fstory-queue',
    '/uploads/00000000-0000-4000-8000-000000000000.webp%5c..%5capi%5cstory-queue',
  ]) {
    assert.ok(ctx.mock.calls.some((call) => call.url === traversalPath), `missing raw traversal probe ${traversalPath}`)
  }

  const statusResult = await run('status', ctx.env)
  assert.equal(statusResult.code, 0, statusResult.stderr)
  const renew = await run('renew', ctx.env)
  assert.equal(renew.code, 0, renew.stderr)
  const renewedState = JSON.parse(await readFile(ctx.stateFile, 'utf8'))
  assert.equal(renewedState.rule_id, state.rule_id)
  assert.ok(renewedState.expires_epoch >= state.expires_epoch)
  assert.equal(ctx.mock.ruleset.rules[0].id, state.rule_id)
  assert.ok(ctx.mock.ruleset.rules.some((rule) => rule.ref === 'merchant_unrelated_rule'))

  const release = await run('release', ctx.env)
  assert.equal(release.code, 0, release.stderr)
  await assert.rejects(access(ctx.stateFile))
  assert.equal(ctx.mock.ruleset.rules.some((rule) => rule.ref === identity.ref), false)
  assert.ok(ctx.mock.ruleset.rules.some((rule) => rule.ref === 'merchant_unrelated_rule'))
  assert.equal(await httpStatus(`${ctx.mock.url}/api/story-queue`), 200)
  assert.ok(ctx.mock.calls.filter((call) => call.url.startsWith('/client/v4/')).every((call) => call.authorization === `Bearer ${token}`))
  assert.ok(!ctx.mock.calls.some((call) => /digitalocean|droplet|release-gpu|shutdown|poweroff/i.test(`${call.url} ${call.body}`)))
  const curlArgv = await readFile(curlArgvLog, 'utf8')
  assert.match(curlArgv, /^ARG:--path-as-is$/m)
  assert.doesNotMatch(curlArgv, new RegExp(token))
  assert.doesNotMatch(curlArgv, new RegExp(identity.headerValue))
  const privateHeaderFiles = [...new Set(curlArgv.split('\n').filter((line) => line.startsWith('HEADER:')).map((line) => line.slice(7)))]
  assert.ok(privateHeaderFiles.length > 0)
  for (const headerFile of privateHeaderFiles) await assert.rejects(access(headerFile))
})

test('a fresh foreign owner refuses without any Cloudflare mutation', async (t) => {
  const foreignOwner = 'rukter-ci-foreign-owner-1234567890'
  const foreign = gateRule(foreignOwner, Math.floor(Date.now() / 1000) + 600, '1'.repeat(32))
  const staleOwner = 'rukter-ci-stale-owner-123456789012'
  const stale = gateRule(staleOwner, Math.floor(Date.now() / 1000) - 10, '9'.repeat(32))
  const originalRules = [stale, foreign, unrelatedRule()]
  const ctx = await setup(t, { rules: originalRules })
  const result = await run('acquire', ctx.env)
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /already owned by/)
  assert.equal(ctx.mock.calls.some((call) => ['POST', 'PATCH', 'DELETE'].includes(call.method)), false)
  await assert.rejects(access(ctx.stateFile))
  assert.deepEqual(ctx.mock.ruleset.rules, originalRules)
})

test('expired foreign gates are deleted before acquiring a new owned gate', async (t) => {
  const expiredOwner = 'rukter-ci-expired-owner-123456789'
  const expired = gateRule(expiredOwner, Math.floor(Date.now() / 1000) - 10, '2'.repeat(32))
  const ctx = await setup(t, { rules: [expired, unrelatedRule()] })
  const result = await run('acquire', ctx.env)
  assert.equal(result.code, 0, result.stderr)
  const deleteIndex = ctx.mock.calls.findIndex((call) => call.method === 'DELETE' && call.url.endsWith(`/${expired.id}`))
  const createIndex = ctx.mock.calls.findIndex((call) => call.method === 'POST' && call.url.endsWith('/rules'))
  assert.ok(deleteIndex >= 0)
  assert.ok(createIndex > deleteIndex)
  assert.equal(ctx.mock.ruleset.rules.some((rule) => rule.id === expired.id), false)
  assert.ok(ctx.mock.ruleset.rules.some((rule) => rule.ref === gateIdentity(ctx.owner).ref))
  assert.ok(ctx.mock.ruleset.rules.some((rule) => rule.ref === 'merchant_unrelated_rule'))
  assert.equal((await run('release', ctx.env)).code, 0)
})

test('an expired gate signed by a rotated-out token is safely removed before acquisition', async (t) => {
  const oldToken = 'cf-rotated-out-token'
  const expiredOwner = 'rukter-ci-old-token-expired-123456789'
  const expired = gateRule(expiredOwner, Math.floor(Date.now() / 1000) - 10, '4'.repeat(32), oldToken)
  const ctx = await setup(t, { rules: [expired, unrelatedRule()] })

  const result = await run('acquire', ctx.env)

  assert.equal(result.code, 0, result.stderr)
  const deleteIndex = ctx.mock.calls.findIndex((call) => call.method === 'DELETE' && call.url.endsWith(`/${expired.id}`))
  const createIndex = ctx.mock.calls.findIndex((call) => call.method === 'POST' && call.url.endsWith('/rules'))
  assert.ok(deleteIndex >= 0)
  assert.ok(createIndex > deleteIndex)
  assert.equal(ctx.mock.ruleset.rules.some((rule) => rule.id === expired.id), false)
  assert.ok(ctx.mock.ruleset.rules.some((rule) => rule.ref === gateIdentity(ctx.owner).ref))
  assert.equal((await run('release', ctx.env)).code, 0)
})

test('an expired old-token rule with an altered exemption refuses without mutation', async (t) => {
  const expiredOwner = 'rukter-ci-old-token-altered-123456789'
  const expired = gateRule(
    expiredOwner,
    Math.floor(Date.now() / 1000) - 10,
    '7'.repeat(32),
    'cf-rotated-out-token',
  )
  expired.expression = expired.expression.replace('/api/amd-story-assets', '/api/unsafe-extra-exemption')
  const originalRules = [expired, unrelatedRule()]
  const ctx = await setup(t, { rules: originalRules })

  const result = await run('acquire', ctx.env)

  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /invalid static shape/)
  assert.equal(ctx.mock.calls.some((call) => ['POST', 'PATCH', 'DELETE'].includes(call.method)), false)
  await assert.rejects(access(ctx.stateFile))
  assert.deepEqual(ctx.mock.ruleset.rules, originalRules)
})

test('a fresh same-owner gate signed by a rotated-out token refuses without any mutation', async (t) => {
  const oldToken = 'cf-rotated-out-token'
  const commit = 'abcdef0123456789abcdef0123456789abcdef01'
  const owner = ownerForCommit(commit)
  const staleOwner = 'rukter-ci-stale-before-old-token-12345'
  const stale = gateRule(staleOwner, Math.floor(Date.now() / 1000) - 10, '5'.repeat(32))
  const freshOldToken = gateRule(owner, Math.floor(Date.now() / 1000) + 600, '6'.repeat(32), oldToken)
  const originalRules = [stale, freshOldToken, unrelatedRule()]
  const ctx = await setup(t, { commit, rules: originalRules })

  const result = await run('acquire', ctx.env)

  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /signed by another token/)
  assert.equal(ctx.mock.calls.some((call) => ['POST', 'PATCH', 'DELETE'].includes(call.method)), false)
  await assert.rejects(access(ctx.stateFile))
  assert.deepEqual(ctx.mock.ruleset.rules, originalRules)
})

test('same-owner acquisition recovers and renews an existing gate without state', async (t) => {
  const commit = 'fedcba9876543210fedcba9876543210fedcba98'
  const owner = ownerForCommit(commit)
  const existing = gateRule(owner, Math.floor(Date.now() / 1000) + 300, '3'.repeat(32))
  const ctx = await setup(t, { commit, rules: [unrelatedRule(), existing] })
  const result = await run('acquire', ctx.env)
  assert.equal(result.code, 0, result.stderr)
  const state = JSON.parse(await readFile(ctx.stateFile, 'utf8'))
  assert.equal(state.rule_id, existing.id)
  assert.equal(ctx.mock.ruleset.rules[0].id, existing.id)
  assert.equal(ctx.mock.calls.some((call) => call.method === 'POST' && call.url.endsWith('/rules')), false)
  assert.ok(ctx.mock.calls.some((call) => call.method === 'PATCH' && call.url.endsWith(`/${existing.id}`)))
  assert.ok(ctx.mock.ruleset.rules.some((rule) => rule.ref === 'merchant_unrelated_rule'))
  assert.equal((await run('release', ctx.env)).code, 0)
})

test('release recovers the exact same-owner gate when acquire lost local state', async (t) => {
  const ctx = await setup(t)
  const acquired = await run('acquire', ctx.env)
  assert.equal(acquired.code, 0, acquired.stderr)
  const ownedRef = gateIdentity(ctx.owner).ref
  await unlink(ctx.stateFile)

  const released = await run('release', ctx.env)
  assert.equal(released.code, 0, released.stderr)
  assert.match(released.stdout, /Recovered and released/)
  assert.equal(ctx.mock.ruleset.rules.some((rule) => rule.ref === ownedRef), false)
  assert.ok(ctx.mock.ruleset.rules.some((rule) => rule.ref === 'merchant_unrelated_rule'))
  assert.equal(await httpStatus(`${ctx.mock.url}/api/story-queue`), 200)
})

test('release recovers after renew PATCH succeeds but the updated state is not published', async (t) => {
  const ctx = await setup(t, { failRulesetFetchAfterPatch: true })
  const acquired = await run('acquire', ctx.env)
  assert.equal(acquired.code, 0, acquired.stderr)
  const stateBeforeRenew = JSON.parse(await readFile(ctx.stateFile, 'utf8'))

  const renew = await run('renew', {
    ...ctx.env,
    DEPLOYMENT_EDGE_GATE_TTL_SECONDS: '600',
  })

  assert.notEqual(renew.code, 0)
  assert.match(renew.stderr, /ruleset lookup failed/)
  const staleState = JSON.parse(await readFile(ctx.stateFile, 'utf8'))
  assert.equal(staleState.expires_epoch, stateBeforeRenew.expires_epoch)
  const liveRule = ctx.mock.ruleset.rules.find((rule) => rule.id === stateBeforeRenew.rule_id)
  const liveExpiry = Number(liveRule.description.match(/expires=(\d+)$/)?.[1])
  assert.ok(liveExpiry > staleState.expires_epoch)

  const released = await run('release', ctx.env)
  assert.equal(released.code, 0, released.stderr)
  await assert.rejects(access(ctx.stateFile))
  assert.equal(ctx.mock.ruleset.rules.some((rule) => rule.id === stateBeforeRenew.rule_id), false)
  assert.equal(await httpStatus(`${ctx.mock.url}/api/story-queue`), 200)
})

test('status fails closed if the gate is removed after an earlier successful status', async (t) => {
  const ctx = await setup(t)
  const acquired = await run('acquire', ctx.env)
  assert.equal(acquired.code, 0, acquired.stderr)
  const state = JSON.parse(await readFile(ctx.stateFile, 'utf8'))
  const preStatus = await run('status', ctx.env)
  assert.equal(preStatus.code, 0, preStatus.stderr)

  ctx.mock.removeRule(state.rule_id)
  const postStatus = await run('status', ctx.env)

  assert.notEqual(postStatus.code, 0)
  assert.match(postStatus.stderr, /not first|exact owned deployment gate/)
  assert.equal((await run('release', ctx.env)).code, 0)
})

test('acquire creates the zone entrypoint only when it is missing', async (t) => {
  const ctx = await setup(t, { missingEntrypoint: true })
  const result = await run('acquire', ctx.env)
  assert.equal(result.code, 0, result.stderr)
  const entrypointCreate = ctx.mock.calls.find((call) => call.method === 'POST' && call.url === `/client/v4/zones/${zoneId}/rulesets`)
  assert.ok(entrypointCreate)
  const payload = JSON.parse(entrypointCreate.body)
  assert.equal(payload.kind, 'zone')
  assert.equal(payload.phase, phase)
  assert.equal(ctx.mock.ruleset.rules[0].ref, gateIdentity(ctx.owner).ref)
  assert.equal((await run('release', ctx.env)).code, 0)
})

test('acquire accepts Cloudflare empty entrypoints without a rules array', async (t) => {
  const ctx = await setup(t, { missingEntrypoint: true, omitEmptyRules: true })
  const result = await run('acquire', ctx.env)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(ctx.mock.ruleset.rules[0].ref, gateIdentity(ctx.owner).ref)
  assert.equal((await run('release', ctx.env)).code, 0)
})

test('legacy bootstrap accepts a 404 presence probe while GET remains blocked', async (t) => {
  const ctx = await setup(t, { legacyPresenceRoute: true })
  const acquired = await run('acquire', ctx.env)
  assert.equal(acquired.code, 0, acquired.stderr)
  assert.equal(await httpStatus(`${ctx.mock.url}/api/story-presence`, { method: 'POST' }), 404)
  assert.equal(await httpStatus(`${ctx.mock.url}/api/story-presence`), 403)
  assert.equal((await run('status', ctx.env)).code, 0)
  assert.equal((await run('release', ctx.env)).code, 0)
})
