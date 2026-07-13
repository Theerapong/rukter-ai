import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
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
  const watchdog = await readFile(path.join(repoDir, 'scripts/run-terraform-apply-with-watchdog.sh'), 'utf8')
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
  assert.match(applyJob, /pre_apply[\s\S]*after_script:/)
  assert.doesNotMatch(applyJob, /printf 'apply_started/)
  assert.match(watchdog, /mark_apply_started \|\| exit 1[\s\S]*set -m[\s\S]*__run_owned_apply/)
  assert.match(applyJob, /apply_started[\s\S]*fail-closed TTL fence/)
  assert.match(applyJob, /DEPLOYMENT_DRAIN_BOOTSTRAP_COMPATIBILITY=true[\s\S]*DEPLOYMENT_DRAIN_BOOTSTRAP_COMPATIBILITY=true/)
  assert.match(applyJob, /if \[\[ "\$\{phase\}" == "pre_apply" \]\][\s\S]*bash scripts\/deployment-drain\.sh release/)
  assert.doesNotMatch(applyJob, /if \[\[ -r \.ci-artifacts\/deployment-drain\.env \]\]/)
  assert.doesNotMatch(applyJob, /\/release-gpu|shutdown -h|poweroff/i)
})

test('drain scripts require ownership, every queue class, worker evidence, and continuous idle', async () => {
  const control = await readFile(path.join(repoDir, 'scripts/deployment-drain.sh'), 'utf8')
  const wait = await readFile(path.join(repoDir, 'scripts/wait-live-amd-queue-idle.sh'), 'utf8')
  const mainGuard = await readFile(path.join(repoDir, 'scripts/assert-current-main-sha.sh'), 'utf8')

  assert.match(control, /GET \/v1\/deployment-drain/)
  assert.match(control, /printf 'Authorization: Bearer %s\\n' "\$\{AMD_GPU_ORCHESTRATOR_TOKEN\}"/)
  assert.match(control, /chmod 600 "\$\{header_file\}"/)
  assert.match(control, /--header "@\$\{header_file\}"/)
  assert.doesNotMatch(control, /-H "Authorization: Bearer \$\{AMD_GPU_ORCHESTRATOR_TOKEN\}"/)
  assert.match(control, /CI_COMMIT_BEFORE_SHA/)
  assert.match(control, /DEPLOYMENT_DRAIN_BOOTSTRAP_APPROVED_SHA/)
  assert.match(control, /is_pinned_legacy_rollout/)
  assert.match(control, /CI_COMMIT_SHA/)
  assert.doesNotMatch(control, /CI_JOB_ID/)
  assert.match(control, /deployment_digitalocean_token/)
  assert.match(control, /DIGITALOCEAN_TOKEN/)
  assert.match(control, /acquire_durable_fence/)
  assert.match(control, /release_all_owned_durable_tags/)
  assert.match(control, /mktemp "\$\{state_file\}\.tmp\.XXXXXX"/)
  assert.match(control, /chmod 600 "\$\{state_tmp\}"/)
  assert.match(control, /Refusing to write deployment drain state through a symbolic link/)
  assert.doesNotMatch(control, /request POST \/v1\/deployment-drain/)
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
  assert.match(mainGuard, /git ls-remote --heads origin/)
  assert.doesNotMatch(mainGuard, /repository\/branches|JOB-TOKEN/)
})

