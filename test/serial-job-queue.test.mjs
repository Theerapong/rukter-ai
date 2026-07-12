import assert from 'node:assert/strict'
import test from 'node:test'
import { createSerialJobQueue } from '../lib/serial-job-queue.mjs'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve))
}

test('runs ready jobs one at a time in reservation order', async () => {
  const gates = new Map([['first', deferred()], ['second', deferred()], ['third', deferred()]])
  const events = []
  const queue = createSerialJobQueue({
    runJob: async (id) => {
      events.push(`start:${id}`)
      await gates.get(id).promise
      events.push(`end:${id}`)
    },
  })

  queue.reserve('first')
  queue.reserve('second')
  queue.reserve('third')
  queue.markReady('second')
  queue.markReady('third')
  await nextTurn()
  assert.deepEqual(events, [])
  assert.deepEqual(queue.position('second'), {
    state: 'waiting',
    position: 2,
    jobsAhead: 1,
    ready: true,
    reservedAt: queue.position('second').reservedAt,
    readyAt: queue.position('second').readyAt,
  })

  queue.markReady('first')
  await nextTurn()
  assert.deepEqual(events, ['start:first'])
  assert.equal(queue.snapshot().activeId, 'first')
  assert.equal(queue.position('second').jobsAhead, 1)

  gates.get('first').resolve()
  await nextTurn()
  assert.deepEqual(events, ['start:first', 'end:first', 'start:second'])
  gates.get('second').resolve()
  await nextTurn()
  assert.deepEqual(events, ['start:first', 'end:first', 'start:second', 'end:second', 'start:third'])
  gates.get('third').resolve()
  await queue.whenIdle()
  assert.equal(queue.snapshot().size, 0)
})

test('cancels a waiting reservation and advances its followers', async () => {
  const gate = deferred()
  const events = []
  const queue = createSerialJobQueue({
    runJob: async (id) => {
      events.push(id)
      if (id === 'active') await gate.promise
    },
  })

  queue.reserve('active')
  queue.reserve('cancelled')
  queue.reserve('next')
  queue.markReady('active')
  queue.markReady('cancelled')
  queue.markReady('next')
  await nextTurn()
  assert.equal(queue.cancel('active'), false)
  assert.equal(queue.cancel('cancelled'), true)
  assert.equal(queue.position('next').position, 2)
  assert.equal(queue.position('next').jobsAhead, 1)

  gate.resolve()
  await queue.whenIdle()
  assert.deepEqual(events, ['active', 'next'])
})

test('continues with the next job after a runner failure', async () => {
  const events = []
  const errors = []
  const queue = createSerialJobQueue({
    runJob: async (id) => {
      events.push(id)
      if (id === 'failed') throw new Error('render failed')
    },
    onError: (error, id) => errors.push(`${id}:${error.message}`),
  })

  queue.reserve('failed')
  queue.reserve('next')
  queue.markReady('failed')
  queue.markReady('next')
  await queue.whenIdle()

  assert.deepEqual(events, ['failed', 'next'])
  assert.deepEqual(errors, ['failed:render failed'])
  assert.equal(queue.snapshot().size, 0)
})
