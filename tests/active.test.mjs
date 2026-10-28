// node --test tests/active.test.mjs
// The pure Desktop modules (src/active.ts, src/status.ts) driven with fake events, a fake clock and a counting rest.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createProgressTracker,
  createTaskPoller,
  httpStatus,
  isTripoCall,
  MAX_FAILURES,
  MISSING_GRACE_MS,
  POLL_MS,
  taskStatuses
} from '../src/active.ts'
import { balanceLabel, createStatusStore, DEFAULT_SETTINGS, isForeign, watchScope } from '../src/status.ts'

const A = 'a1b2c3d4-0000-4000-8000-000000000001'
const B = 'b1b2c3d4-0000-4000-8000-000000000002'
const ids = n => Array.from({ length: n }, (_, i) => `c1b2c3d4-0000-4000-8000-${String(i).padStart(12, '0')}`)

const flush = () => new Promise(resolve => setImmediate(resolve))

function fakeClock() {
  let now = 0
  let seq = 0
  const timers = new Map()
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      timers.set(++seq, { fn, at: now + ms })
      return seq
    },
    clearTimeout: id => timers.delete(id),
    pending: () => timers.size,
    async advance(ms) {
      const end = now + ms
      for (;;) {
        await flush()
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = end
      await flush()
    }
  }
}

/** ctx with one listener per event type, and a rest that answers from `replies` in order and records each path. */
function fakeCtx(replies = []) {
  const listeners = new Map()
  const paths = []
  return {
    paths,
    onEvent(type, fn) {
      listeners.set(type, fn)
      return () => listeners.delete(type)
    },
    emit: (type, event) => listeners.get(type)?.(event),
    async rest(path) {
      paths.push(path)
      const reply = replies.length ? replies.shift() : { configured: true, tasks: [], done: [], missing: [] }
      if (reply instanceof Error) throw reply
      return reply
    }
  }
}

// What Desktop's tool.complete carries for a create made through tool search: the MCP text JSON inside `result`.
const created = (id, extra = {}) => ({
  payload: {
    name: 'tool_call',
    args: { calls: [{ name: 'mcp__tripo__tripo_text_to_3d', arguments: { prompt: 'a chair' } }] },
    result: JSON.stringify({ result: JSON.stringify({ task_id: id, status: 'queued', next: 'tripo_task_wait' }) })
  },
  ...extra
})
const running = (id, progress) => ({ task_id: id, type: 'text_to_model', status: 'running', progress, prompt: 'a chair' })

test('only Tripo calls count, direct or through the tool_call bridge in any of its shapes', () => {
  assert.ok(isTripoCall('mcp__tripo__tripo_balance', {}))
  assert.ok(isTripoCall('tool_call', { calls: [{ name: 'mcp__tripo__tripo_download' }] }))
  assert.ok(isTripoCall('tool_call', { calls: JSON.stringify([{ name: 'mcp__tripo__tripo_rig' }]) }))
  assert.ok(isTripoCall('tool_call', { name: 'mcp__tripo__tripo_usage', arguments: {} }))
  assert.ok(isTripoCall('tool_call', { calls: { name: 'mcp__tripo__tripo_plan' } }))
  for (const [name, args] of [
    ['mcp__meshy__meshy_balance', {}],
    ['mcp__tripox__tripo_balance', {}],
    ['tripo_balance', {}],
    ['tool_call', { calls: [{ name: 'mcp__meshy__meshy_text_to_3d' }] }],
    ['tool_call', { calls: 'not json' }],
    ['tool_call', null],
    ['terminal', { command: 'mcp__tripo__tripo_balance' }]
  ]) {
    assert.equal(isTripoCall(name, args), false, `${name} ${JSON.stringify(args)}`)
  }
})

test('task ids and statuses are read from JSON text nested in JSON, at any depth', () => {
  const inner = JSON.stringify({ tasks: [{ task_id: A, status: 'RUNNING' }, { task_id: B, status: 'success' }] })
  assert.deepEqual([...taskStatuses(JSON.stringify({ result: inner }))], [[A, 'running'], [B, 'success']])
  assert.deepEqual([...taskStatuses({ result: [{ task_id: 'not-an-id', status: 'queued' }, { task_id: A }] })], [])
  assert.deepEqual([...taskStatuses('{"broken": ')], [])
  assert.deepEqual([...taskStatuses(null)], [])
})

test('the HTTP status of a ctx.rest failure comes from the field or from the IPC message', () => {
  assert.equal(httpStatus({ statusCode: 404 }), 404)
  assert.equal(httpStatus(new Error('502: {"detail":"Tripo API unreachable"}')), 502)
  assert.equal(httpStatus(new Error("Error invoking remote method 'hermes:api': Error: 409: {}")), 409)
  assert.equal(httpStatus(new Error('timeout')), null)
})

