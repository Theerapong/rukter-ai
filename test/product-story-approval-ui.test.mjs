import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8')
const htmlSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8')

test('keeps AMD capacity checks separate from explicit render approval', () => {
  assert.doesNotMatch(appSource, /amdModeInput\.checked\s*=\s*true/)
  assert.match(appSource, /Analyze & plan/)
  assert.match(appSource, /status === 'awaiting_approval'/)
  assert.match(appSource, /\/api\/story-jobs\/\$\{encodeURIComponent\(currentJob\.id\)\}\/approve/)
  assert.match(appSource, /expectedUpdatedAt: currentJob\.updatedAt/)
  assert.match(appSource, /awaiting_approval' \? 5_000 : 650/)
  assert.match(appSource, /\[401, 403, 404\]\.includes\(error\?\.status\)/)
  assert.match(htmlSource, /Approve AMD render/)
})

test('sends structured direction and keeps the persistent worker lifecycle truthful', () => {
  assert.match(appSource, /direction: submittedDirection/)
  assert.match(appSource, /campaignGoal:/)
  assert.match(appSource, /scenePolicy:/)
  assert.match(appSource, /peoplePolicy:/)
  assert.doesNotMatch(appSource, /allow_hands_interaction|Hands may interact/)
  assert.match(htmlSource, /Render not started/)
  assert.match(htmlSource, /persistent worker remains online and credits continue/)
  assert.doesNotMatch(htmlSource, /releaseGpuButton|Release GPU|Destroy after job/i)
  assert.doesNotMatch(appSource, /\/release-gpu|releaseGpuButton/)
  assert.match(appSource, /output\?\.evidence \|\| job\?\.failureEvidence/)
  assert.match(appSource, /Number\(evidence\.shot\)/)
  assert.match(appSource, /clip_similarity_below_threshold/)
})

test('cancels an active story before resetting without touching the persistent Droplet', () => {
  assert.match(appSource, /window\.confirm\('This Product Story is still active\./)
  assert.match(appSource, /await requestJobCancellation\(currentJob\)/)
  assert.match(appSource, /\/cancel`/)
  assert.match(appSource, /persistent AMD worker remains online/i)
})

test('preserves original transparent uploads when no resize is required', () => {
  assert.match(appSource, /if \(scale === 1 && file\.size <= maxImageBytes\)/)
  assert.match(appSource, /const canPreserveTransparency = file\.type !== 'image\/jpeg'/)
  assert.match(appSource, /canPreserveTransparency \? 'image\/webp' : 'image\/jpeg'/)
})
