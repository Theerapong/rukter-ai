import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const watchdogSource = path.join(repoDir, 'scripts/run-terraform-apply-with-watchdog.sh')

async function run(command, args, env, timeoutMs = 20_000) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: repoDir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr, timedOut })
    })
  })
}

function controlScript(name) {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `operation="${name}:\${1:-}"`,
    'printf \'%s\\n\' "${operation}" >> "${WATCHDOG_LOG}"',
    'count="$(awk -v operation="${operation}" \'$0 == operation { count += 1 } END { print count + 0 }\' "${WATCHDOG_LOG}")"',
    'if [[ "${WATCHDOG_FAIL_OPERATION:-}" == "${operation}" && "${count}" -ge "${WATCHDOG_FAIL_AFTER:-1}" ]]; then',
    '  if [[ "${WATCHDOG_FAIL_REQUIRE_APPLY_STARTED:-false}" != "true" ]] || grep -q \'^apply:started:\' "${WATCHDOG_LOG}"; then',
    '    printf \'control-failure:%s\\n\' "${operation}" >> "${WATCHDOG_LOG}"',
    '    exit 42',
    '  fi',
    'fi',
    'if [[ "${operation}" == "drain:assert-ready" && -n "${REAL_DEPLOYMENT_DRAIN_SCRIPT:-}" ]]; then',
    '  exec bash "${REAL_DEPLOYMENT_DRAIN_SCRIPT}" assert-ready',
    'fi',
    '',
  ].join('\n')
}

async function fixture(t, { mode = 'active' } = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rukter-apply-watchdog-'))
  const wrapper = path.join(tmp, 'run-terraform-apply-with-watchdog.sh')
  const logFile = path.join(tmp, 'watchdog.log')
  const drainState = path.join(tmp, 'deployment-drain.env')
  const edgeState = path.join(tmp, 'deployment-edge-gate.json')
  const phaseFile = path.join(tmp, 'deployment-phase')
  await copyFile(watchdogSource, wrapper)
  await writeFile(path.join(tmp, 'assert-production-targets.sh'), '#!/usr/bin/env bash\nexit 0\n')
  await writeFile(path.join(tmp, 'deployment-drain.sh'), controlScript('drain'))
  await writeFile(path.join(tmp, 'deployment-edge-gate.sh'), controlScript('edge'))
  await writeFile(path.join(tmp, 'caffeinate'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'printf \'caffeinate:%s\\n\' "$*" >> "${WATCHDOG_LOG}"',
    '[[ "${1:-}" == "-dims" ]] || exit 64',
    'shift',
    'exec "$@"',
    '',
  ].join('\n'))
  await writeFile(path.join(tmp, 'fake-apply.sh'), [
    '#!/usr/bin/env bash',
    'set -u',
    'mode="${1:-complete}"',
    'duration="${2:-2}"',
    'printf \'apply:started:%s\\n\' "$$" >> "${WATCHDOG_LOG}"',
    'if [[ -n "${RUKTER_AI_CLOUDFLARE_API_TOKEN+x}" ]]; then',
    '  printf \'apply:cloudflare-token:inherited\\n\' >> "${WATCHDOG_LOG}"',
    'else',
    '  printf \'apply:cloudflare-token:absent\\n\' >> "${WATCHDOG_LOG}"',
    'fi',
    'if [[ "${mode}" == "ignore-term" ]]; then',
    '  trap \'printf "apply:term:%s\\n" "$$" >> "${WATCHDOG_LOG}"\' TERM',
    '  while true; do sleep 1; done',
    'fi',
    'trap \'printf "apply:term:%s\\n" "$$" >> "${WATCHDOG_LOG}"; exit 143\' TERM',
    'sleep "${duration}"',
    'printf \'apply:finished:%s\\n\' "$$" >> "${WATCHDOG_LOG}"',
    '',
  ].join('\n'))
  await writeFile(drainState, `mode=${mode}\ndrain_id=rukter_ci_test_owner\nowned_tag=test\ndroplet_id=1\n`, { mode: 0o600 })
  await writeFile(edgeState, JSON.stringify({
    header_key: 'X-Rukter-Deploy-Gate-test',
    header_value: 'a'.repeat(64),
  }), { mode: 0o600 })
  const phaseInit = await run('bash', ['-c', 'umask 022; umask 077; printf "pre_apply\\n" > "${PHASE_FILE}"; chmod 600 "${PHASE_FILE}"'], {
    PHASE_FILE: phaseFile,
  })
  assert.equal(phaseInit.code, 0, phaseInit.stderr)
  assert.equal((await stat(phaseFile)).mode & 0o777, 0o600)
  await writeFile(logFile, '')
  await Promise.all([
    chmod(wrapper, 0o755),
    chmod(path.join(tmp, 'assert-production-targets.sh'), 0o755),
    chmod(path.join(tmp, 'deployment-drain.sh'), 0o755),
    chmod(path.join(tmp, 'deployment-edge-gate.sh'), 0o755),
    chmod(path.join(tmp, 'caffeinate'), 0o755),
    chmod(path.join(tmp, 'fake-apply.sh'), 0o755),
    chmod(drainState, 0o600),
    chmod(edgeState, 0o600),
  ])

  const env = {
    PATH: `${tmp}:${process.env.PATH}`,
    WATCHDOG_LOG: logFile,
    DEPLOYMENT_DRAIN_STATE_FILE: drainState,
    DEPLOYMENT_EDGE_GATE_STATE_FILE: edgeState,
    DEPLOYMENT_PHASE_FILE: phaseFile,
    DEPLOYMENT_DRAIN_ID: 'rukter_ci_test_owner',
    DEPLOYMENT_APPLY_DEADLINE_SECONDS: '8',
    DEPLOYMENT_APPLY_RENEW_INTERVAL_SECONDS: '1',
    DEPLOYMENT_APPLY_READINESS_INTERVAL_SECONDS: '1',
    DEPLOYMENT_APPLY_POLL_SECONDS: '1',
    DEPLOYMENT_APPLY_TERMINATION_GRACE_SECONDS: '1',
    RUKTER_AI_CLOUDFLARE_API_TOKEN: 'must-not-reach-terraform',
  }
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true })
  })
  return { tmp, wrapper, logFile, phaseFile, env }
}

