// node --test tests/active.test.mjs
// The pure Desktop modules (src/active.ts, src/status.ts, src/chat.ts, src/provenance.ts, src/gallery.ts) driven
// with fake events, a fake clock, a fake host and a counting rest.
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
  stageWord,
  taskStatuses
} from '../src/active.ts'
import { cardChat, OPEN_RETRIES, OPEN_RETRY_MS, recordedChat } from '../src/chat.ts'
import { kindOf, rowFromTask, visibleRows } from '../src/gallery.ts'
import { creationsFrom } from '../src/provenance.ts'
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

test('the progress line names what Tripo is doing, or the task type it has no word for', () => {
  assert.equal(stageWord('text_to_model'), 'modelling')
  assert.equal(stageWord('animate_rig'), 'rigging')
  assert.equal(stageWord('generate_multiview_image'), 'drawing views')
  assert.equal(stageWord('some_new_type'), 'some new type')
  assert.equal(stageWord(''), 'working')
})

test('each creating call is recorded with the task it made, direct or through the tool_call bridge', () => {
  const queued = id => JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ task_id: id, status: 'queued' }) }] })
  assert.deepEqual(creationsFrom('mcp__tripo__tripo_text_to_3d', { prompt: 'a fox' }, queued(A)), [
    { task_id: A, tool: 'tripo_text_to_3d', args: { prompt: 'a fox' } }
  ])
  // A dry run or an error names no task; reads, downloads and other servers create nothing.
  assert.deepEqual(creationsFrom('mcp__tripo__tripo_text_to_3d', { dry_run: true }, JSON.stringify({ dry_run: true, credits: 30 })), [])
  assert.deepEqual(creationsFrom('mcp__tripo__tripo_task_status', { task_id: A }, queued(A)), [])
  assert.deepEqual(creationsFrom('mcp__tripo__tripo_download', { task_id: A }, queued(A)), [])
  assert.deepEqual(creationsFrom('mcp__meshy__meshy_text_to_3d', {}, queued(A)), [])
  // The bridge lists one result per call, in order; JSON text anywhere is read.
  const calls = JSON.stringify([
    { name: 'mcp__tripo__tripo_balance', arguments: {} },
    { name: 'mcp__tripo__tripo_rig', arguments: JSON.stringify({ task_id: B }) }
  ])
  assert.deepEqual(creationsFrom('tool_call', { calls }, JSON.stringify({ results: [{ balance: 100 }, queued(A)] })), [
    { task_id: A, tool: 'tripo_rig', args: { task_id: B } }
  ])
  assert.deepEqual(creationsFrom('tool_call', { name: 'mcp__tripo__tripo_texture', arguments: { task_id: B } }, queued(A)), [
    { task_id: A, tool: 'tripo_texture', args: { task_id: B } }
  ])
  assert.deepEqual(creationsFrom('tool_call', null, queued(A)), [])
})

function chatHost(accepts = () => true) {
  const host = {
    sent: [],
    opened: [],
    composer: {
      submit(id, text) {
        host.sent.push([id, text])
        return accepts(id)
      }
    },
    async openSession(id) {
      host.opened.push(id)
    }
  }
  return host
}

test('a card sends to the chat whose transcript shows it; an older Desktop to the composer in use', async () => {
  const host = chatHost()
  assert.equal(await cardChat(host, 's-1').submit('Rig it'), true)
  assert.equal(await cardChat(host, undefined).submit('Rig it'), true)
  assert.deepEqual(host.sent, [['s-1', 'Rig it'], [null, 'Rig it']])
  assert.equal(await cardChat({}, 's-1').submit('Rig it'), false, 'a Desktop without the composer API')
  const throws = { composer: { submit: () => { throw new Error('no composer') } } }
  assert.equal(await cardChat(throws, 's-1').submit('Rig it'), false)
})

test('the gallery sends to the chat that made the task, opening it until its composer takes the text', async () => {
  const waits = []
  const wait = async ms => void waits.push(ms)
  const made = async () => 's-1'

  let host = chatHost()
  assert.equal(await recordedChat(host, made, wait).submit('Rig it'), true, 'that chat is on screen')
  assert.deepEqual([host.sent, host.opened], [[['s-1', 'Rig it']], []])

  let tries = 0
  host = chatHost(() => ++tries > 3)
  assert.equal(await recordedChat(host, made, wait).submit('Rig it'), true, 'opened, then its composer mounts')
  assert.deepEqual([host.opened, waits], [['s-1'], [OPEN_RETRY_MS, OPEN_RETRY_MS]])

  waits.length = 0
  host = chatHost(() => false)
  assert.equal(await recordedChat(host, made, wait).submit('Rig it'), false, 'its composer never mounts')
  assert.equal(host.sent.length, 1 + OPEN_RETRIES)
  assert.equal(waits.length, OPEN_RETRIES)

  for (const resolve of [async () => null, async () => { throw new Error('offline') }]) {
    host = chatHost()
    assert.equal(await recordedChat(host, resolve, wait).submit('Rig it'), true)
    assert.deepEqual([host.sent, host.opened], [[[null, 'Rig it']], []], 'no recorded chat: the composer in use')
  }
  host = chatHost()
  delete host.openSession
  assert.equal(await recordedChat(host, made, wait).submit('Rig it'), true)
  assert.deepEqual(host.sent, [[null, 'Rig it']], 'a Desktop that cannot open chats: the composer in use')

  host = chatHost(() => false)
  host.openSession = async () => { throw new Error('deleted chat') }
  assert.equal(await recordedChat(host, made, wait).submit('Rig it'), false)
  let asked = 0
  const noComposer = { async openSession() { throw new Error('must not open') } }
  assert.equal(await recordedChat(noComposer, async () => (++asked, 's-1'), wait).submit('Rig it'), false)
  assert.equal(asked, 0, 'a Desktop without the composer API opens nothing')
})

test('the gallery search and filter, and the row for a task the list does not have yet', () => {
  const [C] = ids(1)
  const row = (task_id, type, prompt, kind) => ({ task_id, type, kind, prompt, thumbnail: null, has_model: kind !== 'image', path: null, preview_path: null })
  const rows = [row(A, 'text_to_model', 'A red Fox', 'model'), row(B, 'generate_image', 'a blue fox', 'image'), row(C, 'animate_rig', null)]
  const shown = (filter, query) => visibleRows(rows, filter, query).map(r => r.task_id)
  assert.deepEqual(shown('all', ''), [A, B, C])
  assert.deepEqual(shown('image', ''), [B])
  assert.deepEqual(shown('model', ''), [A, C], 'a row from a backend without kind is a model')
  assert.deepEqual(shown('all', '  FOX red '), [A], 'every word, any case')
  assert.deepEqual(shown('all', 'rig'), [C], 'the type is searched')
  assert.deepEqual(shown('all', B.slice(0, 8)), [B], 'and the task id')
  assert.deepEqual(shown('image', 'red'), [])

  const image = rowFromTask({ task: B, type: 'generate_image', prompt: 'a blue fox', credits: 5, thumbnail: 'https://x/y.png', has_model: false, path: null })
  assert.deepEqual([image.task_id, kindOf(image), image.credits, image.thumbnail], [B, 'image', 5, 'https://x/y.png'])
  assert.equal(kindOf(rowFromTask({ task: A, type: 'text_to_model', prompt: null, thumbnail: null, has_model: true, path: '/m.glb' })), 'model')
})
