import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function run(command, args, env) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
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

test('production apply owns one fail-closed drain transaction through AMD bootstrap', async () => {
  const ci = await readFile(path.join(repoDir, '.gitlab-ci.yml'), 'utf8')
  const applyJob = ci.slice(ci.indexOf('terraform:apply:digitalocean:'), ci.indexOf('verify:rukter-ai:digitalocean:'))

  assert.match(applyJob, /resource_group: rukter-ai-terraform-digitalocean/)
  assert.match(applyJob, /timeout: 4h/)
  assert.doesNotMatch(ci, /^terraform:plan:digitalocean:/m)
  assert.ok(applyJob.indexOf('deployment-drain.sh acquire') < applyJob.indexOf('wait-live-amd-queue-idle.sh'))
  assert.ok(applyJob.indexOf('wait-live-amd-queue-idle.sh') < applyJob.indexOf('terraform -chdir="${TF_DO_ENV_DIR}" apply'))
  assert.ok(applyJob.indexOf('terraform -chdir="${TF_DO_ENV_DIR}" apply') < applyJob.indexOf('bootstrap-persistent-amd.sh'))
  assert.ok(applyJob.indexOf('verify-live-deployment.sh') < applyJob.indexOf('DEPLOYMENT_DRAIN_REQUIRE_SUPPORTED=true'))
  assert.ok(applyJob.indexOf('bootstrap-persistent-amd.sh') < applyJob.lastIndexOf('wait-live-amd-queue-idle.sh'))
  assert.ok(applyJob.lastIndexOf('wait-live-amd-queue-idle.sh') < applyJob.indexOf('deployment-drain.sh release'))
  assert.match(applyJob, /assert-current-main-sha\.sh[\s\S]*assert-current-main-sha\.sh/)
  assert.match(applyJob, /pre_apply[\s\S]*apply_started[\s\S]*after_script:/)
  assert.match(applyJob, /apply_started[\s\S]*fail-closed TTL fence/)
  assert.match(applyJob, /DEPLOYMENT_DRAIN_BOOTSTRAP_COMPATIBILITY=true[\s\S]*DEPLOYMENT_DRAIN_BOOTSTRAP_COMPATIBILITY=true/)
  assert.doesNotMatch(applyJob, /\/release-gpu|shutdown -h|poweroff/i)
})