test('a created task is followed with one batch read per poll until it finishes, then the balance is re-read', async () => {
  const clock = fakeClock()
  const ctx = fakeCtx([
    { configured: true, tasks: [running(A, 40)], done: [], missing: [] },
    { configured: true, tasks: [], done: [A], missing: [] }
  ])
  const states = []
  let finished = 0
  const tracker = createProgressTracker(ctx, s => states.push(s.tasks.map(t => t.progress)), () => (finished += 1), { clock })
  ctx.emit('tool.complete', created(A))
  assert.deepEqual(tracker.watching(), [A])
  await clock.advance(1000)
  assert.deepEqual(ctx.paths, [`active?tasks=${A}`])
  assert.deepEqual(states.at(-1), [40])
  await clock.advance(POLL_MS)
  assert.equal(ctx.paths.length, 2)
  assert.deepEqual(states.at(-1), [])
  assert.equal(finished, 1)
  await clock.advance(10 * POLL_MS)
  assert.equal(ctx.paths.length, 2, 'nothing is read while no task runs')
  assert.equal(clock.pending(), 0)
})

test('other tools and other profiles never start polling', async () => {
  const clock = fakeClock()
  const ctx = fakeCtx()
  const tracker = createProgressTracker(ctx, () => {}, () => {}, { clock, foreign: e => e.profile === 'work' })
  ctx.emit('tool.complete', { payload: { name: 'mcp__meshy__meshy_text_to_3d', result: JSON.stringify({ task_id: A, status: 'queued' }) } })
  ctx.emit('tool.complete', created(B, { profile: 'work' }))
  await clock.advance(10 * POLL_MS)
  assert.deepEqual(tracker.watching(), [])
  assert.deepEqual(ctx.paths, [])
})

test('a tool result that reports the task finished stops following it at once', async () => {
  const clock = fakeClock()
  const ctx = fakeCtx()
  let finished = 0
  const tracker = createProgressTracker(ctx, () => {}, () => (finished += 1), { clock })
  ctx.emit('tool.complete', created(A))
  const waited = { payload: { name: 'mcp__tripo__tripo_task_wait', args: { task_id: A }, result: JSON.stringify({ task_id: A, status: 'success' }) } }
  ctx.emit('tool.complete', waited)
  assert.deepEqual(tracker.watching(), [])
  assert.equal(finished, 1)
  await clock.advance(10 * POLL_MS)
  assert.deepEqual(ctx.paths, [])
})

test('the newest eight tasks are read; a task Tripo does not know is dropped after the grace period', async () => {
  const clock = fakeClock()
  const many = ids(10)
  const ctx = fakeCtx(Array.from({ length: 40 }, () => ({ configured: true, tasks: [], done: [], missing: [many[9]] })))
  const tracker = createProgressTracker(ctx, () => {}, () => {}, { clock })
  ctx.emit('tool.complete', { payload: { name: 'mcp__tripo__tripo_task_list', result: JSON.stringify({ tasks: many.map(id => ({ task_id: id, status: 'queued' })) }) } })
  await clock.advance(1000)
  assert.deepEqual(decodeURIComponent(ctx.paths[0].split('=')[1]).split(','), many.slice(2))
  assert.ok(tracker.watching().includes(many[9]), 'kept while Tripo may still be listing it')
  await clock.advance(MISSING_GRACE_MS)
  assert.ok(!tracker.watching().includes(many[9]))
})

test('a refused read stops at once; failures that may pass back off and stop after a few', async () => {
  const clock = fakeClock()
  const refused = fakeCtx([new Error('404: {"detail":"Not Found"}')])
  const one = createProgressTracker(refused, () => {}, () => {}, { clock })
  refused.emit('tool.complete', created(A))
  await clock.advance(10 * POLL_MS)
  assert.equal(refused.paths.length, 1)
  assert.deepEqual(one.watching(), [])

  const clock2 = fakeClock()
  const flaky = fakeCtx(Array.from({ length: 10 }, () => new Error('502: {"detail":"Tripo API unreachable"}')))
  const two = createProgressTracker(flaky, () => {}, () => {}, { clock: clock2 })
  flaky.emit('tool.complete', created(A))
  await clock2.advance(1000)
  await clock2.advance(POLL_MS)
  assert.equal(flaky.paths.length, 1, 'the first failure waits longer than a normal poll')
  await clock2.advance(10 * 60_000)
  assert.equal(flaky.paths.length, MAX_FAILURES)
  assert.deepEqual(two.watching(), [])
  // The next Tripo call starts over.
  flaky.emit('tool.complete', created(B))
  await clock2.advance(1000)
  assert.equal(flaky.paths.length, MAX_FAILURES + 1)
})