test('CI owns the durable tag while the app only verifies it through the protected read API', async (t) => {
  const calls = []
  const dropletId = 584070698
  const dropletTags = ['rukter-product-story-persistent']
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body })
    res.setHeader('content-type', 'application/json')
    if (req.method === 'GET' && req.url?.startsWith('/v2/droplets?tag_name=')) {
      res.writeHead(200)
      res.end(JSON.stringify({ droplets: [{ id: dropletId, tags: dropletTags }] }))
      return
    }
    if (req.method === 'POST' && req.url === '/v2/tags') {
      res.writeHead(201)
      res.end(JSON.stringify({ tag: { name: JSON.parse(body).name } }))
      return
    }
    const resourceMatch = req.url?.match(/^\/v2\/tags\/([^/]+)\/resources$/)
    if (resourceMatch && req.method === 'POST') {
      const tag = decodeURIComponent(resourceMatch[1])
      if (!dropletTags.includes(tag)) dropletTags.push(tag)
      res.writeHead(204)
      res.end()
      return
    }
    if (resourceMatch && req.method === 'DELETE') {
      const tag = decodeURIComponent(resourceMatch[1])
      const index = dropletTags.indexOf(tag)
      if (index >= 0) dropletTags.splice(index, 1)
      res.writeHead(204)
      res.end()
      return
    }
    if (req.method === 'DELETE' && req.url?.startsWith('/v2/tags/')) {
      res.writeHead(204)
      res.end()
      return
    }
    if (req.method === 'GET' && req.url === '/v1/deployment-drain') {
      const drainIds = dropletTags
        .map((tag) => tag.match(/^rukter-deploy-drain-([A-Za-z0-9_-]{12,64})-until-(\d{10,12})$/))
        .filter((match) => match && Number(match[2]) * 1000 > Date.now())
        .map((match) => match[1])
      const active = drainIds.length > 0
      res.writeHead(200)
      res.end(JSON.stringify({
        supported: true,
        active,
        state: active ? 'active' : 'inactive',
        drainId: drainIds.length === 1 ? drainIds[0] : '',
        drainIds,
        admissionLocked: active,
        activeAdmittedRequests: 0,
        activeUserSessions: 0,
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
        expiresAt: active ? new Date(Date.now() + 60_000).toISOString() : null,
        checkedAt: new Date().toISOString(),
      }))
      return
    }
    res.writeHead(404)
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rukter-deploy-drain-'))
  const env = {
    AMD_GPU_ORCHESTRATOR_TOKEN: 'test-control-token',
    AMD_GPU_DIGITALOCEAN_TOKEN: 'amd-ci-do-token',
    DIGITALOCEAN_TOKEN: 'general-ci-do-token',
    DEPLOYMENT_DRAIN_DIGITALOCEAN_API_URL: `http://127.0.0.1:${server.address().port}/v2`,
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
  assert.equal((await stat(env.DEPLOYMENT_DRAIN_STATE_FILE)).mode & 0o777, 0o600)
  assert.match(state, /^mode=active$/m)
  assert.match(state, /^drain_id=rukter_ci_0123456789abcdef0123456789abcdef01234567$/m)
  assert.match(state, /^owned_tag=rukter-deploy-drain-rukter_ci_0123456789abcdef0123456789abcdef01234567-until-\d+$/m)
  assert.match(state, /^droplet_id=584070698$/m)

  const renew = await run('bash', ['scripts/deployment-drain.sh', 'renew'], {
    ...env,
    DEPLOYMENT_DRAIN_TTL_SECONDS: '300',
  })
  assert.equal(renew.code, 0, renew.stderr)
  assert.equal(dropletTags.filter((tag) => tag.startsWith('rukter-deploy-drain-')).length, 1)

  const wait = await run('bash', ['scripts/wait-live-amd-queue-idle.sh'], env)
  assert.equal(wait.code, 0, wait.stderr)
  assert.match(wait.stdout, /deploy may continue/)

  const release = await run('bash', ['scripts/deployment-drain.sh', 'release'], env)
  assert.equal(release.code, 0, release.stderr)
  assert.equal(dropletTags.some((tag) => tag.startsWith('rukter-deploy-drain-')), false)
  const appCalls = calls.filter((call) => call.url === '/v1/deployment-drain')
  const doCalls = calls.filter((call) => call.url?.startsWith('/v2/'))
  assert.ok(appCalls.length >= 3)
  assert.ok(appCalls.every((call) => call.method === 'GET' && call.authorization === 'Bearer test-control-token'))
  assert.ok(doCalls.every((call) => call.authorization === 'Bearer amd-ci-do-token'))
  assert.ok(doCalls.some((call) => call.method === 'POST' && call.url === '/v2/tags'))
  assert.ok(doCalls.some((call) => call.method === 'POST' && call.url?.endsWith('/resources')))
  assert.ok(doCalls.some((call) => call.method === 'DELETE' && call.url?.endsWith('/resources')))
  assert.ok(!calls.some((call) => call.method === 'POST' && call.url?.startsWith('/v1/deployment-drain')))

  const symlinkTarget = path.join(tmp, 'state-target.txt')
  await writeFile(symlinkTarget, 'must remain unchanged\n')
  await rm(env.DEPLOYMENT_DRAIN_STATE_FILE)
  await symlink(symlinkTarget, env.DEPLOYMENT_DRAIN_STATE_FILE)
  const symlinkAcquire = await run('bash', ['scripts/deployment-drain.sh', 'acquire'], env)
  assert.notEqual(symlinkAcquire.code, 0)
  assert.match(symlinkAcquire.stderr, /Refusing to write deployment drain state through a symbolic link/)
  assert.equal(await readFile(symlinkTarget, 'utf8'), 'must remain unchanged\n')
})