function activeReadinessPayload(activeUserSessions) {
  return {
    supported: true,
    active: true,
    state: 'active',
    drainId: 'rukter_ci_test_owner',
    drainIds: ['rukter_ci_test_owner'],
    admissionLocked: true,
    activeAdmittedRequests: 0,
    activeUserSessions,
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
    readyForDeploy: false,
    checkedAt: new Date().toISOString(),
  }
}

function occurrences(log, line) {
  return log.split('\n').filter((entry) => entry === line).length
}

function assertProcessGone(pid) {
  assert.throws(() => process.kill(pid, 0), (error) => error?.code === 'ESRCH')
}

test('active apply renews and verifies both fences periodically under caffeinate', async (t) => {
  const { tmp, wrapper, logFile, phaseFile, env } = await fixture(t, { mode: 'active' })
  const result = await run('bash', [wrapper, path.join(tmp, 'fake-apply.sh'), 'complete', '4'], env)
  assert.equal(result.timedOut, false)
  assert.equal(result.code, 0, result.stderr)

  const log = await readFile(logFile, 'utf8')
  assert.match(log, /^caffeinate:-dims /m)
  assert.ok(occurrences(log, 'drain:renew') >= 3, log)
  assert.equal(occurrences(log, 'drain:renew'), occurrences(log, 'drain:status'))
  assert.ok(occurrences(log, 'drain:assert-ready') >= 3, log)
  assert.equal(occurrences(log, 'edge:renew'), occurrences(log, 'edge:status'))
  assert.ok(occurrences(log, 'edge:renew') >= 3, log)
  assert.equal(occurrences(log, 'apply:cloudflare-token:absent'), 1, log)
  assert.equal(occurrences(log, 'apply:cloudflare-token:inherited'), 0, log)
  assert.match(log, /apply:finished:/)
  assert.equal(await readFile(phaseFile, 'utf8'), 'apply_started\n')
  assert.equal((await stat(phaseFile)).mode & 0o777, 0o600)
})

test('legacy apply renews durable ownership without calling the unavailable old-app status endpoint', async (t) => {
  const { tmp, wrapper, logFile, env } = await fixture(t, { mode: 'legacy' })
  const result = await run('bash', [wrapper, path.join(tmp, 'fake-apply.sh'), 'complete', '3'], env)
  assert.equal(result.code, 0, result.stderr)

  const log = await readFile(logFile, 'utf8')
  assert.ok(occurrences(log, 'drain:renew') >= 2, log)
  assert.equal(occurrences(log, 'drain:status'), 0, log)
  assert.equal(occurrences(log, 'drain:assert-ready'), 0, log)
  assert.equal(occurrences(log, 'edge:renew'), occurrences(log, 'edge:status'))
  assert.match(result.stdout, /Legacy drain mode/)
})

