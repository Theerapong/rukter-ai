import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function run(args, env) {
  return await new Promise((resolve) => {
    const child = spawn('bash', ['scripts/deployment-drain.sh', ...args], {
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

function readinessPayload(owner, { activeUsers = 0, drainIds = [owner], readyForDeploy = false } = {}) {
  return {
    supported: true,
    active: true,
    state: 'active',
    drainId: drainIds.length === 1 ? drainIds[0] : '',
    drainIds,
    admissionLocked: true,
    activeAdmittedRequests: 0,
    activeUserSessions: activeUsers,
    quietForSeconds: 0,
    quietWindowSeconds: 30,
    workerActivity: { reachable: true, verifiable: true, idle: true },
    queue: {
      activeJobPresent: false,
      queuedJobs: 0,
      readyJobs: 0,
      preparingJobs: 0,
      inProgressJobs: 0,
      activeStoryJobs: 0,
      amdInProgressJobs: 0,
      fastStoryJobs: 0,
      planningJobs: 0,
      awaitingApprovalJobs: 0,
    },
    readyForDeploy,
    checkedAt: new Date().toISOString(),
  }
}

test('strict readiness accepts true no-work after a quiet reset, then rejects a visible user', async (t) => {
  const commit = '0123456789abcdef0123456789abcdef01234567'
  const owner = `rukter_ci_${commit}`
  let activeUsers = 0
  const calls = []
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(readinessPayload(owner, { activeUsers, readyForDeploy: false })))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rukter-drain-ready-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  const stateFile = path.join(tmp, 'drain.env')
  await writeFile(stateFile, `mode=active\ndrain_id=${owner}\nowned_tag=test\ndroplet_id=584070698\n`, { mode: 0o600 })
  await chmod(stateFile, 0o600)
  const env = {
    AMD_GPU_ORCHESTRATOR_TOKEN: 'readiness-control-token',
    CI_COMMIT_SHA: commit,
    DEPLOYMENT_DRAIN_STATE_FILE: stateFile,
    RUKTER_AI_PUBLIC_URL: `http://127.0.0.1:${server.address().port}`,
  }

  const idle = await run(['assert-ready'], env)
  assert.equal(idle.code, 0, idle.stderr)
  assert.match(idle.stdout, /ready=false/)

  activeUsers = 1
  const userActive = await run(['assert-ready'], env)
  assert.notEqual(userActive.code, 0)
  assert.match(userActive.stderr, /readiness changed/)
  assert.match(userActive.stderr, /"activeUserSessions": 1/)
  assert.deepEqual(calls, [
    { method: 'GET', url: '/v1/deployment-drain', authorization: 'Bearer readiness-control-token' },
    { method: 'GET', url: '/v1/deployment-drain', authorization: 'Bearer readiness-control-token' },
  ])
})

test('strict readiness rejects ambiguous ownership even if the server claims ready', async (t) => {
  const commit = '0123456789abcdef0123456789abcdef01234567'
  const owner = `rukter_ci_${commit}`
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(readinessPayload(owner, {
      drainIds: [owner, 'foreign_owner_123'],
      readyForDeploy: true,
    })))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rukter-drain-owner-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  const stateFile = path.join(tmp, 'drain.env')
  await writeFile(stateFile, `mode=active\ndrain_id=${owner}\nowned_tag=test\ndroplet_id=584070698\n`, { mode: 0o600 })
  const result = await run(['assert-ready'], {
    AMD_GPU_ORCHESTRATOR_TOKEN: 'readiness-control-token',
    CI_COMMIT_SHA: commit,
    DEPLOYMENT_DRAIN_STATE_FILE: stateFile,
    RUKTER_AI_PUBLIC_URL: `http://127.0.0.1:${server.address().port}`,
  })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /readiness changed/)
})

test('manual legacy drain preserves the gated continuous-idle path without calling the missing endpoint', async (t) => {
  const commit = '0123456789abcdef0123456789abcdef01234567'
  const owner = `rukter_ci_${commit}`
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rukter-drain-legacy-ready-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  const stateFile = path.join(tmp, 'drain.env')
  await writeFile(stateFile, `mode=legacy\ndrain_id=${owner}\nowned_tag=test\ndroplet_id=584070698\n`, { mode: 0o600 })

  const result = await run(['assert-ready'], {
    CI_COMMIT_SHA: commit,
    DEPLOYMENT_DRAIN_STATE_FILE: stateFile,
    RUKTER_AI_PUBLIC_URL: 'http://127.0.0.1:1',
  })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /Legacy drain mode/)
})
