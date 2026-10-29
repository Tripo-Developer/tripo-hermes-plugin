/**
 * Tripo for Hermes Desktop: see what the Tripo tools make without leaving the app.
 *
 * - `::tripo-model{path="/abs/model.glb" task="…"}` renders an inline 3D card; `::tripo-model{task="…"}` follows a
 *   running task and opens its model when asked. The tripo-3d skill tells the agent to emit them. A finished task's
 *   card has Next (follow-ups with their credits, sent as a chat message), Download and Open.
 * - "Tripo: recent generations" (⌘K, a click on the status-bar chip, or a card's Open) opens the Tripo 3D gallery:
 *   recent Tripo images and models with search, filters, a viewer and what made each one.
 * - Each Tripo tool call that creates a task is recorded with its chat (the backend's /provenance), so the gallery
 *   can say what made a task and go back to that chat.
 * - The status-bar chip shows the credit balance, refreshed after every Tripo tool call; while a Tripo task runs it
 *   shows the task's progress instead.
 * - Desktops with the tool-media renderer seam also open a model file a Tripo tool saved, attached with a `MEDIA:`
 *   line, in the same viewer instead of the generic file row.
 *
 * Bytes and API calls go through this plugin's own backend (`dashboard/plugin_api.py`) via `ctx.rest`; the renderer
 * never reads files or holds the API key.
 */

import type { HermesPlugin, PaletteContribution, PluginContribution, ToolMediaRendererProps, TranscriptDirectiveProps } from '@hermes/plugin-sdk'
// A namespace import: Desktops older than the tool-media seam have no TOOL_MEDIA_RENDERER_AREA export, and a named
// import of a missing export would fail to load.
import * as sdk from '@hermes/plugin-sdk'
import { host, PALETTE_AREA, STATUSBAR_AREAS, TRANSCRIPT_DIRECTIVE_AREA } from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'

import { createProgressTracker, isTripoCall, type ProgressState } from './active.ts'
import { isModelFile } from './parse-model.ts'
import { creationsFrom } from './provenance.ts'
import { type Balance, createStatusStore, isForeign, scopeKey, type TripoSettings, watchScope } from './status.ts'
import { BalanceChip, Gallery, type Os, ProgressChip, TranscriptCard } from './views.tsx'

const WORKSPACE_ID = 'tripo-recent'
// Settings ▸ Plugins ▸ Tripo is generated from plugin.json's config_schema.
const SETTINGS_HREF = '/settings?tab=plugins&agent=tripo'