test('release recovers from lost state by removing only the current owner tags without touching the worker', async (t) => {
  const calls = []
  const commit = '0123456789abcdef0123456789abcdef01234567'
  const owner = `rukter_ci_${commit}`
  const foreignOwner = 'foreign_owner_123'
  const now = Math.floor(Date.now() / 1000)
  const ownedTag = `rukter-deploy-drain-${owner}-until-${now + 3600}`
  const foreignTag = `rukter-deploy-drain-${foreignOwner}-until-${now + 3600}`
  const dropletTags = ['rukter-product-story-persistent', ownedTag, foreignTag]
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body })
    res.setHeader('content-type', 'application/json')
    if (req.method === 'GET' && req.url?.startsWith('/v2/droplets?tag_name=')) {
      res.writeHead(200)
      res.end(JSON.stringify({ droplets: [{ id: 584070698, tags: dropletTags }] }))
      return
    }
    const resourceMatch = req.url?.match(/^\/v2\/tags\/([^/]+)\/resources$/)
    if (resourceMatch && req.method === 'DELETE') {
      const tag = decodeURIComponent(resourceMatch[1])
      const index = dropletTags.indexOf(tag)
      if (index >= 0) dropletTags.splice(index, 1)
      res.writeHead(204)
      res.end()
      return
    }
    if (req.method === 'DELETE' && req.url?.startsWith('/v2/tags/')) {
      res.writeHead(204)
      res.end()
      return
    }
    res.writeHead(500)
    res.end(JSON.stringify({ error: 'unexpected request' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rukter-deploy-lost-state-'))
  const result = await run('bash', ['scripts/deployment-drain.sh', 'release'], {
    DIGITALOCEAN_TOKEN: 'ci-do-token',
    DEPLOYMENT_DRAIN_DIGITALOCEAN_API_URL: `http://127.0.0.1:${server.address().port}/v2`,
    DEPLOYMENT_DRAIN_STATE_FILE: path.join(tmp, 'missing-drain.env'),
    CI_COMMIT_SHA: commit,
  })

  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stderr, /state is absent; recovering release for current owner/)
  assert.match(result.stdout, new RegExp(`Released deployment drain ${owner}`))
  assert.equal(dropletTags.includes(ownedTag), false)
  assert.equal(dropletTags.includes(foreignTag), true)
  assert.equal(dropletTags.includes('rukter-product-story-persistent'), true)
  assert.ok(calls.every((call) => call.authorization === 'Bearer ci-do-token'))
  assert.ok(calls.some((call) => call.method === 'DELETE' && call.url?.includes(encodeURIComponent(ownedTag))))
  assert.ok(!calls.some((call) => call.method !== 'GET' && /\/droplets(?:\/|\?|$)/.test(call.url || '')))
  assert.ok(!calls.some((call) => /\/actions(?:\/|\?|$)/.test(call.url || '')))
  assert.ok(!calls.some((call) => call.url?.includes(encodeURIComponent(foreignTag))))
})