test('drain scripts require ownership, every queue class, worker evidence, and continuous idle', async () => {
  const control = await readFile(path.join(repoDir, 'scripts/deployment-drain.sh'), 'utf8')
  const wait = await readFile(path.join(repoDir, 'scripts/wait-live-amd-queue-idle.sh'), 'utf8')

  assert.match(control, /POST \/v1\/deployment-drain\/acquire/)
  assert.match(control, /GET \/v1\/deployment-drain/)
  assert.match(control, /POST \/v1\/deployment-drain\/release/)
  assert.match(control, /Authorization: Bearer \$\{AMD_GPU_ORCHESTRATOR_TOKEN\}/)
  assert.match(control, /CI_COMMIT_BEFORE_SHA/)
  assert.match(control, /not the explicitly pinned bootstrap pipeline/)
  assert.match(control, /CI_COMMIT_SHA/)
  assert.doesNotMatch(control, /CI_JOB_ID/)
  assert.match(control, /AMD_GPU_DIGITALOCEAN_TOKEN/)
  assert.match(control, /acquire_legacy_durable_fence/)
  assert.match(control, /release_legacy_durable_fence/)
  assert.match(wait, /activeAdmittedRequests/)
  for (const field of ['queuedJobs', 'readyJobs', 'preparingJobs', 'inProgressJobs', 'planningJobs', 'awaitingApprovalJobs']) {
    assert.match(wait, new RegExp(field))
  }
  assert.match(wait, /readyForDeploy/)
  assert.match(wait, /workerActivity\.verifiable/)
  assert.match(wait, /deployment-drain\.sh" renew/)
  assert.match(wait, /stable_since/)
  assert.match(wait, /DEPLOYMENT_DRAIN_BOOTSTRAP_COMPATIBILITY/)
  assert.match(wait, /CI_COMMIT_BEFORE_SHA/)
})

test('acquire, strict idle verification, and owned release use the protected API contract', async (t) => {
  const calls = []
  let active = false
  let drainId = ''
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body })
    res.setHeader('content-type', 'application/json')
    if (req.method === 'POST' && req.url === '/v1/deployment-drain/acquire') {
      const parsed = JSON.parse(body)
      active = true
      drainId = parsed.drainId
      res.writeHead(201)
    } else if (req.method === 'POST' && req.url === '/v1/deployment-drain/release') {
      assert.equal(JSON.parse(body).drainId, drainId)
      active = false
      res.writeHead(200)
    } else if (req.method === 'GET' && req.url === '/v1/deployment-drain') {
      res.writeHead(200)
    } else {
      res.writeHead(404)
    }
    res.end(JSON.stringify({
      supported: true,
      active,
      state: active ? 'active' : 'inactive',
      drainId: active ? drainId : '',
      drainIds: active ? [drainId] : [],
      admissionLocked: active,
      activeAdmittedRequests: 0,
      quietForSeconds: 45,
      quietWindowSeconds: 30,
      workerActivity: { reachable: true, verifiable: true, idle: true, acceptingJobs: true },
      queue: {
        activeJobPresent: false,
        queuedJobs: 0,
        readyJobs: 0,
        preparingJobs: 0,
        inProgressJobs: 0,
        planningJobs: 0,
        awaitingApprovalJobs: 0,
      },
      readyForDeploy: active,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      checkedAt: new Date().toISOString(),
    }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rukter-deploy-drain-'))
  const env = {
    AMD_GPU_ORCHESTRATOR_TOKEN: 'test-control-token',
    RUKTER_AI_PUBLIC_URL: `http://127.0.0.1:${server.address().port}`,
    DEPLOYMENT_DRAIN_STATE_FILE: path.join(tmp, 'drain.env'),
    DEPLOYMENT_DRAIN_STABLE_SECONDS: '0',
    DEPLOYMENT_DRAIN_POLL_SECONDS: '1',
    CI_COMMIT_SHA: '0123456789abcdef0123456789abcdef01234567',
    CI_PIPELINE_ID: '1234',
    CI_JOB_ID: '5678',
  }
  const acquire = await run('bash', ['scripts/deployment-drain.sh', 'acquire'], env)
  assert.equal(acquire.code, 0, acquire.stderr)
  const state = await readFile(env.DEPLOYMENT_DRAIN_STATE_FILE, 'utf8')
  assert.match(state, /^mode=active$/m)
  assert.match(state, /^drain_id=rukter_ci_0123456789abcdef0123456789abcdef01234567$/m)

  const wait = await run('bash', ['scripts/wait-live-amd-queue-idle.sh'], env)
  assert.equal(wait.code, 0, wait.stderr)
  assert.match(wait.stdout, /deploy may continue/)

  const release = await run('bash', ['scripts/deployment-drain.sh', 'release'], env)
  assert.equal(release.code, 0, release.stderr)
  assert.equal(active, false)
  assert.deepEqual(calls.map(({ method, url }) => `${method} ${url}`), [
    'POST /v1/deployment-drain/acquire',
    'GET /v1/deployment-drain',
    'POST /v1/deployment-drain/release',
  ])
  assert.ok(calls.every((call) => call.authorization === 'Bearer test-control-token'))
})

test('a later pipeline fails closed when the protected drain API is absent', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(405, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rukter-deploy-closed-'))
  const result = await run('bash', ['scripts/deployment-drain.sh', 'acquire'], {
    AMD_GPU_ORCHESTRATOR_TOKEN: 'test-control-token',
    RUKTER_AI_PUBLIC_URL: `http://127.0.0.1:${server.address().port}`,
    DEPLOYMENT_DRAIN_STATE_FILE: path.join(tmp, 'drain.env'),
    DEPLOYMENT_DRAIN_LEGACY_PARENT_SHA: 'old-main-sha',
    CI_COMMIT_BEFORE_SHA: 'newer-main-sha',
  })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /refusing to deploy/)
})

