/**
 * React surfaces over the three.js stage: the inline transcript card, the recent-generations workspace and the
 * status-bar chips. Every byte comes from the plugin's own backend (`ctx.rest`): the renderer cannot read the
 * backend machine's files and never holds the API key.
 *
 * Adapted from Nous Research's Meshy plugin (hermes-official-plugins, MIT, Copyright (c) 2025 Nous Research).
 */

import type { PluginContext } from '@hermes/plugin-sdk'
import { Button, Codicon } from '@hermes/plugin-sdk'
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react'

import type { ActiveTask, ProgressState } from './active.ts'
import { createStage, cssHex, dataUrlToBuffer, type ModelStats, type Stage } from './stage.ts'
import { type Balance, balanceLabel } from './status.ts'
import { TaskCard } from './task-card.tsx'

export type Rest = PluginContext['rest']

export interface FilePayload {
  name: string
  bytes: number
  dataUrl: string
}

// Inline styles with Desktop's theme variables: no injected <style> tag, and every surface follows the theme.
export const V = {
  viewer: { position: 'relative', width: '100%', borderRadius: 8, overflow: 'hidden', background: 'var(--ui-bg-secondary, #1b1d22)' },
  stage: { position: 'absolute', inset: 0 },
  overlay: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 16, textAlign: 'center', color: 'var(--ui-text-secondary)', fontSize: 13, pointerEvents: 'none' },
  error: { color: 'var(--ui-red, #e5484d)' },
  toolbar: { position: 'absolute', top: 6, right: 6, display: 'flex', alignItems: 'center', gap: 2, padding: 2, borderRadius: 6, background: 'rgba(17, 18, 20, 0.55)', color: '#e8e8ea' },
  toolOn: { color: 'var(--ui-accent)' },
  select: { maxWidth: 130, padding: '2px 4px', borderRadius: 4, border: 0, background: 'transparent', color: 'inherit', fontSize: 12 },
  stats: { position: 'absolute', left: 6, bottom: 6, padding: '2px 6px', borderRadius: 4, fontSize: 11, color: '#e8e8ea', background: 'rgba(17, 18, 20, 0.62)', fontVariantNumeric: 'tabular-nums', pointerEvents: 'none' },
  card: { border: '1px solid var(--ui-stroke-secondary)', borderRadius: 10, padding: 8, margin: '6px 0', maxWidth: 640 },
  cardHead: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 13, color: 'var(--ui-text-secondary)' },
  cardTitle: { fontWeight: 600, color: 'var(--ui-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  spacer: { flex: 1 },
  sub: { fontSize: 11, color: 'var(--ui-text-tertiary)' },
  poster: { width: '100%', height: 160, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 8, border: '1px dashed var(--ui-stroke-secondary)', background: 'transparent', backgroundSize: 'cover', backgroundPosition: 'center', color: 'var(--ui-text-secondary)', cursor: 'pointer', fontSize: 13 },
  posterLabel: { padding: '2px 8px', borderRadius: 6, background: 'rgba(0,0,0,.55)', color: '#fff' },
  line: { fontSize: 13, color: 'var(--ui-text-secondary)', padding: '4px 2px' },
  run: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 2px' },
  runThumb: { width: 72, height: 72, objectFit: 'cover', borderRadius: 6, flexShrink: 0 },
  image: { width: '100%', maxHeight: 320, objectFit: 'contain', borderRadius: 8 },
  bar: { height: 6, borderRadius: 3, background: 'var(--ui-bg-tertiary, rgba(127,127,127,.2))', overflow: 'hidden', marginTop: 4 },
  barFill: { height: '100%', background: 'var(--ui-accent)', transition: 'width .4s ease' },
  gallery: { display: 'flex', height: '100%', minHeight: 0 },
  list: { width: 280, flexShrink: 0, display: 'flex', flexDirection: 'column', overflowY: 'auto', borderRight: '1px solid var(--ui-stroke-secondary)', padding: 6 },
  listHead: { display: 'flex', alignItems: 'center', gap: 4, padding: '2px 4px 6px', fontWeight: 600, fontSize: 13 },
  hint: { padding: 6, fontSize: 12, color: 'var(--ui-text-tertiary)' },
  item: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: 6, border: 0, borderRadius: 6, background: 'transparent', color: 'var(--ui-text-primary)', textAlign: 'left', cursor: 'pointer', fontSize: 13 },
  itemOn: { background: 'var(--ui-row-active-background, rgba(127,127,127,.15))' },
  itemText: { display: 'flex', flexDirection: 'column', minWidth: 0, gap: 1 },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' },
  thumb: { width: 40, height: 40, objectFit: 'cover', borderRadius: 4, flexShrink: 0, background: 'var(--ui-bg-secondary)' },
  main: { flex: 1, minWidth: 0, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 },
  empty: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--ui-text-tertiary)', fontSize: 13 },
  chip: { display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap', flexShrink: 0, border: 0, background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer', padding: '0 4px' },
  track: { display: 'inline-block', flexShrink: 0, width: 42, height: 4, borderRadius: 2, background: 'rgba(127,127,127,.3)', overflow: 'hidden' },
  fill: { display: 'block', height: '100%', borderRadius: 2, background: 'var(--ui-accent)', transition: 'width .6s ease' }
} satisfies Record<string, CSSProperties>

