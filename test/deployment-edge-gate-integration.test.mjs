import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
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

test('production deploy holds the edge gate through AMD bootstrap and final verification before ordered release', async () => {
  const ci = await readFile(path.join(repoDir, '.gitlab-ci.yml'), 'utf8')
  const watchdogSource = await readFile(path.join(repoDir, 'scripts/run-terraform-apply-with-watchdog.sh'), 'utf8')
  const workflow = ci.slice(ci.indexOf('workflow:'), ci.indexOf('default:'))
  const applyJob = ci.slice(ci.indexOf('terraform:apply:digitalocean:'), ci.indexOf('verify:rukter-ai:digitalocean:'))
  const cloudflarePreflight = applyJob.indexOf('test -n "${RUKTER_AI_CLOUDFLARE_API_TOKEN:-}"')
  const protectedRef = applyJob.indexOf('CI_COMMIT_REF_PROTECTED')
  const officialApi = applyJob.indexOf('test "${DEPLOYMENT_EDGE_GATE_API_URL')
  const exactZone = applyJob.indexOf('test "${DEPLOYMENT_EDGE_GATE_ZONE_NAME')
  const exactPublicUrl = applyJob.indexOf('test "${DEPLOYMENT_EDGE_GATE_PUBLIC_URL')
  const drainAcquire = applyJob.indexOf('deployment-drain.sh acquire')
  const initialIdle = applyJob.indexOf('wait-live-amd-queue-idle.sh', drainAcquire)
  const edgeAcquire = applyJob.indexOf('deployment-edge-gate.sh acquire')
  const gatedIdle = applyJob.indexOf('DEPLOYMENT_EDGE_GATE_REQUIRED=true bash scripts/wait-live-amd-queue-idle.sh', edgeAcquire)
  const plan = applyJob.indexOf('plan -parallelism=20')
  const mainGuard = applyJob.indexOf('assert-current-main-sha.sh', plan)
  const drainRenew = applyJob.indexOf('deployment-drain.sh renew', mainGuard)
  const edgeRenew = applyJob.indexOf('deployment-edge-gate.sh renew', drainRenew)
  const watchdog = applyJob.indexOf('run-terraform-apply-with-watchdog.sh')
  const apply = applyJob.indexOf('apply -parallelism=20')
  const postApplyStatus = applyJob.indexOf('DEPLOYMENT_EDGE_GATE_PRODUCTION=true bash scripts/deployment-edge-gate.sh status', apply)
  const verify = applyJob.indexOf('DEPLOYMENT_EDGE_GATE_REQUIRED=true bash scripts/verify-live-deployment.sh')
  const appFenceAcquire = applyJob.indexOf('DEPLOYMENT_DRAIN_REQUIRE_SUPPORTED=true', verify)
  const postApplyIdle = applyJob.indexOf('DEPLOYMENT_EDGE_GATE_REQUIRED=true bash scripts/wait-live-amd-queue-idle.sh', appFenceAcquire)
  const appFence = applyJob.indexOf("printf 'app_fenced")
  const amdBootstrap = applyJob.indexOf('bootstrap-persistent-amd.sh')
  const postBootstrapStatus = applyJob.indexOf('DEPLOYMENT_EDGE_GATE_PRODUCTION=true bash scripts/deployment-edge-gate.sh status', amdBootstrap)
  const finalIdle = applyJob.indexOf('DEPLOYMENT_EDGE_GATE_REQUIRED=true bash scripts/wait-live-amd-queue-idle.sh', amdBootstrap)
  const finalDrainStatus = applyJob.indexOf('DEPLOYMENT_EDGE_GATE_REQUIRED=true bash scripts/deployment-drain.sh status', finalIdle)
  const finalVerify = applyJob.indexOf('DEPLOYMENT_EDGE_GATE_REQUIRED=true bash scripts/verify-live-deployment.sh', amdBootstrap)
  const finalEdgeStatus = applyJob.indexOf('DEPLOYMENT_EDGE_GATE_PRODUCTION=true bash scripts/deployment-edge-gate.sh status', finalVerify)
  const verificationComplete = applyJob.indexOf("printf 'verification_complete")
  const edgeRelease = applyJob.indexOf('deployment-edge-gate.sh release', verificationComplete)
  const edgeReleased = applyJob.indexOf("printf 'edge_released", edgeRelease)
  const durableRelease = applyJob.indexOf('deployment-drain.sh release', edgeReleased)

  assert.match(workflow, /CI_PIPELINE_SOURCE == "merge_request_event"/)
  assert.match(workflow, /\$CI_COMMIT_BRANCH/)
  assert.match(workflow, /CI_PIPELINE_SOURCE == "web"/)
  assert.match(applyJob, /tags:\s*\n\s*- rukter-ai-production/)
  assert.match(applyJob, /rules:\s*\n\s*- if: '\$CI_COMMIT_BRANCH == "main" && \$CI_COMMIT_REF_PROTECTED == "true"'/)
  assert.doesNotMatch(applyJob, /merge_request_event/)
  assert.ok(protectedRef >= 0)
  assert.ok(cloudflarePreflight >= 0)
  assert.ok(protectedRef < cloudflarePreflight)
  assert.ok(cloudflarePreflight < drainAcquire)
  assert.ok(officialApi >= 0 && officialApi < drainAcquire)
  assert.ok(exactZone >= 0 && exactZone < drainAcquire)
  assert.ok(exactPublicUrl >= 0 && exactPublicUrl < drainAcquire)
  assert.match(applyJob, /must be configured as both protected and masked/)
  assert.ok((applyJob.match(/DEPLOYMENT_EDGE_GATE_PRODUCTION=true bash scripts\/deployment-edge-gate\.sh/g) ?? []).length >= 8)
  assert.ok(drainAcquire < initialIdle)
  assert.ok(initialIdle < edgeAcquire)
  assert.ok(edgeAcquire < gatedIdle)
  assert.ok(gatedIdle < plan)
  assert.ok(plan < mainGuard)
  assert.ok(mainGuard < drainRenew)
  assert.ok(drainRenew < edgeRenew)
  assert.ok(edgeRenew < watchdog)
  assert.ok(watchdog <= apply)
  assert.doesNotMatch(applyJob, /printf 'apply_started/)
  assert.match(watchdogSource, /mark_apply_started \|\| exit 1[\s\S]*set -m[\s\S]*__run_owned_apply/)
  assert.ok(apply < postApplyStatus)
  assert.ok(postApplyStatus < verify)
  assert.ok(verify < appFenceAcquire)
  assert.ok(appFenceAcquire < postApplyIdle)
  assert.ok(postApplyIdle < appFence)
  assert.ok(appFence < amdBootstrap)
  assert.ok(amdBootstrap < postBootstrapStatus)
  assert.ok(postBootstrapStatus < finalIdle)
  assert.ok(finalIdle < finalDrainStatus)
  assert.ok(finalDrainStatus < finalVerify)
  assert.ok(finalVerify < finalEdgeStatus)
  assert.ok(finalEdgeStatus < verificationComplete)
  assert.ok(verificationComplete < edgeRelease)
  assert.ok(edgeRelease < edgeReleased)
  assert.ok(edgeReleased < durableRelease)
  assert.doesNotMatch(applyJob, /TF_VAR_deployment_edge_gate|secure_header/)
  assert.match(applyJob, /apply_started[\s\S]*Cloudflare automatically reopens ingress when its TTL expires/)
  assert.match(applyJob, /app_fenced[\s\S]*keeping both fail-closed TTL fences in place/)
  assert.match(applyJob, /Recovery release is safe[\s\S]*deployment-edge-gate\.sh release \|\| edge_release_status=/)
  const appFencedRecovery = applyJob.slice(applyJob.indexOf('elif [[ "${phase}" == "app_fenced"'), applyJob.indexOf('elif [[ "${phase}" == "verification_complete"'))
  const verifiedRecovery = applyJob.slice(applyJob.indexOf('elif [[ "${phase}" == "verification_complete"'), applyJob.indexOf('elif [[ "${phase}" == "edge_released"'))
  const edgeReleasedRecovery = applyJob.slice(applyJob.indexOf('elif [[ "${phase}" == "edge_released"'))
  assert.doesNotMatch(appFencedRecovery, /deployment-edge-gate\.sh release|deployment-drain\.sh release/)
  assert.match(verifiedRecovery, /deployment-edge-gate\.sh release[\s\S]*if \[\[ "\$\{edge_release_status\}" == "0" \]\][\s\S]*deployment-drain\.sh release/)
  assert.match(edgeReleasedRecovery, /deployment-drain\.sh release/)
  assert.doesNotMatch(verifiedRecovery, /if \[\[ -r .*deployment-edge-gate/)
  assert.doesNotMatch(applyJob, /\/release-gpu|shutdown -h|poweroff/i)

  const artifactPaths = applyJob.slice(applyJob.lastIndexOf('artifacts:'))
  assert.doesNotMatch(artifactPaths, /deployment-edge-gate/)
})

test('non-main and unprotected refs cannot create the production apply job', async () => {
  const ci = await readFile(path.join(repoDir, '.gitlab-ci.yml'), 'utf8')
  const applyJob = ci.slice(ci.indexOf('terraform:apply:digitalocean:'), ci.indexOf('verify:rukter-ai:digitalocean:'))
  const rulesBlock = applyJob.slice(applyJob.indexOf('  rules:'), applyJob.indexOf('  script:'))
  assert.equal((rulesBlock.match(/- if:/g) ?? []).length, 1)
  assert.match(rulesBlock, /\$CI_COMMIT_BRANCH == "main" && \$CI_COMMIT_REF_PROTECTED == "true"/)
  assert.doesNotMatch(rulesBlock, /merge_request_event|when: always/)
  assert.match(applyJob, /tags:\s*\n\s*- rukter-ai-production/)
})

test('durable and Cloudflare TTLs have at least one hour of margin beyond the deploy timeout', async () => {
  const ci = await readFile(path.join(repoDir, '.gitlab-ci.yml'), 'utf8')
  const drain = await readFile(path.join(repoDir, 'scripts/deployment-drain.sh'), 'utf8')
  const edge = await readFile(path.join(repoDir, 'scripts/deployment-edge-gate.sh'), 'utf8')
  const drainTtl = Number(ci.match(/DEPLOYMENT_DRAIN_TTL_SECONDS: "(\d+)"/)?.[1])
  const edgeTtl = Number(ci.match(/DEPLOYMENT_EDGE_GATE_TTL_SECONDS: "(\d+)"/)?.[1])
  const timeoutHours = Number(ci.match(/terraform:apply:digitalocean:[\s\S]*?timeout: (\d+)h/)?.[1])

  assert.equal(drainTtl, 21_600)
  assert.equal(edgeTtl, 21_600)
  assert.equal(timeoutHours, 4)
  assert.ok(drainTtl >= timeoutHours * 3600 + 3600)
  assert.ok(edgeTtl >= timeoutHours * 3600 + 3600)
  assert.match(drain, /DEPLOYMENT_DRAIN_TTL_SECONDS:-21600/)
  assert.match(edge, /DEPLOYMENT_EDGE_GATE_TTL_SECONDS:-21600/)
})

test('Cloudflare gate never mutates the App Platform spec or Terraform ingress', async () => {
  const main = await readFile(path.join(repoDir, 'infra/terraform/environments/digitalocean/main.tf'), 'utf8')
  const variables = await readFile(path.join(repoDir, 'infra/terraform/environments/digitalocean/variables.tf'), 'utf8')
  const edge = await readFile(path.join(repoDir, 'scripts/deployment-edge-gate.sh'), 'utf8')

  assert.doesNotMatch(main, /secure_header|deployment_edge_gate_header|\bingress\s*{/)
  assert.doesNotMatch(variables, /deployment_edge_gate_header|secure_header/)
  assert.doesNotMatch(edge, /DIGITALOCEAN_TOKEN|api\.digitalocean\.com|\/apps(?:\?|\/)|secure_header/)
  assert.doesNotMatch(edge, /\/release-gpu|shutdown -h|poweroff|\/droplets/i)
  assert.match(edge, /RUKTER_AI_CLOUDFLARE_API_TOKEN/)
  assert.match(edge, /api\.cloudflare\.com\/client\/v4/)
})

test('production headers stay private and every continuity exemption stays Cloudflare-compatible', async () => {
  const edge = await readFile(path.join(repoDir, 'scripts/deployment-edge-gate.sh'), 'utf8')
  const drain = await readFile(path.join(repoDir, 'scripts/deployment-drain.sh'), 'utf8')
  const wait = await readFile(path.join(repoDir, 'scripts/wait-live-amd-queue-idle.sh'), 'utf8')
  const verify = await readFile(path.join(repoDir, 'scripts/verify-live-deployment.sh'), 'utf8')
  const combined = [edge, drain, wait, verify].join('\n')
  const expressionBuilder = edge.slice(edge.indexOf('expression_with_header_value()'), edge.indexOf('expression_for_owner()'))

  assert.doesNotMatch(edge, /-H\s+"Authorization: Bearer \$\{cloudflare_token\}"/)
  assert.doesNotMatch(combined, /-H\s+"\$\{(?:edge_header_key|EDGE_GATE_HEADER_KEY)\}: \$\{(?:edge_header_value|EDGE_GATE_HEADER_VALUE)\}"/)
  assert.doesNotMatch(combined, /args\+=\(-H\s+"\$\{(?:edge_header_key|EDGE_GATE_HEADER_KEY)\}/)
  for (const source of [edge, drain, wait, verify]) {
    assert.match(source, /chmod 600/)
    assert.match(source, /--header "@\$\{/)
  }
  assert.doesNotMatch(expressionBuilder, /\bmatches\b/)
  assert.doesNotMatch(expressionBuilder, /raw\.http\.request\.uri\.path/)
  assert.match(expressionBuilder, /starts_with\(http\.request\.uri\.path, "\/uploads\/"\)/)
  assert.match(expressionBuilder, /len\(http\.request\.uri\.path\) in \{49 50\}/)
  assert.match(expressionBuilder, /http\.request\.uri\.path\.extension in \{"png" "jpg" "webp" "avif" "gif" "mp4"\}/)
  assert.match(expressionBuilder, /substring\(http\.request\.uri\.path, 9\) contains "\/"/)
  assert.match(expressionBuilder, /substring\(http\.request\.uri\.path, 9\) contains "%"/)
  assert.ok(expressionBuilder.includes('substring(http.request.uri.path, 9) contains "\\\\"'))
  assert.match(expressionBuilder, /substring\(http\.request\.uri\.path, 9\) contains "\.\."/)
  assert.doesNotMatch(expressionBuilder, /starts_with\([^\n]*\/amd-worker\//)
  for (const workerFile of ['bootstrap.sh', 'app.py', 'gpu_telemetry.py', 'identity_guard.py', 'requirements.txt', 'run_story_pipeline.py', 'run_story_pipeline.sh']) {
    assert.match(expressionBuilder, new RegExp(`"/amd-worker/${workerFile.replaceAll('.', '\\.') }"`))
  }
  assert.match(expressionBuilder, /http\.request\.method eq "POST" and http\.request\.uri\.path eq "\/api\/story-presence"/)
  assert.doesNotMatch(expressionBuilder, /http\.request\.method eq "GET"[^\n]*"\/api\/story-presence"/)
  assert.match(edge, /local args=\(--path-as-is/)
  assert.match(edge, /--connect-timeout 5 --max-time 20/)
  assert.match(edge, /\/uploads\/\.\.\/api\/story-queue/)
  assert.match(edge, /%2e%2e\/api\/story-queue/)
  assert.match(edge, /%2f\.\.%2fapi%2fstory-queue/)
  assert.match(edge, /%5c\.\.%5capi%5cstory-queue/)
  assert.match(edge, /presence_code[\s\S]*== "401"[\s\S]*presence_code[\s\S]*== "404"[\s\S]*presence_code[\s\S]*== "405"/)
  assert.match(edge, /presence_get_code[\s\S]*== "403"/)
  assert.match(verify, /amdGpuAutoShutdown == false and \.amdGpuAlwaysOn == true/)
  assert.match(verify, /\.activeJobPresent == false[\s\S]*\.awaitingApprovalJobs == 0/)
})

test('live verification sends the exact gate header and fails closed when required state is absent', async (t) => {
  const key = 'X-Rukter-Deploy-Gate-rukter-ci-test'
  const value = 'a'.repeat(64)
  const commit = '0123456789abcdef0123456789abcdef01234567'
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url, gate: req.headers[key.toLowerCase()] || '' })
    if (req.headers[key.toLowerCase()] !== value) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'gate required' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url === '/health') {
      res.end(JSON.stringify({ status: 'ok', commitSha: commit }))
    } else if (req.url === '/api/config') {
      res.end(JSON.stringify({ amdGpuAutoShutdown: false, amdGpuAlwaysOn: true }))
    } else if (req.url === '/api/story-queue') {
      res.end(JSON.stringify({
        activeJobPresent: false,
        queuedJobs: 0,
        readyJobs: 0,
        preparingJobs: 0,
        inProgressJobs: 0,
        planningJobs: 0,
        awaitingApprovalJobs: 0,
      }))
    } else {
      res.end(JSON.stringify({ error: 'not found' }))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rukter-edge-header-'))
  const stateFile = path.join(tmp, 'edge.json')
  const binDir = path.join(tmp, 'bin')
  const curlArgvLog = path.join(tmp, 'curl-argv.log')
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
  await writeFile(stateFile, JSON.stringify({ header_key: key, header_value: value }), { mode: 0o600 })
  const common = {
    CI_COMMIT_SHA: commit,
    RUKTER_AI_PUBLIC_URL: `http://127.0.0.1:${server.address().port}`,
    DEPLOYMENT_EDGE_GATE_REQUIRED: 'true',
    DEPLOYMENT_VERIFY_WAIT_SECONDS: '2',
    DEPLOYMENT_VERIFY_POLL_SECONDS: '1',
    PATH: `${binDir}:${process.env.PATH}`,
    CURL_ARGV_LOG: curlArgvLog,
    REAL_CURL: '/usr/bin/curl',
  }
  const verified = await run('bash', ['scripts/verify-live-deployment.sh'], {
    ...common,
    DEPLOYMENT_EDGE_GATE_STATE_FILE: stateFile,
  })
  assert.equal(verified.code, 0, verified.stderr)
  assert.deepEqual(seen, [
    { path: '/health', gate: value },
    { path: '/api/config', gate: value },
    { path: '/api/story-queue', gate: value },
  ])
  const curlArgv = await readFile(curlArgvLog, 'utf8')
  assert.doesNotMatch(curlArgv, new RegExp(value))
  const headerFiles = [...new Set(curlArgv.split('\n').filter((line) => line.startsWith('HEADER:')).map((line) => line.slice(7)))]
  assert.ok(headerFiles.length > 0)
  for (const headerFile of headerFiles) await assert.rejects(access(headerFile))

  const missing = await run('bash', ['scripts/verify-live-deployment.sh'], {
    ...common,
    DEPLOYMENT_EDGE_GATE_STATE_FILE: path.join(tmp, 'missing.json'),
  })
  assert.notEqual(missing.code, 0)
  assert.match(missing.stderr, /state is required/)
})

test('drain and idle scripts require a valid gate header when the transaction says it is active', async () => {
  const drain = await readFile(path.join(repoDir, 'scripts/deployment-drain.sh'), 'utf8')
  const wait = await readFile(path.join(repoDir, 'scripts/wait-live-amd-queue-idle.sh'), 'utf8')

  for (const source of [drain, wait]) {
    assert.match(source, /DEPLOYMENT_EDGE_GATE_REQUIRED/)
    assert.match(source, /header_key[\s\S]*\^\[A-Za-z0-9-\]/)
    assert.match(source, /header_value[\s\S]*\^\[A-Fa-f0-9\]\{64\}/)
    assert.match(source, /EDGE_GATE_HEADER|edge_header_key/)
  }
  assert.match(wait, /activeUserSessions/)
  assert.ok((wait.match(/active_user_sessions\}" == "0"/g) ?? []).length >= 2)
  assert.match(wait, /worker_verifiable\}" == "true" && "\$\{worker_idle\}" == "true"/)
  assert.match(wait, /active_users=/)
  assert.match(drain, /activeUserSessions/)
})

test('post-gate idle wait fails before any app poll when required edge state is missing', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rukter-edge-required-wait-'))
  const drainState = path.join(tmp, 'drain.env')
  await writeFile(drainState, [
    'mode=active',
    'drain_id=rukter_ci_0123456789abcdef0123456789abcdef01234567',
    'owned_tag=test',
    'droplet_id=584070698',
    '',
  ].join('\n'))

  const result = await run('bash', ['scripts/wait-live-amd-queue-idle.sh'], {
    AMD_GPU_ORCHESTRATOR_TOKEN: 'test-control-token',
    DEPLOYMENT_DRAIN_STATE_FILE: drainState,
    DEPLOYMENT_EDGE_GATE_STATE_FILE: path.join(tmp, 'missing-edge.json'),
    DEPLOYMENT_EDGE_GATE_REQUIRED: 'true',
    DEPLOYMENT_DRAIN_WAIT_SECONDS: '1',
    DEPLOYMENT_DRAIN_POLL_SECONDS: '1',
    RUKTER_AI_PUBLIC_URL: 'http://127.0.0.1:1',
  })

  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /state is required/)
  assert.doesNotMatch(result.stderr, /curl:/)
})