test('a foreign live fence blocks acquisition before CI mutates any tag', async (t) => {
  const calls = []
  const foreignTag = `rukter-deploy-drain-foreign_owner_123-until-${Math.floor(Date.now() / 1000) + 3600}`
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    calls.push({ method: req.method, url: req.url, body })
    res.setHeader('content-type', 'application/json')
    if (req.method === 'GET' && req.url === '/v1/deployment-drain') {
      res.writeHead(200)
      res.end(JSON.stringify({
        supported: true,
        active: true,
        admissionLocked: true,
        drainId: 'foreign_owner_123',
        drainIds: ['foreign_owner_123'],
      }))
      return
    }
    if (req.method === 'GET' && req.url?.startsWith('/v2/droplets?tag_name=')) {
      res.writeHead(200)
      res.end(JSON.stringify({ droplets: [{ id: 584070698, tags: ['rukter-product-story-persistent', foreignTag] }] }))
      return
    }
    res.writeHead(500)
    res.end(JSON.stringify({ error: 'mutation must not be called' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rukter-deploy-conflict-'))
  const result = await run('bash', ['scripts/deployment-drain.sh', 'acquire'], {
    AMD_GPU_ORCHESTRATOR_TOKEN: 'test-control-token',
    DIGITALOCEAN_TOKEN: 'ci-do-token',
    DEPLOYMENT_DRAIN_DIGITALOCEAN_API_URL: `http://127.0.0.1:${server.address().port}/v2`,
    RUKTER_AI_PUBLIC_URL: `http://127.0.0.1:${server.address().port}`,
    DEPLOYMENT_DRAIN_STATE_FILE: path.join(tmp, 'drain.env'),
    CI_COMMIT_SHA: 'fedcba9876543210fedcba9876543210fedcba98',
  })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /already owned by foreign_owner_123/)
  assert.ok(calls.every((call) => call.method === 'GET'))
})

test('release refuses to touch a different persistent Droplet', async (t) => {
  const calls = []
  const owner = 'rukter_ci_0123456789abcdef0123456789abcdef01234567'
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url })
    res.setHeader('content-type', 'application/json')
    if (req.method === 'GET' && req.url?.startsWith('/v2/droplets?tag_name=')) {
      res.writeHead(200)
      res.end(JSON.stringify({
        droplets: [{
          id: 999999999,
          tags: [
            'rukter-product-story-persistent',
            `rukter-deploy-drain-${owner}-until-${Math.floor(Date.now() / 1000) + 3600}`,
          ],
        }],
      }))
      return
    }
    res.writeHead(500)
    res.end(JSON.stringify({ error: 'mutation must not be called' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rukter-deploy-release-mismatch-'))
  const stateFile = path.join(tmp, 'drain.env')
  await writeFile(stateFile, `mode=active\ndrain_id=${owner}\nowned_tag=test\ndroplet_id=584070698\n`)
  const result = await run('bash', ['scripts/deployment-drain.sh', 'release'], {
    DIGITALOCEAN_TOKEN: 'ci-do-token',
    DEPLOYMENT_DRAIN_DIGITALOCEAN_API_URL: `http://127.0.0.1:${server.address().port}/v2`,
    DEPLOYMENT_DRAIN_STATE_FILE: stateFile,
    CI_COMMIT_SHA: '0123456789abcdef0123456789abcdef01234567',
  })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /changed before fence release/)
  assert.ok(calls.length > 0)
  assert.ok(calls.every((call) => call.method === 'GET'))
})

test('the idle wait rejects a second owner even when this pipeline is also present', async (t) => {
  const owner = 'rukter_ci_0123456789abcdef0123456789abcdef01234567'
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      supported: true,
      active: true,
      admissionLocked: true,
      drainId: '',
      drainIds: [owner, 'foreign_owner_123'],
      activeAdmittedRequests: 0,
      activeUserSessions: 0,
      quietForSeconds: 60,
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
      readyForDeploy: true,
      checkedAt: new Date().toISOString(),
    }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rukter-deploy-multi-owner-'))
  const stateFile = path.join(tmp, 'drain.env')
  await writeFile(stateFile, `mode=active\ndrain_id=${owner}\nowned_tag=test\ndroplet_id=584070698\n`)
  const result = await run('bash', ['scripts/wait-live-amd-queue-idle.sh'], {
    AMD_GPU_ORCHESTRATOR_TOKEN: 'test-control-token',
    RUKTER_AI_PUBLIC_URL: `http://127.0.0.1:${server.address().port}`,
    DEPLOYMENT_DRAIN_STATE_FILE: stateFile,
    DEPLOYMENT_DRAIN_WAIT_SECONDS: '5',
    DEPLOYMENT_DRAIN_POLL_SECONDS: '1',
  })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /missing or no longer owned/)
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

test('the pinned legacy rollout requires explicit approval for the exact commit before any durable mutation', async (t) => {
  const calls = []
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url })
    res.writeHead(405, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rukter-deploy-bootstrap-approval-'))
  const commit = '0123456789abcdef0123456789abcdef01234567'
  const result = await run('bash', ['scripts/deployment-drain.sh', 'acquire'], {
    AMD_GPU_ORCHESTRATOR_TOKEN: 'test-control-token',
    DIGITALOCEAN_TOKEN: 'ci-do-token',
    DEPLOYMENT_DRAIN_DIGITALOCEAN_API_URL: `http://127.0.0.1:${server.address().port}/v2`,
    RUKTER_AI_PUBLIC_URL: `http://127.0.0.1:${server.address().port}`,
    DEPLOYMENT_DRAIN_STATE_FILE: path.join(tmp, 'drain.env'),
    DEPLOYMENT_DRAIN_LEGACY_PARENT_SHA: 'pinned-old-main-sha',
    CI_COMMIT_BEFORE_SHA: 'pinned-old-main-sha',
    CI_COMMIT_SHA: commit,
  })

  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /cannot prove that no completed-result viewer is active/)
  assert.match(result.stderr, new RegExp(`DEPLOYMENT_DRAIN_BOOTSTRAP_APPROVED_SHA=${commit}`))
  assert.deepEqual(calls, [{ method: 'GET', url: '/v1/deployment-drain' }])
})

