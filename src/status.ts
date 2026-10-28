/**
 * The credit balance and the Settings ▸ Plugins ▸ Tripo values, both read from the backend's `GET /status`, and
 * which profile/connection `ctx.rest` reaches. Pure (no SDK, no React) so the node tests drive it with a fake `rest`.
 *
 * Adapted from Nous Research's Meshy plugin (hermes-official-plugins, MIT, Copyright (c) 2025 Nous Research).
 */

export interface TripoSettings {
  show_credits: boolean
  inline_viewer: boolean
  gallery_limit: number
}

/** Mirrors plugin.json's config_schema defaults until the backend answers. */
export const DEFAULT_SETTINGS: TripoSettings = { show_credits: true, inline_viewer: true, gallery_limit: 24 }

export interface Balance {
  configured: boolean
  balance?: number
  frozen?: number
  key_env?: string
  error?: string
  error_code?: 'api_error' | 'key_rejected' | 'not_found' | 'offline'
  settings?: Partial<TripoSettings>
}

/** The chip's word for a balance: credits, or why there are none. */
export function balanceLabel(balance: Balance): string {
  if (!balance.configured) {
    return 'no key'
  }
  if (balance.error) {
    return balance.error_code === 'key_rejected' ? 'key rejected' : balance.error_code === 'offline' ? 'offline' : 'unavailable'
  }
  return `${(balance.balance ?? 0).toLocaleString('en-US')} cr`
}

export interface AtomLike<T> {
  get: () => T
  subscribe?: (fn: (value: T) => void) => () => void
}

/** `host.state` on newer Desktops; older ones have none and keep one fixed backend. */
export interface ScopeState {
  profile?: AtomLike<string>
  connectionId?: AtomLike<null | string>
}

const read = <T>(atom: AtomLike<T> | undefined): T | undefined => {
  try {
    return typeof atom?.get === 'function' ? atom.get() : undefined
  } catch {
    return undefined
  }
}

const profileName = (p: unknown) => String(p ?? '').trim() || 'default'

/** One string per (connection, profile): equal keys mean `ctx.rest` still reaches the same backend. */
export function scopeKey(state: ScopeState | undefined): string {
  return `${read(state?.connectionId) ?? ''}\n${profileName(read(state?.profile))}`
}

/** True when an event is tagged with another profile/connection than the one `ctx.rest` reaches now: its tasks
 *  belong to another key. An untagged event (older Desktop, primary path) belongs to the one in front. */
export function isForeign(origin: { profile?: string; connectionId?: string } | undefined, state: ScopeState | undefined): boolean {
  const profile = read(state?.profile)
  const connection = read(state?.connectionId)
  return Boolean(
    (origin?.profile && profile !== undefined && profileName(origin.profile) !== profileName(profile)) ||
      (origin?.connectionId && connection && origin.connectionId !== connection)
  )
}

/** Calls `onChange` once per real profile/connection switch (not on subscribe, not on a repeated value). */
export function watchScope(state: ScopeState | undefined, onChange: (key: string) => void): () => void {
  if (!state) {
    return () => undefined
  }
  let last = scopeKey(state)
  const check = () => {
    const key = scopeKey(state)
    if (key !== last) {
      last = key
      onChange(key)
    }
  }
  const unsubscribe: Array<() => void> = []
  for (const atom of [state.profile, state.connectionId]) {
    if (typeof atom?.subscribe === 'function') {
      try {
        unsubscribe.push(atom.subscribe(check))
      } catch {
        // an atom that cannot be observed: that half of the scope stays fixed
      }
    }
  }
  return () => unsubscribe.forEach(fn => fn())
}

type StatusRest = <T>(path: string, opts?: { timeoutMs?: number }) => Promise<T>

export interface StatusStore {
  balance: () => Balance | null
  settings: () => TripoSettings
  onBalance: (fn: (b: Balance | null) => void) => () => void
  onSettings: (fn: (s: TripoSettings) => void) => () => void
  /** Re-read /status (after a Tripo tool call, a finished task, a settings save). */
  refresh: () => Promise<void>
  /** The profile/connection changed: drop the old values, then refresh. */
  rescope: () => Promise<void>
  dispose: () => void
}

export function createStatusStore(rest: StatusRest, state?: ScopeState): StatusStore {
  let balance: Balance | null = null
  let settings: TripoSettings = DEFAULT_SETTINGS
  // `scope` drops replies from before a switch; `issued`/`applied` keep an older reply from overwriting a newer one.
  let scope = 0
  let issued = 0
  let applied = 0
  const balanceListeners = new Set<(b: Balance | null) => void>()
  const settingsListeners = new Set<(s: TripoSettings) => void>()

  const refresh = () => {
    const mine = scope
    const request = ++issued
    return rest<Balance>('status', { timeoutMs: 20_000 })
      .then(b => {
        if (mine !== scope || request < applied) {
          return
        }
        applied = request
        balance = b
        balanceListeners.forEach(fn => fn(balance))
        if (b.settings) {
          settings = { ...DEFAULT_SETTINGS, ...b.settings }
          settingsListeners.forEach(fn => fn(settings))
        }
      })
      .catch(() => undefined) // backend not mounted yet (plugin just enabled): keep the last value
  }

  const rescope = () => {
    scope += 1
    // The old profile's credits and preferences are wrong for the new one: show none until its own /status answers.
    balance = null
    settings = DEFAULT_SETTINGS
    balanceListeners.forEach(fn => fn(balance))
    settingsListeners.forEach(fn => fn(settings))
    return refresh()
  }
  const stopWatching = watchScope(state, () => void rescope())

  return {
    balance: () => balance,
    settings: () => settings,
    onBalance(fn) {
      balanceListeners.add(fn)
      return () => {
        balanceListeners.delete(fn)
      }
    },
    onSettings(fn) {
      settingsListeners.add(fn)
      return () => {
        settingsListeners.delete(fn)
      }
    },
    refresh,
    rescope,
    dispose() {
      stopWatching()
      scope += 1
      balanceListeners.clear()
      settingsListeners.clear()
    }
  }
}
