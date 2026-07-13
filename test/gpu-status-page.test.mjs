import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('GPU Status is linked from the director and keeps public telemetry sanitized', async () => {
  const [index, page, client, server, docs] = await Promise.all([
    readFile(path.join(repoDir, 'public/index.html'), 'utf8'),
    readFile(path.join(repoDir, 'public/gpu-status.html'), 'utf8'),
    readFile(path.join(repoDir, 'public/gpu-status.js'), 'utf8'),
    readFile(path.join(repoDir, 'server.mjs'), 'utf8'),
    readFile(path.join(repoDir, 'infra/grafana/README.md'), 'utf8'),
  ])

  assert.match(index, /href="\/gpu-status\.html"/)
  assert.match(page, /id="workerState"/)
  assert.match(page, /id="metricsUrl"/)
  assert.match(client, /fetch\('\/api\/gpu-status'/)
  assert.match(client, /setInterval\(refresh, 10_000\)/)
  assert.match(server, /url\.pathname === '\/api\/gpu-status'/)
  assert.match(server, /url\.pathname === '\/metrics'/)
  assert.match(server, /activeSessions: activeVisibleStorySessionCount\(\)/)
  assert.match(server, /gpuTelemetry: publicGpuTelemetry\(worker\.gpuTelemetry\)/)
  assert.match(docs, /Prometheus-compatible endpoint/)
  assert.doesNotMatch(page + client, /AMD_GPU_ORCHESTRATOR_TOKEN|workerUrl|persistentWorkerId/)
})