test('no key, or a profile switch, forgets the tasks; a reply from before the switch is dropped', async () => {
  const clock = fakeClock()
  const ctx = fakeCtx([{ configured: false, tasks: [], done: [], missing: [] }])
  const tracker = createProgressTracker(ctx, () => {}, () => {}, { clock })
  ctx.emit('tool.complete', created(A))
  await clock.advance(1000)
  assert.deepEqual(tracker.watching(), [])

  let release
  const slow = fakeCtx()
  slow.rest = path => {
    slow.paths.push(path)
    return new Promise(resolve => (release = resolve))
  }
  const states = []
  const switched = createProgressTracker(slow, s => states.push(s.tasks.length), () => {}, { clock })
  slow.emit('tool.complete', created(B))
  await clock.advance(1000)
  switched.rescope()
  release({ configured: true, tasks: [running(B, 10)], done: [], missing: [] })
  await clock.advance(POLL_MS)
  assert.deepEqual(switched.watching(), [])
  assert.ok(states.every(n => n === 0), `the old profile's task never shows: ${states}`)
})

test('a card polls its task while it runs, stops when it ends, and stops on a refusal until Retry', async () => {
  const clock = fakeClock()
  const replies = [{ status: 'queued' }, { status: 'running' }, { status: 'success' }]
  let reads = 0
  const states = []
  createTaskPoller(async () => (reads += 1, replies.shift()), s => states.push(s), String, clock)
  await clock.advance(60_000)
  assert.equal(reads, 3)
  assert.equal(states.at(-1).info.status, 'success')

  const failing = [new Error('404: {"detail":"Tripo has no such task for this key"}'), { status: 'success' }]
  const seen = []
  const poller = createTaskPoller(async () => {
    const r = failing.shift()
    if (r instanceof Error) throw r
    return r
  }, s => seen.push(s), e => e.message, clock)
  await clock.advance(60_000)
  assert.equal(seen.at(-1).stopped, true)
  assert.equal(clock.pending(), 0)
  poller.retry()
  await clock.advance(0)
  assert.equal(seen.at(-1).info.status, 'success')
  assert.equal(seen.at(-1).stopped, false)
})

test('the chip names the balance, or why there is none', () => {
  assert.equal(balanceLabel({ configured: false }), 'no key')
  assert.equal(balanceLabel({ configured: true, balance: 12345 }), '12,345 cr')
  assert.equal(balanceLabel({ configured: true, error: 'Tripo rejected the API key', error_code: 'key_rejected' }), 'key rejected')
  assert.equal(balanceLabel({ configured: true, error: 'Tripo API unreachable', error_code: 'offline' }), 'offline')
  assert.equal(balanceLabel({ configured: true, error: 'Tripo API error 2000', error_code: 'api_error' }), 'unavailable')
})

function atom(value) {
  const subs = new Set()
  return {
    get: () => value,
    subscribe(fn) {
      subs.add(fn)
      fn(value)
      return () => subs.delete(fn)
    },
    set(next) {
      value = next
      subs.forEach(fn => fn(value))
    }
  }
}

test('the status store applies settings, and a profile switch drops the old profile’s late reply', async () => {
  const state = { profile: atom('default'), connectionId: atom(null) }
  const pending = []
  const rest = () => new Promise(resolve => pending.push(resolve))
  const store = createStatusStore(rest, state)
  const balances = []
  store.onBalance(b => balances.push(b))
  void store.refresh()
  state.profile.set('work') // the switch refetches by itself
  pending[0]({ configured: true, balance: 999 }) // the old profile's reply lands after the switch
  await flush()
  assert.equal(store.balance(), null)
  pending[1]({ configured: true, balance: 7, settings: { show_credits: false } })
  await flush()
  assert.equal(store.balance().balance, 7)
  assert.deepEqual(store.settings(), { ...DEFAULT_SETTINGS, show_credits: false })
  assert.ok(!balances.some(b => b?.balance === 999))
  store.dispose()
})

test('events tagged with another profile or connection are foreign; untagged ones are not', () => {
  const state = { profile: atom('default'), connectionId: atom('local') }
  assert.equal(isForeign({}, state), false)
  assert.equal(isForeign({ profile: 'default' }, state), false)
  assert.equal(isForeign({ profile: 'work' }, state), true)
  assert.equal(isForeign({ connectionId: 'remote-1' }, state), true)
  assert.equal(isForeign({ profile: 'work' }, undefined), false, 'an older Desktop has one backend')
  const seen = []
  const stop = watchScope(state, key => seen.push(key))
  state.profile.set('default')
  state.profile.set('work')
  stop()
  state.profile.set('other')
  assert.deepEqual(seen, ['local\nwork'])
})
