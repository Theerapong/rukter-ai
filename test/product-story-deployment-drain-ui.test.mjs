import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8')
const htmlSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8')
const cssSource = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8')

test('pauses only new Product Story work during a deployment drain', () => {
  assert.match(htmlSource, /id="deploymentDrainBanner"/)
  assert.match(htmlSource, /Existing jobs and approvals continue normally/)
  assert.match(appSource, /deploymentDraining/)
  assert.match(appSource, /deploymentDrainRetryAfterSeconds/)
  assert.match(appSource, /nested\?\.admissionLocked/)
  assert.match(appSource, /snapshot\?\.deploymentDrain/)
  assert.match(appSource, /generateButton\.disabled = deploymentDrain\.active/)
  assert.match(appSource, /approveAmdButton\.disabled = approvingJob \|\| !approvalAcknowledgement\.checked/)
  assert.doesNotMatch(appSource, /AMD approval paused for update/)
  assert.match(cssSource, /\.deployment-drain-banner/)
})

test('turns a deployment drain rejection into a recoverable maintenance state', () => {
  assert.match(appSource, /deployment_drain_active/)
  assert.match(appSource, /deployment_drain_check_failed/)
  assert.match(appSource, /response\.status !== 503/)
  assert.match(appSource, /handleDeploymentDrainResponse\(response, payload\)/)
  assert.match(appSource, /setInterval\(\(\) => \{[\s\S]*?void refreshStoryPresence\(\)[\s\S]*?void refreshQueueDetails\(\)[\s\S]*?\}, 10_000\)/)
  assert.match(appSource, /New Product Story jobs are available again/)
  assert.match(appSource, /requestJobCancellation/)
  assert.match(appSource, /pollJob\(id\)/)
})