test('fence verification failure terminates only the owned apply process group', async (t) => {
  const { tmp, wrapper, logFile, env } = await fixture(t, { mode: 'active' })
  const sentinel = spawn('sleep', ['30'], { stdio: 'ignore' })
  t.after(() => sentinel.kill('SIGKILL'))

  const result = await run('bash', [wrapper, path.join(tmp, 'fake-apply.sh'), 'complete', '30'], {
    ...env,
    DEPLOYMENT_APPLY_RENEW_INTERVAL_SECONDS: '2',
    WATCHDOG_FAIL_OPERATION: 'edge:status',
    WATCHDOG_FAIL_AFTER: '2',
    WATCHDOG_FAIL_REQUIRE_APPLY_STARTED: 'true',
  })
  assert.equal(result.timedOut, false)
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /renewal or status verification failed/)

  const log = await readFile(logFile, 'utf8')
  assert.match(log, /control-failure:edge:status/)
  assert.match(log, /apply:term:/)
  assert.doesNotThrow(() => process.kill(sentinel.pid, 0))
  const applyPid = Number(log.match(/apply:started:(\d+)/)?.[1])
  assert.ok(Number.isInteger(applyPid))
  assertProcessGone(applyPid)
})

test('a user becoming active after the gated idle window prevents apply from starting', async (t) => {
  const { tmp, wrapper, logFile, phaseFile, env } = await fixture(t, { mode: 'active' })
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(activeReadinessPayload(1)))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const result = await run('bash', [wrapper, path.join(tmp, 'fake-apply.sh'), 'complete', '3'], {
    ...env,
    REAL_DEPLOYMENT_DRAIN_SCRIPT: path.join(repoDir, 'scripts/deployment-drain.sh'),
    AMD_GPU_ORCHESTRATOR_TOKEN: 'readiness-control-token',
    RUKTER_AI_PUBLIC_URL: `http://127.0.0.1:${server.address().port}`,
  })
  assert.equal(result.timedOut, false)
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /readiness changed after the gated idle window/)

  const log = await readFile(logFile, 'utf8')
  assert.equal(occurrences(log, 'drain:assert-ready'), 1, log)
  assert.doesNotMatch(log, /apply:started:/)
  assert.equal(await readFile(phaseFile, 'utf8'), 'pre_apply\n')
  assert.equal((await stat(phaseFile)).mode & 0o777, 0o600)
})

test('a user becoming active during apply terminates the owned group before the five-minute renewal cycle', async (t) => {
  const { tmp, wrapper, logFile, env } = await fixture(t, { mode: 'active' })
  let readinessRequests = 0
  const server = http.createServer((_req, res) => {
    readinessRequests += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(activeReadinessPayload(readinessRequests >= 2 ? 1 : 0)))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const result = await run('bash', [wrapper, path.join(tmp, 'fake-apply.sh'), 'complete', '30'], {
    ...env,
    DEPLOYMENT_APPLY_RENEW_INTERVAL_SECONDS: '5',
    DEPLOYMENT_APPLY_READINESS_INTERVAL_SECONDS: '2',
    REAL_DEPLOYMENT_DRAIN_SCRIPT: path.join(repoDir, 'scripts/deployment-drain.sh'),
    AMD_GPU_ORCHESTRATOR_TOKEN: 'readiness-control-token',
    RUKTER_AI_PUBLIC_URL: `http://127.0.0.1:${server.address().port}`,
  })
  assert.equal(result.timedOut, false)
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /readiness assertion failed while Terraform apply was running/)

  const log = await readFile(logFile, 'utf8')
  assert.equal(occurrences(log, 'drain:renew'), 1, log)
  assert.equal(occurrences(log, 'edge:renew'), 1, log)
  assert.equal(occurrences(log, 'drain:assert-ready'), 2, log)
  assert.match(log, /apply:term:/)
  assert.doesNotMatch(log, /apply:finished:/)
  const applyPid = Number(log.match(/apply:started:(\d+)/)?.[1])
  assert.ok(Number.isInteger(applyPid))
  assertProcessGone(applyPid)
})

test('immutable local deadline kills a TERM-resistant apply before it can outlive the bound', async (t) => {
  const { tmp, wrapper, logFile, env } = await fixture(t, { mode: 'active' })
  const started = Date.now()
  const result = await run('bash', [wrapper, path.join(tmp, 'fake-apply.sh'), 'ignore-term'], {
    ...env,
    DEPLOYMENT_APPLY_DEADLINE_SECONDS: '2',
  })
  const elapsedMs = Date.now() - started
  assert.equal(result.timedOut, false)
  assert.equal(result.code, 124, result.stderr)
  assert.ok(elapsedMs < 7_000, `watchdog took ${elapsedMs}ms`)
  assert.match(result.stderr, /bounded local deadline/)

  const log = await readFile(logFile, 'utf8')
  assert.doesNotMatch(log, /apply:finished:/)
  const applyPid = Number(log.match(/apply:started:(\d+)/)?.[1])
  assert.ok(Number.isInteger(applyPid))
  assertProcessGone(applyPid)
})

