import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const exactProductionTargets = {
  RUKTER_AI_DEPLOYMENT_PRODUCTION: 'true',
  RUKTER_AI_PUBLIC_URL: 'https://rukter.ai',
  DEPLOYMENT_EDGE_GATE_PUBLIC_URL: 'https://rukter.ai',
  DEPLOYMENT_EDGE_GATE_API_URL: 'https://api.cloudflare.com/client/v4',
  DEPLOYMENT_EDGE_GATE_ZONE_NAME: 'rukter.ai',
  DEPLOYMENT_DRAIN_DIGITALOCEAN_API_URL: 'https://api.digitalocean.com/v2',
  AMD_GPU_DIGITALOCEAN_API_URL: 'https://api.digitalocean.com/v2',
  AMD_GPU_PERSISTENT_TAG: 'rukter-product-story-persistent',
  AMD_GPU_WORKER_SOURCE_BASE_URL: 'https://rukter.ai/amd-worker',
  AMD_GPU_ORCHESTRATOR_URL: 'http://127.0.0.1:3017',
}

async function runScript(script, args = [], env = {}) {
  return await new Promise((resolve) => {
    const child = spawn('bash', [script, ...args], {
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

test('production target guard requires every public URL, provider API, and persistent tag independently', async () => {
  const accepted = await runScript('scripts/assert-production-targets.sh', [], exactProductionTargets)
  assert.equal(accepted.code, 0, accepted.stderr)

  const localOverride = await runScript('scripts/assert-production-targets.sh', [], {
    ...exactProductionTargets,
    RUKTER_AI_DEPLOYMENT_PRODUCTION: 'false',
    RUKTER_AI_PUBLIC_URL: 'http://127.0.0.1:3000',
    DEPLOYMENT_DRAIN_DIGITALOCEAN_API_URL: 'http://127.0.0.1:3001/v2',
  })
  assert.equal(localOverride.code, 0, 'non-production tests must retain explicit local endpoint overrides')

  for (const name of Object.keys(exactProductionTargets).filter((key) => key !== 'RUKTER_AI_DEPLOYMENT_PRODUCTION')) {
    const rejected = await runScript('scripts/assert-production-targets.sh', [], {
      ...exactProductionTargets,
      [name]: '',
    })
    assert.equal(rejected.code, 2, `${name} must fail closed when unset or overridden`)
    assert.match(rejected.stderr, new RegExp(name))
  }
})

test('every production mutation and apply entrypoint runs the shared guard before credentials or network work', async () => {
  const scripts = [
    ['scripts/deployment-drain.sh', ['status']],
    ['scripts/wait-live-amd-queue-idle.sh', []],
    ['scripts/verify-live-deployment.sh', []],
    ['scripts/bootstrap-persistent-amd.sh', []],
    ['scripts/run-terraform-apply-with-watchdog.sh', []],
    ['scripts/deployment-edge-gate.sh', ['status']],
  ]

  for (const [script, args] of scripts) {
    const source = await readFile(path.join(repoDir, script), 'utf8')
    assert.match(source, /bash "\$\{script_dir\}\/assert-production-targets\.sh"/)
    const rejected = await runScript(script, args, {
      ...exactProductionTargets,
      RUKTER_AI_PUBLIC_URL: 'https://override.invalid',
    })
    assert.equal(rejected.code, 2, `${script} must refuse a production target override`)
    assert.match(rejected.stderr, /RUKTER_AI_PUBLIC_URL/)
  }
})

test('edge gate production mode separately refuses either public URL override even without the shared mode', async () => {
  const base = {
    ...exactProductionTargets,
    RUKTER_AI_DEPLOYMENT_PRODUCTION: 'false',
    DEPLOYMENT_EDGE_GATE_PRODUCTION: 'true',
    DEPLOYMENT_EDGE_GATE_TEST_MODE: 'false',
    RUKTER_AI_CLOUDFLARE_API_TOKEN: 'cf-production-pin-test-token',
    CI_COMMIT_SHA: 'a'.repeat(40),
    CI: '',
    GITLAB_CI: '',
  }

  const appOverride = await runScript('scripts/deployment-edge-gate.sh', ['status'], {
    ...base,
    RUKTER_AI_PUBLIC_URL: 'https://override.invalid',
  })
  assert.equal(appOverride.code, 2)
  assert.match(appOverride.stderr, /RUKTER_AI_PUBLIC_URL=https:\/\/rukter\.ai/)

  const edgeOverride = await runScript('scripts/deployment-edge-gate.sh', ['status'], {
    ...base,
    DEPLOYMENT_EDGE_GATE_PUBLIC_URL: 'https://override.invalid',
  })
  assert.equal(edgeOverride.code, 2)
  assert.match(edgeOverride.stderr, /exact https:\/\/rukter\.ai public URL|DEPLOYMENT_EDGE_GATE_PUBLIC_URL=https:\/\/rukter\.ai/)
})

test('production CI pins targets at job scope and keeps DigitalOcean bearer tokens out of curl argv', async () => {
  const ci = await readFile(path.join(repoDir, '.gitlab-ci.yml'), 'utf8')
  const applyJob = ci.slice(ci.indexOf('terraform:apply:digitalocean:'), ci.indexOf('verify:rukter-ai:digitalocean:'))
  const buildJob = ci.slice(ci.indexOf('build:docr:digitalocean:'), ci.indexOf('terraform:validate:digitalocean:'))
  const drain = await readFile(path.join(repoDir, 'scripts/deployment-drain.sh'), 'utf8')
  const wait = await readFile(path.join(repoDir, 'scripts/wait-live-amd-queue-idle.sh'), 'utf8')
  const bootstrap = await readFile(path.join(repoDir, 'scripts/bootstrap-persistent-amd.sh'), 'utf8')
  const prune = await readFile(path.join(repoDir, 'scripts/prune-docr-repository.sh'), 'utf8')

  for (const [name, value] of Object.entries(exactProductionTargets)) {
    assert.match(applyJob, new RegExp(`${name}: "${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`))
    if (name !== 'RUKTER_AI_DEPLOYMENT_PRODUCTION') {
      assert.match(applyJob, new RegExp(`test "\\$\\{${name}:-\\}" = `), `${name} needs an independent CI preflight`)
    }
  }

  for (const source of [drain, wait, bootstrap, prune, `${buildJob}\n${applyJob}`]) {
    assert.match(source, /rukter-do-headers\.XXXXXX/)
    assert.match(source, /chmod 600/)
    assert.match(source, /--header "@\$\{[^}]*header[^}]*\}"/i)
    assert.doesNotMatch(source, /curl[^\n]*-H "Authorization: Bearer \$\{(?:DIGITALOCEAN_TOKEN|AMD_GPU_DIGITALOCEAN_TOKEN|deployment_digitalocean_token)\}"/)
  }
  assert.match(buildJob, /DO_METADATA="\$\(\{[\s\S]*set -euo pipefail[\s\S]*trap 'rm -f "\$\{DO_HEADER_FILE\}"' EXIT[\s\S]*\}\)"[\s\S]*build_log="\$\(mktemp\)"/)
  assert.match(applyJob, /app_id="\$\(\{[\s\S]*set -euo pipefail[\s\S]*trap 'rm -f "\$\{do_header_file\}"' EXIT[\s\S]*\}\)"[\s\S]*test -n "\$\{app_id\}"/)
  assert.doesNotMatch(`${buildJob}\n${applyJob}`, /trap - EXIT/)
})

test('legacy migration docs state that exact-SHA approval is attestation, not zero-user proof', async () => {
  const rootReadme = await readFile(path.join(repoDir, 'README.md'), 'utf8')
  const infraReadme = await readFile(path.join(repoDir, 'infra/terraform/environments/digitalocean/README.md'), 'utf8')
  for (const source of [rootReadme, infraReadme]) {
    assert.match(source, /manual (?:exact-SHA )?owner attestation/i)
    assert.match(source, /not complete technical proof of zero users/i)
    assert.match(source, /default origin ingress/i)
  }
})

test('production docs identify the pinned worker code origin and loopback orchestrator', async () => {
  const rootReadme = await readFile(path.join(repoDir, 'README.md'), 'utf8')
  const infraReadme = await readFile(path.join(repoDir, 'infra/terraform/environments/digitalocean/README.md'), 'utf8')
  for (const source of [rootReadme, infraReadme]) {
    assert.match(source, /AMD_GPU_WORKER_SOURCE_BASE_URL[^\n]*https:\/\/rukter\.ai\/amd-worker/)
    assert.match(source, /AMD_GPU_ORCHESTRATOR_URL[^\n]*http:\/\/127\.0\.0\.1:3017/)
    assert.match(source, /production[^\n]*refuses[^\n]*override/i)
  }
})