test('only the pinned first rollout can use the old app 405 idle-window bridge', async (t) => {
  const calls = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body })
    if (req.method === 'GET' && req.url?.startsWith('/v2/droplets?tag_name=')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ droplets: [{ id: 584070698 }] }))
      return
    }
    if (req.method === 'POST' && req.url === '/v2/tags') {
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ tag: { name: JSON.parse(body).name } }))
      return
    }
    if (req.url?.match(/^\/v2\/tags\/rukter-deploy-drain-[A-Za-z0-9_-]+-until-\d+\/resources$/)) {
      res.writeHead(204)
      res.end()
      return
    }
    if (req.method === 'DELETE' && req.url?.match(/^\/v2\/tags\/rukter-deploy-drain-[A-Za-z0-9_-]+-until-\d+$/)) {
      res.writeHead(204)
      res.end()
      return
    }
    res.writeHead(405, { 'content-type': 'text/plain' })
    res.end('Method not allowed')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rukter-deploy-legacy-'))
  const stateFile = path.join(tmp, 'drain.env')
  const result = await run('bash', ['scripts/deployment-drain.sh', 'acquire'], {
    AMD_GPU_ORCHESTRATOR_TOKEN: 'test-control-token',
    AMD_GPU_DIGITALOCEAN_TOKEN: 'test-do-token',
    AMD_GPU_DIGITALOCEAN_API_URL: `http://127.0.0.1:${server.address().port}/v2`,
    RUKTER_AI_PUBLIC_URL: `http://127.0.0.1:${server.address().port}`,
    DEPLOYMENT_DRAIN_STATE_FILE: stateFile,
    DEPLOYMENT_DRAIN_LEGACY_PARENT_SHA: 'pinned-old-main-sha',
    CI_COMMIT_BEFORE_SHA: 'pinned-old-main-sha',
  })
  assert.equal(result.code, 0, result.stderr)
  const state = await readFile(stateFile, 'utf8')
  assert.match(state, /^mode=legacy$/m)
  assert.match(state, /^legacy_tag=rukter-deploy-drain-rukter_ci_[A-Za-z0-9_-]+-until-\d+$/m)
  assert.match(state, /^legacy_droplet_id=584070698$/m)
  assert.match(result.stderr, /Attached the one-time durable deployment fence/)
  assert.match(result.stderr, /one bootstrap pipeline/)

  const release = await run('bash', ['scripts/deployment-drain.sh', 'release'], {
    AMD_GPU_ORCHESTRATOR_TOKEN: 'test-control-token',
    AMD_GPU_DIGITALOCEAN_TOKEN: 'test-do-token',
    AMD_GPU_DIGITALOCEAN_API_URL: `http://127.0.0.1:${server.address().port}/v2`,
    DEPLOYMENT_DRAIN_STATE_FILE: stateFile,
  })
  assert.equal(release.code, 0, release.stderr)
  assert.match(release.stdout, /Released the owned first-deployment TTL fence/)
  assert.equal(calls[0].url, '/v1/deployment-drain/acquire')
  assert.equal(calls[0].authorization, 'Bearer test-control-token')
  assert.ok(calls.slice(1).every((call) => call.authorization === 'Bearer test-do-token'))
  assert.ok(calls.some((call) => call.method === 'POST' && call.url === '/v2/tags'))
  assert.ok(calls.some((call) => call.method === 'DELETE' && call.url?.endsWith('/resources')))
  assert.ok(calls.some((call) => call.method === 'DELETE' && !call.url?.endsWith('/resources')))
})