test('deadline overrides cannot exceed the production safety ceiling', async (t) => {
  const { tmp, wrapper, logFile, env } = await fixture(t)
  const result = await run('bash', [wrapper, path.join(tmp, 'fake-apply.sh'), 'complete', '1'], {
    ...env,
    DEPLOYMENT_APPLY_DEADLINE_SECONDS: '12601',
  })
  assert.equal(result.code, 2)
  assert.match(result.stderr, /immutable 12600-second safety ceiling/)
  assert.equal(await readFile(logFile, 'utf8'), '')
})

test('phase transition refuses a symlink and leaves its target at pre_apply', async (t) => {
  const { tmp, wrapper, logFile, phaseFile, env } = await fixture(t)
  const phaseTarget = path.join(tmp, 'phase-target')
  await writeFile(phaseTarget, 'pre_apply\n', { mode: 0o600 })
  await rm(phaseFile)
  await symlink(phaseTarget, phaseFile)

  const result = await run('bash', [wrapper, path.join(tmp, 'fake-apply.sh'), 'complete', '1'], env)
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /regular non-symlink file/)
  assert.equal(await readFile(phaseTarget, 'utf8'), 'pre_apply\n')
  assert.equal(await readFile(logFile, 'utf8'), '')
})

test('CI routes Terraform apply through the bounded watchdog', async () => {
  const ci = await readFile(path.join(repoDir, '.gitlab-ci.yml'), 'utf8')
  const source = await readFile(watchdogSource, 'utf8')
  const applyJob = ci.slice(ci.indexOf('terraform:apply:digitalocean:'), ci.indexOf('verify:rukter-ai:digitalocean:'))
  const deadline = Number(ci.match(/DEPLOYMENT_APPLY_DEADLINE_SECONDS: "(\d+)"/)?.[1])
  const drainTtl = Number(ci.match(/DEPLOYMENT_DRAIN_TTL_SECONDS: "(\d+)"/)?.[1])
  const edgeTtl = Number(ci.match(/DEPLOYMENT_EDGE_GATE_TTL_SECONDS: "(\d+)"/)?.[1])
  const readinessInterval = Number(ci.match(/DEPLOYMENT_APPLY_READINESS_INTERVAL_SECONDS: "(\d+)"/)?.[1])

  assert.equal(deadline, 12_600)
  assert.ok(deadline < 4 * 3600)
  assert.ok(deadline + 7200 <= drainTtl)
  assert.ok(deadline + 7200 <= edgeTtl)
  assert.equal(readinessInterval, 15)
  assert.match(applyJob, /run-terraform-apply-with-watchdog\.sh terraform -chdir="\$\{TF_DO_ENV_DIR\}" apply/)
  const plan = applyJob.indexOf('plan -parallelism=20')
  const postPlanIdle = applyJob.indexOf('DEPLOYMENT_DRAIN_BOOTSTRAP_COMPATIBILITY=true DEPLOYMENT_EDGE_GATE_REQUIRED=true bash scripts/wait-live-amd-queue-idle.sh', plan)
  const apply = applyJob.indexOf('run-terraform-apply-with-watchdog.sh', postPlanIdle)
  assert.ok(plan < postPlanIdle && postPlanIdle < apply)
  assert.match(source, /caffeinate -dims/)
  assert.match(source, /caffeinate -dims env -u RUKTER_AI_CLOUDFLARE_API_TOKEN/)
  assert.match(source, /--mode=block[\s\\\n]+env -u RUKTER_AI_CLOUDFLARE_API_TOKEN/)
  assert.match(source, /deployment-drain\.sh" renew/)
  assert.match(source, /deployment-drain\.sh" assert-ready/)
  assert.match(source, /next_readiness_at/)
  assert.match(source, /validate_pre_apply_phase[\s\S]*mark_apply_started/)
  assert.match(source, /mark_apply_started \|\| exit 1[\s\S]*set -m[\s\S]*__run_owned_apply/)
  assert.doesNotMatch(applyJob, /printf 'apply_started/)
  assert.match(applyJob, /umask 077; printf 'pre_apply\\n' > \.ci-artifacts\/deployment-phase; chmod 600 \.ci-artifacts\/deployment-phase/)
  assert.match(source, /drain_mode\}" == "active"[\s\S]*deployment-drain\.sh" status/)
  assert.match(source, /DEPLOYMENT_EDGE_GATE_PRODUCTION=true bash "\$\{script_dir\}\/deployment-edge-gate\.sh" renew[\s\S]*DEPLOYMENT_EDGE_GATE_PRODUCTION=true bash "\$\{script_dir\}\/deployment-edge-gate\.sh" status/)
  assert.match(source, /kill -TERM -- "-\$\{apply_pgid\}"/)
  assert.match(source, /kill -KILL -- "-\$\{apply_pgid\}"/)
  assert.doesNotMatch(source, /\b(?:pkill|killall)\b/)
})
