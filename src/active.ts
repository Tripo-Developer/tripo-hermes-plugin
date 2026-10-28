/**
 * Which Tripo tasks are running, and when to ask the backend about them. Pure (no SDK import) so the node tests
 * drive it with fake events, a fake clock and a counting `rest`.
 *
 * The status-bar tracker follows a task from the Tripo tool result that names it queued or running (a create call
 * returns `{task_id, status: "queued"}`, a status or wait call the current status) until GET /active reports it
 * finished, a later tool result does, Tripo still does not know it after MISSING_GRACE_MS, or an hour has passed.
 * One batch read per poll (Tripo's tasks/list), nothing while no task runs. A transcript card polls its own task
 * through `createTaskPoller`.
 *
 * Adapted from Nous Research's Meshy plugin (hermes-official-plugins, MIT, Copyright (c) 2025 Nous Research).
 */

export const RUNNING = ['queued', 'running']
export const POLL_MS = 4000
export const CARD_POLL_MS = 3000
export const MAX_BACKOFF_MS = 60_000
export const MAX_FAILURES = 5
/** The backend reads at most this many tasks per poll; the newest ones win. */
export const MAX_WATCHED = 8
export const MAX_WATCH_MS = 60 * 60 * 1000
export const MISSING_GRACE_MS = 60_000

const PREFIX = 'mcp__tripo__'
const TASK_ID = /^[0-9a-f][0-9a-f-]{15,63}$/

const isTripoName = (name: unknown) => typeof name === 'string' && name.startsWith(PREFIX)

/** The tool names a `tool_call` bridge ran: `args.calls` (an array, one object or JSON text) or `{name}`. */
function bridgedNames(args: unknown): unknown[] {
  if (!args || typeof args !== 'object') {
    return []
  }
  const a = args as { calls?: unknown; name?: unknown }
  let calls: unknown = a.calls ?? (a.name !== undefined ? [a] : [])
  if (typeof calls === 'string') {
    try {
      calls = JSON.parse(calls)
    } catch {
      return []
    }
  }
  return (Array.isArray(calls) ? calls : [calls]).map(c => (c && typeof c === 'object' ? (c as { name?: unknown }).name : undefined))
}

/** True for a direct `mcp__tripo__*` call, or a `tool_call` bridge (Hermes' tool search) that ran one. */
export function isTripoCall(name: unknown, args: unknown): boolean {
  return isTripoName(name) || (name === 'tool_call' && bridgedNames(args).some(isTripoName))
}

/** Every `{task_id, status}` a tool result names, at any depth. Hermes hands MCP results over as JSON text inside
 *  JSON (`{"result": "{\"task_id\": …}"}`), so strings that look like JSON are parsed too. Bounded. */
export function taskStatuses(result: unknown): Map<string, string> {
  const found = new Map<string, string>()
  const walk = (value: unknown, depth: number) => {
    if (depth > 8 || found.size >= 50) {
      return
    }
    if (typeof value === 'string') {
      const head = value.trimStart()[0]
      if ((head === '{' || head === '[' || head === '"') && value.length <= 2_000_000) {
        try {
          const parsed: unknown = JSON.parse(value)
          if (parsed !== value) {
            walk(parsed, depth + 1)
          }
        } catch {
          // plain text that starts with a bracket
        }
      }
      return
    }
    if (!value || typeof value !== 'object') {
      return
    }
    const v = value as { task_id?: unknown; status?: unknown }
    if (typeof v.task_id === 'string' && TASK_ID.test(v.task_id) && typeof v.status === 'string') {
      found.set(v.task_id, v.status.toLowerCase())
    }
    for (const item of Array.isArray(value) ? value : Object.values(value)) {
      walk(item, depth + 1)
    }
  }
  walk(result, 0)
  return found
}

/** HTTP status a `ctx.rest` rejection carries, or null. Electron's IPC bridge keeps only the message,
 *  `"<status>: <body>"`, possibly wrapped as `"Error invoking remote method '…': Error: <status>: <body>"`. */
export function httpStatus(err: unknown): null | number {
  if (err && typeof err === 'object') {
    for (const key of ['statusCode', 'status'] as const) {
      const value = (err as Record<string, unknown>)[key]
      if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) {
        return value
      }
    }
  }
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const match = /^(?:Error invoking remote method '[^']*':\s*)?(?:Error:\s*)?([1-5]\d\d):/.exec(message)
  return match ? Number(match[1]) : null
}

/** A refusal that asking again cannot fix: any 4xx except 408 and 429. */
export const isPermanent = (status: null | number) => status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429

export const backoffMs = (failures: number, base = POLL_MS) => Math.min(MAX_BACKOFF_MS, base * 2 ** Math.max(0, failures - 1))

