import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
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

function idleQueuePayload() {
  return {
    activeJobPresent: false,
    queuedJobs: 0,
    readyJobs: 0,
    preparingJobs: 0,
    inProgressJobs: 0,
    planningJobs: 0,
    awaitingApprovalJobs: 0,
    checkedAt: new Date().toISOString(),
  }
}

async function createFixture(t, {
  droplets = [{
    id: 584070698,
    status: 'active',
    tags: ['rukter-product-story-persistent'],
    networks: { v4: [{ type: 'public', ip_address: '127.0.0.1' }] },
  }],
  sshMode = 'idle',
  stableSeconds = '1',
  waitSeconds = '5',
} = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rukter-legacy-worker-proof-'))
  const binDir = path.join(tmp, 'bin')
  const stateFile = path.join(tmp, 'deployment-drain.env')
  const edgeStateFile = path.join(tmp, 'deployment-edge-gate.json')
  const sshKey = path.join(tmp, 'worker-key')
  const sshCountFile = path.join(tmp, 'ssh-count')
  const sshProbeLog = path.join(tmp, 'ssh-probe.log')
  await mkdir(binDir)
  await writeFile(stateFile, 'mode=legacy\ndrain_id=rukter_ci_0123456789abcdef0123456789abcdef01234567\nowned_tag=test\ndroplet_id=584070698\n')
  await writeFile(edgeStateFile, JSON.stringify({
    header_key: 'X-Rukter-Deploy-Gate-Test',
    header_value: 'a'.repeat(64),
  }))
  await writeFile(sshKey, 'test-only-key\n')
  await chmod(sshKey, 0o600)

  const sshMock = path.join(binDir, 'ssh')
  await writeFile(sshMock, `#!/usr/bin/env bash
set -euo pipefail
probe="$(cat)"
printf '%s\n__PROBE_END__\n' "\${probe}" >> "\${LEGACY_WORKER_PROBE_LOG}"
count=0
if [[ -r "\${LEGACY_WORKER_SSH_COUNT_FILE}" ]]; then
  count="$(sed -n '1p' "\${LEGACY_WORKER_SSH_COUNT_FILE}")"
fi
printf '%s\n' "$((count + 1))" > "\${LEGACY_WORKER_SSH_COUNT_FILE}"
case "\${LEGACY_WORKER_SSH_MODE:-idle}" in
  idle)
    printf '%s\n' '{"status":"ok","available":true,"acceptingJobs":true}'
    ;;
  busy)
    echo 'The persistent AMD worker still has a Product Story pipeline process.' >&2
    exit 3
    ;;
  malformed)
    printf '%s\n' 'not-json'
    ;;
  *)
    echo 'mock SSH transport failure' >&2
    exit 255
    ;;
esac
`)
  await chmod(sshMock, 0o755)

  const calls = []
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, headers: req.headers })
    res.setHeader('content-type', 'application/json')
    if (req.method === 'GET' && req.url?.startsWith('/v2/droplets?tag_name=')) {
      res.writeHead(200)
      res.end(JSON.stringify({ droplets }))
      return
    }
    if (req.method === 'GET' && req.url === '/api/story-queue') {
      res.writeHead(200)
      res.end(JSON.stringify(idleQueuePayload()))
      return
    }
    res.writeHead(404)
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  return {
    calls,
    sshCountFile,
    sshProbeLog,
    env: {
      PATH: `${binDir}:${process.env.PATH}`,
      AMD_GPU_DIGITALOCEAN_TOKEN: 'read-only-amd-do-token',
      DIGITALOCEAN_TOKEN: 'general-do-token',
      DEPLOYMENT_DRAIN_DIGITALOCEAN_API_URL: `http://127.0.0.1:${server.address().port}/v2`,
      RUKTER_AI_PUBLIC_URL: `http://127.0.0.1:${server.address().port}`,
      DEPLOYMENT_DRAIN_STATE_FILE: stateFile,
      DEPLOYMENT_EDGE_GATE_STATE_FILE: edgeStateFile,
      DEPLOYMENT_EDGE_GATE_REQUIRED: 'true',
      DEPLOYMENT_DRAIN_LEGACY_STABLE_SECONDS: stableSeconds,
      DEPLOYMENT_DRAIN_POLL_SECONDS: '1',
      DEPLOYMENT_DRAIN_WAIT_SECONDS: waitSeconds,
      AMD_GPU_SSH_PRIVATE_KEY_PATH: sshKey,
      LEGACY_WORKER_SSH_MODE: sshMode,
      LEGACY_WORKER_SSH_COUNT_FILE: sshCountFile,
      LEGACY_WORKER_PROBE_LOG: sshProbeLog,
    },
  }
}