test('only the pinned first rollout can use the old app 405 idle-window bridge', async (t) => {
  const calls = []
  const dropletTags = ['rukter-product-story-persistent']
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body })
    if (req.method === 'GET' && req.url?.startsWith('/v2/droplets?tag_name=')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ droplets: [{ id: 584070698, tags: dropletTags }] }))
      return
    }
    if (req.method === 'POST' && req.url === '/v2/tags') {
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ tag: { name: JSON.parse(body).name } }))
      return
    }
    const resourceMatch = req.url?.match(/^\/v2\/tags\/([^/]+)\/resources$/)
    if (resourceMatch && req.method === 'POST') {
      const tag = decodeURIComponent(resourceMatch[1])
      if (!dropletTags.includes(tag)) dropletTags.push(tag)
      res.writeHead(204)
      res.end()
      return
    }
    if (resourceMatch && req.method === 'DELETE') {
      const tag = decodeURIComponent(resourceMatch[1])
      const index = dropletTags.indexOf(tag)
      if (index >= 0) dropletTags.splice(index, 1)
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
  const commit = '0123456789abcdef0123456789abcdef01234567'
  const result = await run('bash', ['scripts/deployment-drain.sh', 'acquire'], {
    AMD_GPU_ORCHESTRATOR_TOKEN: 'test-control-token',
    DIGITALOCEAN_TOKEN: 'ci-do-token',
    DEPLOYMENT_DRAIN_DIGITALOCEAN_API_URL: `http://127.0.0.1:${server.address().port}/v2`,
    RUKTER_AI_PUBLIC_URL: `http://127.0.0.1:${server.address().port}`,
    DEPLOYMENT_DRAIN_STATE_FILE: stateFile,
    DEPLOYMENT_DRAIN_LEGACY_PARENT_SHA: 'pinned-old-main-sha',
    DEPLOYMENT_DRAIN_BOOTSTRAP_APPROVED_SHA: commit,
    CI_COMMIT_BEFORE_SHA: 'pinned-old-main-sha',
    CI_COMMIT_SHA: commit,
  })
  assert.equal(result.code, 0, result.stderr)
  const state = await readFile(stateFile, 'utf8')
  assert.match(state, /^mode=legacy$/m)
  assert.match(state, /^owned_tag=rukter-deploy-drain-rukter_ci_[A-Za-z0-9_-]+-until-\d+$/m)
  assert.match(state, /^droplet_id=584070698$/m)
  assert.match(result.stderr, /Attached owned deployment fence/)
  assert.match(result.stderr, /one bootstrap pipeline/)

  const release = await run('bash', ['scripts/deployment-drain.sh', 'release'], {
    AMD_GPU_ORCHESTRATOR_TOKEN: 'test-control-token',
    DIGITALOCEAN_TOKEN: 'ci-do-token',
    DEPLOYMENT_DRAIN_DIGITALOCEAN_API_URL: `http://127.0.0.1:${server.address().port}/v2`,
    DEPLOYMENT_DRAIN_STATE_FILE: stateFile,
    CI_COMMIT_SHA: commit,
  })
  assert.equal(release.code, 0, release.stderr)
  assert.match(release.stdout, /Released deployment drain/)
  assert.equal(calls[0].url, '/v1/deployment-drain')
  assert.equal(calls[0].authorization, 'Bearer test-control-token')
  const doCalls = calls.filter((call) => call.url?.startsWith('/v2/'))
  assert.ok(doCalls.every((call) => call.authorization === 'Bearer ci-do-token'))
  assert.ok(doCalls.some((call) => call.method === 'POST' && call.url === '/v2/tags'))
  assert.ok(doCalls.some((call) => call.method === 'DELETE' && call.url?.endsWith('/resources')))
  assert.ok(doCalls.some((call) => call.method === 'DELETE' && !call.url?.endsWith('/resources')))
  assert.equal(dropletTags.some((tag) => tag.startsWith('rukter-deploy-drain-')), false)
})