/** `ctx.rest` rejects with `"<status>: <body>"`; show the backend's `detail` sentence, not raw JSON. */
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const match = /"detail"\s*:\s*"([^"]+)"/.exec(raw)
  return match ? match[1].charAt(0).toUpperCase() + match[1].slice(1) : raw
}

export const readFile = (rest: Rest, path: string) => rest<FilePayload>(`file?path=${encodeURIComponent(path)}`, { timeoutMs: 120_000 })

/** The `preview.png` tripo_download saves beside the model. */
export const previewBeside = (path: string) => path.replace(/[^\\/]*$/, 'preview.png')

/** `text_to_model` → "Text to model". */
export const typeLabel = (type: string) => {
  const words = type.replace(/_/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Tripo task'
}

/** Tripo's `created_at` (epoch seconds or milliseconds, or an ISO date) as a short local date. */
export function dateLabel(value: unknown): string {
  const ms = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(ms) ? new Date(ms).toLocaleDateString() : ''
}

const fmtCount = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`)

/** An image from a result link (fresh from the backend, valid for minutes) or a file on the backend machine. */
export function Thumb({ rest, url, path, style, alt = '' }: { rest: Rest; url?: null | string; path?: null | string; style: CSSProperties; alt?: string }) {
  const [src, setSrc] = useState<null | string>(null)
  useEffect(() => {
    let live = true
    setSrc(null)
    if (path) {
      readFile(rest, path)
        .then(f => live && setSrc(f.dataUrl))
        .catch(() => undefined) // no preview beside the model: the card shows none
    }
    return () => {
      live = false
    }
  }, [rest, path])
  const shown = src ?? url
  return shown ? <img alt={alt} referrerPolicy="no-referrer" src={shown} style={style} /> : null
}

export function ModelViewer({ rest, path, height, autoRotate = false }: { rest: Rest; path: string; height: number | string; autoRotate?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Stage | null>(null)
  const [state, setState] = useState<{ phase: 'error' | 'loading' | 'ready'; message?: string }>({ phase: 'loading' })
  const [stats, setStats] = useState<ModelStats | null>(null)
  const [file, setFile] = useState('')
  const [spin, setSpin] = useState(autoRotate)
  const [wire, setWire] = useState(false)
  const [clip, setClip] = useState(0)
  const [playing, setPlaying] = useState(true)

  useEffect(() => {
    const el = hostRef.current
    if (!el) {
      return
    }
    let stage: Stage
    try {
      stage = createStage(el, cssHex(getComputedStyle(el.parentElement ?? el).backgroundColor))
    } catch {
      setState({ phase: 'error', message: 'This window has no WebGL, so the 3D preview cannot run. Open the file from its folder instead.' })
      return
    }
    stageRef.current = stage
    stage.setAutoRotate(spin)
    let live = true
    setState({ phase: 'loading' })
    setStats(null)
    setClip(0)
    setPlaying(true)
    readFile(rest, path)
      .then(payload => {
        if (!live) return undefined
        setFile(payload.name)
        return stage.load(dataUrlToBuffer(payload.dataUrl), payload.name || path)
      })
      .then(s => {
        if (live && s) {
          setStats(s)
          setState({ phase: 'ready' })
        }
      })
      .catch((err: unknown) => {
        if (live) setState({ phase: 'error', message: errorText(err) })
      })
    return () => {
      live = false
      stageRef.current = null
      stage.dispose()
    }
  }, [rest, path])

  useEffect(() => stageRef.current?.setAutoRotate(spin), [spin])
  useEffect(() => stageRef.current?.setWireframe(wire), [wire, stats])
  const clips = stats?.animations ?? []

  const toggle = (on: boolean, set: (v: boolean) => void, icon: string, label: string) => (
    <Button aria-label={label} aria-pressed={on} onClick={() => set(!on)} size="icon" style={on ? V.toolOn : undefined} title={label} variant="ghost">
      <Codicon name={icon} />
    </Button>
  )

  return (
    <div data-tripo-phase={state.phase} style={{ ...V.viewer, height }}>
      <div ref={hostRef} style={V.stage} />
      {state.phase === 'loading' && (
        <div style={V.overlay}>
          <Codicon name="loading" spinning /> Loading the model…
        </div>
      )}
      {state.phase === 'error' && (
        <div style={{ ...V.overlay, ...V.error }}>
          <Codicon name="error" /> {state.message}
        </div>
      )}
      {state.phase === 'ready' && (
        <div style={V.toolbar}>
          {clips.length > 0 && (
            <Button
              aria-label={playing ? 'Pause animation' : 'Play animation'}
              onClick={() => {
                stageRef.current?.setPlaying(!playing)
                setPlaying(!playing)
              }}
              size="icon"
              title={playing ? 'Pause animation' : 'Play animation'}
              variant="ghost"
            >
              <Codicon name={playing ? 'debug-pause' : 'play'} />
            </Button>
          )}
          {clips.length > 1 && (
            <select
              aria-label="Animation clip"
              onChange={e => {
                const index = Number(e.currentTarget.value)
                stageRef.current?.playClip(index)
                setClip(index)
                setPlaying(true)
              }}
              style={V.select}
              value={clip}
            >
              {clips.map((name, i) => (
                <option key={`${i}-${name}`} value={i}>
                  {name}
                </option>
              ))}
            </select>
          )}
          {toggle(spin, setSpin, 'sync', 'Auto-rotate')}
          {toggle(wire, setWire, 'symbol-structure', 'Wireframe')}
          <Button aria-label="Reset view" onClick={() => stageRef.current?.resetView()} size="icon" title="Reset view" variant="ghost">
            <Codicon name="screen-normal" />
          </Button>
        </div>
      )}
      {stats && (
        <div style={V.stats}>
          {file ? `${file} · ` : ''}
          {fmtCount(stats.triangles)} tris · {fmtCount(stats.vertices)} verts
          {clips.length ? ` · ${clips.length} clip${clips.length === 1 ? '' : 's'}` : ''}
        </div>
      )}
    </div>
  )
}

/** A model file the user opens with one click: the viewer (and its WebGL context) only exists once asked for. */
export function ModelPoster({ rest, path, streaming }: { rest: Rest; path: string; streaming: boolean }) {
  const [live, setLive] = useState(false)
  if (live) {
    return <ModelViewer height={320} path={path} rest={rest} />
  }
  return (
    <button disabled={streaming} onClick={() => setLive(true)} style={V.poster} type="button">
      <Thumb path={previewBeside(path)} rest={rest} style={{ ...V.image, maxHeight: 100, width: 'auto' }} />
      <span style={V.posterLabel}>
        <Codicon name="play-circle" /> {streaming ? 'Waiting for the reply to finish…' : 'View in 3D'}
      </span>
    </button>
  )
}

/** `::tripo-model{path="/abs/model.glb" task="…" title="…"}`, or `{task="…"}` for a task still running. */
export function TranscriptCard({ rest, attrs, streaming }: { rest: Rest; attrs: Readonly<Record<string, string>>; streaming: boolean }) {
  const path = (attrs.path || '').trim()
  const task = (attrs.task || '').trim()
  if (!path && task) {
    return <TaskCard rest={rest} streaming={streaming} task={task} title={attrs.title} />
  }
  if (!path) {
    return <div style={{ ...V.card, ...V.error }}>Tripo model: give a task="…" or path="…"</div>
  }
  const title = attrs.title || path.split(/[\\/]/).pop() || 'Tripo model'
  return (
    <div data-tripo-card style={V.card}>
      <div style={V.cardHead}>
        <Codicon name="symbol-misc" />
        <span style={V.cardTitle}>{title}</span>
        <span style={V.spacer} />
        {task && <span style={V.sub}>{task.slice(0, 8)}</span>}
      </div>
      <ModelPoster path={path} rest={rest} streaming={streaming} />
    </div>
  )
}

interface ModelRow {
  task_id: string
  type: string
  prompt: null | string
  created_at?: null | number | string
  credits?: null | number
  thumbnail: null | string
  has_model: boolean
  path: null | string
  preview_path: null | string
}

interface ModelsReply {
  configured: boolean
  models: ModelRow[]
  error: null | string
}

/** The workspace tab: recent Tripo models (the account's, plus the ones on the Hermes machine) beside a viewer. */
export function RecentGenerations({ rest, onOpenSettings }: { rest: Rest; onOpenSettings: () => void }) {
  const [reply, setReply] = useState<ModelsReply | null>(null)
  const [loadError, setLoadError] = useState<null | string>(null)
  const [selected, setSelected] = useState<null | string>(null)
  const [saves, setSaves] = useState<Record<string, { path?: string; busy?: boolean; error?: string }>>({})

  const load = useCallback(() => {
    setLoadError(null)
    rest<ModelsReply>('models', { timeoutMs: 60_000 })
      .then(setReply)
      .catch((err: unknown) => setLoadError(errorText(err)))
  }, [rest])
  useEffect(load, [load])

  const pick = (row: ModelRow) => {
    setSelected(row.task_id)
    const save = saves[row.task_id]
    if (row.path || save?.path || save?.busy) {
      return
    }
    // Put the model in the plugin's folder first (free: Tripo made it already; reused when it is there).
    const id = row.task_id
    setSaves(s => ({ ...s, [id]: { busy: true } }))
    rest<{ path: string }>('save', { method: 'POST', body: { task: id }, timeoutMs: 180_000 })
      .then(r => setSaves(s => ({ ...s, [id]: { path: r.path } })))
      .catch((err: unknown) => setSaves(s => ({ ...s, [id]: { error: `Could not download the model: ${errorText(err)}` } })))
  }

  const rows = reply?.models ?? []
  const row = rows.find(r => r.task_id === selected)
  const save = row ? saves[row.task_id] : undefined
  const path = row ? row.path || save?.path : undefined

  let main
  if (!row) {
    main = (
      <div style={V.empty}>
        <Codicon name="symbol-misc" size={28} />
        {reply && !reply.configured && !rows.length ? (
          <>
            <span>Add your Tripo API key to see your generations.</span>
            <Button onClick={onOpenSettings} size="sm" variant="outline">
              Open Tripo settings
            </Button>
          </>
        ) : (
          <span>Pick a model to view it in 3D.</span>
        )}
      </div>
    )
  } else if (path) {
    main = <ModelViewer autoRotate height="100%" key={path} path={path} rest={rest} />
  } else {
    main = (
      <div style={V.empty}>
        {save?.busy ? (
          <>
            <Codicon name="loading" spinning /> Downloading the model…
          </>
        ) : (
          <span style={V.error}>{save?.error ?? 'This task has no model the viewer can open.'}</span>
        )}
      </div>
    )
  }

  return (
    <div data-tripo-gallery style={V.gallery}>
      <div style={V.list}>
        <div style={V.listHead}>
          <span style={V.spacer}>Recent generations</span>
          <Button aria-label="Refresh" onClick={load} size="icon" title="Refresh" variant="ghost">
            <Codicon name="refresh" />
          </Button>
          <Button aria-label="Tripo settings" onClick={onOpenSettings} size="icon" title="Tripo settings" variant="ghost">
            <Codicon name="settings-gear" />
          </Button>
        </div>
        {!reply && !loadError && <div style={V.hint}>Loading…</div>}
        {loadError && <div style={{ ...V.hint, ...V.error }}>{loadError}</div>}
        {reply?.error && <div style={V.hint}>Tripo: {reply.error}. Showing the models on this computer.</div>}
        {reply && !rows.length && reply.configured && !reply.error && <div style={V.hint}>No Tripo models yet.</div>}
        {rows.map(r => (
          <button key={r.task_id} onClick={() => pick(r)} style={{ ...V.item, ...(r.task_id === selected ? V.itemOn : {}) }} title={r.prompt ?? r.task_id} type="button">
            <Thumb path={r.thumbnail ? null : r.preview_path} rest={rest} style={V.thumb} url={r.thumbnail} />
            <span style={V.itemText}>
              <span style={V.ellipsis}>{r.prompt || typeLabel(r.type)}</span>
              <span style={{ ...V.sub, ...V.ellipsis }}>
                {[typeLabel(r.type), dateLabel(r.created_at), typeof r.credits === 'number' ? `${r.credits} cr` : '', r.path || saves[r.task_id]?.path ? 'saved' : '']
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
          </button>
        ))}
      </div>
      <div style={V.main}>{main}</div>
    </div>
  )
}

export function BalanceChip({ balance, onOpen }: { balance: Balance | null; onOpen: () => void }) {
  if (!balance) {
    return null
  }
  const frozen = balance.frozen ? `, ${balance.frozen.toLocaleString('en-US')} held for running tasks` : ''
  return (
    <button
      data-tripo-chip
      onClick={onOpen}
      style={V.chip}
      title={balance.error ? `Tripo: ${balance.error}` : balance.configured ? `Tripo credits${frozen}. Open recent generations` : 'Add a Tripo API key in Settings → Plugins → Tripo'}
      type="button"
    >
      <Codicon name="symbol-misc" />
      <span>Tripo {balanceLabel(balance)}</span>
    </button>
  )
}

const taskLine = (t: ActiveTask) => (t.status === 'queued' && !t.progress ? 'queued' : `${t.progress}% · ${t.status}`)

/** Busy chip: "Tripo 42% · running" with a thin bar; the tooltip lists every task it follows. */
export function ProgressChip({ state, onOpen }: { state: ProgressState; onOpen: () => void }) {
  const top = state.tasks[0]
  if (!top) {
    return null
  }
  const more = state.tasks.length > 1 ? ` +${state.tasks.length - 1}` : ''
  return (
    <button
      data-tripo-progress={top.progress}
      onClick={onOpen}
      style={V.chip}
      title={state.tasks.map(t => `${typeLabel(t.type)} ${taskLine(t)} — ${t.prompt || t.task_id}`).join('\n')}
      type="button"
    >
      <Codicon name="loading" spinning />
      <span>
        Tripo {taskLine(top)}
        {more}
      </span>
      <span style={V.track}>
        <span style={{ ...V.fill, width: `${Math.max(0, Math.min(100, top.progress))}%` }} />
      </span>
    </button>
  )
}