const plugin: HermesPlugin = {
  id: 'tripo',
  name: 'Tripo 3D',
  description: 'View Tripo 3D models inline in chat, follow running Tripo tasks, browse recent generations and see your credit balance.',
  register(ctx) {
    // Credits and preferences belong to the profile ctx.rest is routed to: the store re-reads them on a switch.
    const status = createStatusStore(ctx.rest, host.state)
    const refreshBalance = () => void status.refresh()
    const useSettings = () => {
      const [value, setValue] = useState<TripoSettings>(status.settings())
      useEffect(() => status.onSettings(setValue), [])
      return value
    }
    const foreign = (origin: { profile?: string; connectionId?: string }) => isForeign(origin, host.state)

    // A backend path names a file on the backend's machine: the file manager can show it only when that is this one.
    const os: Os = {
      reveal(path) {
        const connection = host.state?.connectionId?.get()
        if (connection && connection !== 'local') {
          host.notify({ kind: 'info', message: `This file is on the Hermes host, not on this computer: ${path}` })
          return
        }
        const failed = () => host.notify({ kind: 'warning', message: `The file manager could not show it: ${path}` })
        void Promise.resolve(ctx.os?.revealPath(path)).then(shown => shown || failed(), failed)
      },
      copy(text, what) {
        const write = async () => (ctx.os?.writeClipboard ? ctx.os.writeClipboard(text) : (await navigator.clipboard.writeText(text), true))
        write().then(
          ok => host.notify(ok ? { kind: 'success', message: `${what} copied` } : { kind: 'error', message: `Could not copy the ${what.toLowerCase()}` }),
          () => host.notify({ kind: 'error', message: `Could not copy the ${what.toLowerCase()}` })
        )
      }
    }

    const progressListeners = new Set<(s: ProgressState) => void>()
    const progress = createProgressTracker(ctx, s => progressListeners.forEach(fn => fn(s)), refreshBalance, { foreign })

    // A card's Open names the task to select; `at` makes a second Open of the same task select it again.
    let focus: null | { task: string; at: number } = null
    const focusListeners = new Set<(f: null | { task: string; at: number }) => void>()

    // A profile or connection switch moves ctx.rest to another backend and key: reload an open recent-generations tab
    // (the task a card asked for belongs to the old profile).
    let scope = scopeKey(host.state)
    const scopeListeners = new Set<(key: string) => void>()
    ctx.onDispose(
      watchScope(host.state, key => {
        scope = key
        focus = null
        focusListeners.forEach(fn => fn(null))
        scopeListeners.forEach(fn => fn(key))
        progress.rescope()
      })
    )

    function RecentHost() {
      const [key, setKey] = useState(scope)
      const [wanted, setWanted] = useState(focus)
      const prefs = useSettings()
      useEffect(() => {
        scopeListeners.add(setKey)
        focusListeners.add(setWanted)
        return () => {
          scopeListeners.delete(setKey)
          focusListeners.delete(setWanted)
        }
      }, [])
      return <Gallery autoRotate={prefs.auto_rotate} focus={wanted} key={key} onOpenSettings={() => host.navigate(SETTINGS_HREF)} os={os} rest={ctx.rest} />
    }

    let closeWorkspace: (() => void) | null = null
    const openRecent = (task?: string) => {
      if (typeof host.openWorkspace !== 'function') {
        host.notify({ kind: 'error', message: 'Update Hermes Desktop to open recent Tripo generations.' })
        return
      }
      focus = task ? { task, at: Date.now() } : null
      if (focus) {
        focusListeners.forEach(fn => fn(focus))
      }
      closeWorkspace = host.openWorkspace(WORKSPACE_ID, {
        dock: { pane: 'workspace', pos: 'right' },
        title: 'Tripo 3D',
        minWidth: '28rem',
        onClose: () => {
          closeWorkspace = null
        },
        render: () => <RecentHost />
      })
    }

    function Chip() {
      const prefs = useSettings()
      const [balance, setBalance] = useState<Balance | null>(status.balance())
      const [state, setState] = useState<ProgressState>(progress.get())
      useEffect(() => {
        const stopBalance = status.onBalance(setBalance)
        progressListeners.add(setState)
        return () => {
          stopBalance()
          progressListeners.delete(setState)
        }
      }, [])
      if (state.tasks.length) {
        return <ProgressChip onOpen={() => openRecent()} state={state} />
      }
      return prefs.show_credits ? <BalanceChip balance={balance} onOpen={() => openRecent()} /> : null
    }

    function DirectiveCard({ attrs, source, streaming, sessionId }: TranscriptDirectiveProps) {
      const prefs = useSettings()
      return prefs.inline_viewer ? (
        <TranscriptCard attrs={attrs} onOpen={openRecent} os={os} rest={ctx.rest} sessionId={sessionId} streaming={streaming} />
      ) : (
        <p>{source}</p>
      )
    }

    function ToolMediaModel({ media }: { media: ToolMediaRendererProps }) {
      const prefs = useSettings()
      if (!prefs.inline_viewer || !isModelFile(media.file.name || media.file.path)) {
        return <>{media.fallback}</>
      }
      return (
        <TranscriptCard
          attrs={{ path: media.file.path, title: media.file.name }}
          onOpen={openRecent}
          os={os}
          rest={ctx.rest}
          sessionId={media.sessionId}
          streaming={false}
        />
      )
    }

    ctx.onEvent('tool.complete', event => {
      const payload = (event.payload ?? {}) as { name?: unknown; args?: unknown; result?: unknown }
      // Tripo tools sit behind tool search: most calls arrive as `tool_call` wrapping mcp__tripo__*.
      if (!isTripoCall(payload.name, payload.args) || foreign(event)) {
        return
      }
      refreshBalance()
      // The backend keeps a record only for a chat of its own profile; a refusal changes nothing here.
      if (event.session_id) {
        for (const made of creationsFrom(payload.name, payload.args, payload.result)) {
          ctx.rest('provenance', { method: 'POST', body: { ...made, session_id: event.session_id }, timeoutMs: 15_000 }).catch(() => undefined)
        }
      }
    })
    // Saved from Settings ▸ Plugins ▸ Tripo (a new API key, a toggle): re-read and apply live.
    ctx.onEvent('plugin.tripo.settings.changed', () => refreshBalance())
    ctx.onDispose(() => {
      closeWorkspace?.()
      progress.dispose()
      progressListeners.clear()
      scopeListeners.clear()
      focusListeners.clear()
      status.dispose()
    })
    refreshBalance()

    const contributions: PluginContribution[] = [
      {
        id: 'model-directive',
        area: TRANSCRIPT_DIRECTIVE_AREA,
        data: {
          name: 'tripo-model',
          render: (props: TranscriptDirectiveProps) => <DirectiveCard {...props} />
        }
      },
      {
        id: 'balance',
        area: STATUSBAR_AREAS.right,
        order: 80,
        render: () => <Chip />
      },
      {
        id: 'open-recent',
        area: PALETTE_AREA,
        data: {
          id: 'tripo.recent',
          label: 'Tripo: recent generations',
          keywords: ['tripo', '3d', 'model', 'image', 'glb', 'fbx', 'gallery', 'assets', 'viewer', 'recent', 'credits'],
          run: () => openRecent()
        } satisfies PaletteContribution
      },
      {
        id: 'open-settings',
        area: PALETTE_AREA,
        data: {
          id: 'tripo.settings',
          label: 'Tripo: settings',
          keywords: ['tripo', 'settings', 'api key', 'credits', 'preferences'],
          run: () => host.navigate(SETTINGS_HREF)
        } satisfies PaletteContribution
      }
    ]
    // Newer Desktops only. The host serves the claim just for tools this package registered: its MCP server's.
    if (typeof sdk.TOOL_MEDIA_RENDERER_AREA === 'string') {
      contributions.push({
        id: 'model-media',
        area: sdk.TOOL_MEDIA_RENDERER_AREA,
        data: {
          tools: ['mcp__tripo__*'],
          render: (props: ToolMediaRendererProps) => <ToolMediaModel media={props} />
        }
      })
    }
    ctx.registerMany(contributions)
  }
}

export default plugin