test('gated legacy idle proof repeats read-only SSH process and localhost health checks through the stable window', async (t) => {
  const fixture = await createFixture(t)
  const result = await run('bash', ['scripts/wait-live-amd-queue-idle.sh'], fixture.env)

  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /Legacy worker proof: droplet=584070698 accepting=true pipeline_process=false/)
  assert.match(result.stdout, /deploy may continue/)
  assert.ok(Number(await readFile(fixture.sshCountFile, 'utf8')) >= 2)
  const probe = await readFile(fixture.sshProbeLog, 'utf8')
  assert.match(probe, /docker top rukter-amd-worker -eo pid,args/)
  assert.match(probe, /\[r\]un_story_pipeline\\\.\(sh\|py\)/)
  assert.match(probe, /http:\/\/127\.0\.0\.1:8080\/health/)
  assert.doesNotMatch(probe, /systemctl|docker (?:restart|stop|rm)|shutdown|poweroff|reboot|release/)

  const dropletCalls = fixture.calls.filter((call) => call.url?.startsWith('/v2/droplets?tag_name='))
  const queueCalls = fixture.calls.filter((call) => call.url === '/api/story-queue')
  assert.ok(dropletCalls.length >= 2)
  assert.ok(dropletCalls.every((call) => call.method === 'GET' && call.headers.authorization === 'Bearer read-only-amd-do-token'))
  assert.ok(queueCalls.length >= 2)
  assert.ok(queueCalls.every((call) => call.headers['x-rukter-deploy-gate-test'] === 'a'.repeat(64)))
  assert.ok(fixture.calls.every((call) => call.method === 'GET'))
})

test('gated legacy wait fails closed when the worker cannot be verified over SSH', async (t) => {
  const fixture = await createFixture(t, { sshMode: 'unverifiable', stableSeconds: '0' })
  const result = await run('bash', ['scripts/wait-live-amd-queue-idle.sh'], fixture.env)

  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /could not be verified read-only over SSH/)
  assert.match(result.stderr, /could not be proven; refusing to deploy/)
  assert.equal(Number(await readFile(fixture.sshCountFile, 'utf8')), 1)
})

test('gated legacy wait never accepts a worker with a Product Story pipeline process', async (t) => {
  const fixture = await createFixture(t, { sshMode: 'busy', stableSeconds: '0', waitSeconds: '1' })
  const result = await run('bash', ['scripts/wait-live-amd-queue-idle.sh'], fixture.env)

  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /still has a Product Story pipeline process/)
  assert.match(result.stderr, /Timed out waiting/)
  assert.ok(Number(await readFile(fixture.sshCountFile, 'utf8')) >= 2)
})

test('gated legacy wait fails before SSH unless exactly one persistent Droplet is visible', async (t) => {
  const fixture = await createFixture(t, {
    droplets: [
      {
        id: 584070698,
        status: 'active',
        tags: ['rukter-product-story-persistent'],
        networks: { v4: [{ type: 'public', ip_address: '127.0.0.1' }] },
      },
      {
        id: 584070699,
        status: 'active',
        tags: ['rukter-product-story-persistent'],
        networks: { v4: [{ type: 'public', ip_address: '127.0.0.2' }] },
      },
    ],
    stableSeconds: '0',
  })
  const result = await run('bash', ['scripts/wait-live-amd-queue-idle.sh'], fixture.env)

  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /Expected exactly one persistent AMD Droplet while verifying the legacy drain; found 2/)
  await assert.rejects(readFile(fixture.sshCountFile, 'utf8'), { code: 'ENOENT' })
})