export interface Clock {
  now: () => number
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export interface ActiveTask {
  task_id: string
  type: string
  status: string
  progress: number
  prompt: string
  created_at?: null | number | string
  seconds_left?: null | number
}

export interface ProgressState {
  /** Followed tasks Tripo still reports queued or running, newest first. */
  tasks: ActiveTask[]
}

interface ActiveReply {
  configured?: boolean
  tasks?: ActiveTask[]
  done?: string[]
  missing?: string[]
}

export interface EventLike {
  payload?: unknown
  profile?: string
  connectionId?: string
}

export interface TrackerCtx {
  onEvent: (type: string, fn: (e: EventLike) => void) => () => void
  rest: <T>(path: string, init?: { timeoutMs?: number }) => Promise<T>
}

export interface TrackerOptions {
  clock?: Clock
  /** True for an event from another profile/connection than the one `ctx.rest` reaches (status.ts isForeign). */
  foreign?: (e: EventLike) => boolean
}

/** `onFinished` runs when a followed task stops running (the balance changed: credits are frozen at creation,
 *  charged or refunded at the end). */
export function createProgressTracker(
  ctx: TrackerCtx,
  onChange: (s: ProgressState) => void,
  onFinished: () => void,
  { clock = realClock, foreign = () => false }: TrackerOptions = {}
) {
  let state: ProgressState = { tasks: [] }
  const watched = new Map<string, number>() // task id -> when it was first seen running
  let timer: unknown
  let inFlight = false
  let failures = 0
  let disposed = false
  let generation = 0 // bumped on a profile/connection switch: a reply read through the old one is dropped

  const publish = (tasks: ActiveTask[]) => {
    state = { tasks }
    onChange(state)
  }

  const schedule = (ms: number) => {
    if (disposed || inFlight || timer !== undefined || watched.size === 0) {
      return
    }
    timer = clock.setTimeout(poll, ms)
  }

  const rearm = (ms: number) => {
    if (timer !== undefined) {
      clock.clearTimeout(timer)
      timer = undefined
    }
    failures = 0
    schedule(ms)
  }

  function poll() {
    timer = undefined
    for (const [id, since] of watched) {
      if (clock.now() - since > MAX_WATCH_MS) {
        watched.delete(id)
      }
    }
    const ids = [...watched.keys()].slice(-MAX_WATCHED)
    if (!ids.length) {
      if (state.tasks.length) {
        publish([])
      }
      return
    }
    inFlight = true
    const at = generation
    let next = POLL_MS
    ctx
      .rest<ActiveReply>(`active?tasks=${encodeURIComponent(ids.join(','))}`, { timeoutMs: 15_000 })
      .then(
        res => {
          if (disposed || at !== generation) return
          failures = 0
          if (res.configured === false) {
            watched.clear()
            publish([])
            return
          }
          let finished = false
          for (const id of Array.isArray(res.done) ? res.done : []) {
            finished = watched.delete(id) || finished
          }
          for (const id of Array.isArray(res.missing) ? res.missing : []) {
            const since = watched.get(id)
            if (since !== undefined && clock.now() - since >= MISSING_GRACE_MS) {
              watched.delete(id)
            }
          }
          publish((Array.isArray(res.tasks) ? res.tasks : []).filter(t => watched.has(t.task_id)))
          if (finished) onFinished()
        },
        (err: unknown) => {
          if (disposed || at !== generation) return
          failures += 1
          // A refused request (no route on an old backend, a bad id) or a long outage: stop until the next Tripo call.
          if (isPermanent(httpStatus(err)) || failures >= MAX_FAILURES) {
            watched.clear()
            publish([])
            return
          }
          next = backoffMs(failures + 1)
        }
      )
      .finally(() => {
        inFlight = false
        schedule(next)
      })
  }

  const off = ctx.onEvent('tool.complete', e => {
    const p = (e.payload ?? {}) as { name?: unknown; args?: unknown; result?: unknown }
    if (!isTripoCall(p.name, p.args) || foreign(e)) {
      return
    }
    let finished = false
    for (const [id, status] of taskStatuses(p.result)) {
      if (RUNNING.includes(status)) {
        if (!watched.has(id)) watched.set(id, clock.now())
      } else if (watched.delete(id)) {
        finished = true
      }
    }
    if (finished) {
      publish(state.tasks.filter(t => watched.has(t.task_id)))
      onFinished()
    }
    rearm(1000)
  })

  return {
    get: () => state,
    /** Followed task ids (tests, debugging). */
    watching: () => [...watched.keys()],
    /** The profile/connection in front changed: its tasks belong to another key, so forget them. */
    rescope() {
      generation += 1
      watched.clear()
      rearm(0)
      if (state.tasks.length) {
        publish([])
      }
    },
    dispose() {
      disposed = true
      if (timer !== undefined) {
        clock.clearTimeout(timer)
      }
      off()
    }
  }
}

export interface PollState<T> {
  info: null | T
  error: null | string
  /** Polling stopped on an error; the card offers Retry. */
  stopped: boolean
}

/** Polls one task for a transcript card: every CARD_POLL_MS while it is queued or running, until any other status.
 *  A permanent refusal stops at once (Retry asks again); failures that may pass back off up to a minute. */
export function createTaskPoller<T extends { status: string }>(
  read: () => Promise<T>,
  onState: (state: PollState<T>) => void,
  describe: (err: unknown) => string,
  clock: Clock = realClock
): { retry: () => void; dispose: () => void } {
  let live = true
  let timer: unknown
  let inFlight = false
  let failures = 0
  let state: PollState<T> = { info: null, error: null, stopped: false }

  const publish = (next: PollState<T>) => {
    state = next
    onState(state)
  }

  function tick() {
    timer = undefined
    inFlight = true
    read().then(
      r => {
        inFlight = false
        if (!live) return
        failures = 0
        publish({ info: r, error: null, stopped: false })
        if (RUNNING.includes(r.status)) timer = clock.setTimeout(tick, CARD_POLL_MS)
      },
      (err: unknown) => {
        inFlight = false
        if (!live) return
        failures += 1
        const stop = isPermanent(httpStatus(err))
        publish({ info: state.info, error: describe(err), stopped: stop })
        if (!stop) timer = clock.setTimeout(tick, backoffMs(failures, CARD_POLL_MS))
      }
    )
  }

  tick()
  return {
    retry() {
      if (!live || inFlight || timer !== undefined) return
      publish({ ...state, stopped: false })
      tick()
    },
    dispose() {
      live = false
      if (timer !== undefined) clock.clearTimeout(timer)
      timer = undefined
    }
  }
}
