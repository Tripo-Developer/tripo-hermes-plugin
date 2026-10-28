/**
 * Tripo for Hermes Desktop: see what the Tripo tools make without leaving the app.
 *
 * - `::tripo-model{path="/abs/model.glb" task="…"}` renders an inline 3D card; `::tripo-model{task="…"}` follows a
 *   running task and opens its model when asked. The tripo-3d skill tells the agent to emit them.
 * - "Tripo: recent generations" (⌘K, or a click on the status-bar chip) opens a workspace tab listing recent Tripo
 *   models beside a viewer.
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
import { type Balance, createStatusStore, isForeign, scopeKey, type TripoSettings, watchScope } from './status.ts'
import { BalanceChip, ProgressChip, RecentGenerations, TranscriptCard } from './views.tsx'

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

    const progressListeners = new Set<(s: ProgressState) => void>()
    const progress = createProgressTracker(ctx, s => progressListeners.forEach(fn => fn(s)), refreshBalance, { foreign })

    // A profile or connection switch moves ctx.rest to another backend and key: reload an open recent-generations tab.
    let scope = scopeKey(host.state)
    const scopeListeners = new Set<(key: string) => void>()
    ctx.onDispose(
      watchScope(host.state, key => {
        scope = key
        scopeListeners.forEach(fn => fn(key))
        progress.rescope()
      })
    )

    function RecentHost() {
      const [key, setKey] = useState(scope)
      useEffect(() => {
        scopeListeners.add(setKey)
        return () => {
          scopeListeners.delete(setKey)
        }
      }, [])
      return <RecentGenerations key={key} onOpenSettings={() => host.navigate(SETTINGS_HREF)} rest={ctx.rest} />
    }

    let closeWorkspace: (() => void) | null = null
    const openRecent = () => {
      if (typeof host.openWorkspace !== 'function') {
        host.notify({ kind: 'error', message: 'Update Hermes Desktop to open recent Tripo generations.' })
        return
      }
      closeWorkspace = host.openWorkspace(WORKSPACE_ID, {
        dock: { pane: 'workspace', pos: 'right' },
        title: 'Tripo · recent generations',
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
        return <ProgressChip onOpen={openRecent} state={state} />
      }
      return prefs.show_credits ? <BalanceChip balance={balance} onOpen={openRecent} /> : null
    }

    function DirectiveCard({ attrs, source, streaming }: TranscriptDirectiveProps) {
      const prefs = useSettings()
      return prefs.inline_viewer ? <TranscriptCard attrs={attrs} rest={ctx.rest} streaming={streaming} /> : <p>{source}</p>
    }

    function ToolMediaModel({ media }: { media: ToolMediaRendererProps }) {
      const prefs = useSettings()
      if (!prefs.inline_viewer || !isModelFile(media.file.name || media.file.path)) {
        return <>{media.fallback}</>
      }
      return <TranscriptCard attrs={{ path: media.file.path, title: media.file.name }} rest={ctx.rest} streaming={false} />
    }

    ctx.onEvent('tool.complete', event => {
      const payload = (event.payload ?? {}) as { name?: unknown; args?: unknown }
      // Tripo tools sit behind tool search: most calls arrive as `tool_call` wrapping mcp__tripo__*.
      if (isTripoCall(payload.name, payload.args) && !foreign(event)) {
        refreshBalance()
      }
    })
    // Saved from Settings ▸ Plugins ▸ Tripo (a new API key, a toggle): re-read and apply live.
    ctx.onEvent('plugin.tripo.settings.changed', () => refreshBalance())
    ctx.onDispose(() => {
      closeWorkspace?.()
      progress.dispose()
      progressListeners.clear()
      scopeListeners.clear()
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
          keywords: ['tripo', '3d', 'model', 'glb', 'fbx', 'gallery', 'viewer', 'recent', 'credits'],
          run: openRecent
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
