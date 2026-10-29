/**
 * React surfaces over the three.js stage: the inline transcript card and its menus, the Tripo 3D gallery workspace
 * and the status-bar chips. Every byte comes from the plugin's own backend (`ctx.rest`): the renderer cannot read the
 * backend machine's files and never holds the API key.
 *
 * Adapted from Nous Research's Meshy plugin (hermes-official-plugins, MIT, Copyright (c) 2025 Nous Research).
 */

import type { PluginContext } from '@hermes/plugin-sdk'
// A namespace import for the menu primitives: older Desktops have none, and a named import of a missing export would
// fail to load.
import * as sdk from '@hermes/plugin-sdk'
import { Button, Codicon, host } from '@hermes/plugin-sdk'
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react'

import { type ActiveTask, type ProgressState, stageWord } from './active.ts'
import { cardChat, type ChatSender, recordedChat } from './chat.ts'
import { type Filter, type GalleryRow, kindOf, rowFromTask, type StorageStatus, visibleRows } from './gallery.ts'
import { extensionOf, mtlLibOf, mtlTextures, siblingPath } from './parse-model.ts'
import { createStage, cssHex, dataUrlToBuffer, type ModelStats, type Stage } from './stage.ts'
import { type Balance, balanceLabel } from './status.ts'
import { TaskCard } from './task-card.tsx'

export type Rest = PluginContext['rest']

/** What a view asks of the computer Desktop runs on (plugin.tsx builds it from `ctx.os`). */
export interface Os {
  /** Show a file of the backend's machine in the file manager; on a remote backend, say where it is instead. */
  reveal: (path: string) => void
  /** Copy `text`; `what` names it in the notice ("Task ID"). */
  copy: (text: string, what: string) => void
}

export interface FilePayload {
  name: string
  bytes: number
  dataUrl: string
}

const { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } = sdk
/** Desktop's menu primitives; without them (older Desktops) the Next and Download menus are not shown. */
const MENU =
  DropdownMenu && DropdownMenuTrigger && DropdownMenuContent && DropdownMenuItem && DropdownMenuSeparator
    ? { Menu: DropdownMenu, Trigger: DropdownMenuTrigger, Content: DropdownMenuContent, Item: DropdownMenuItem, Separator: DropdownMenuSeparator }
    : null

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
  list: { width: 280, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRight: '1px solid var(--ui-stroke-secondary)', padding: 6 },
  listHead: { display: 'flex', alignItems: 'center', gap: 4, padding: '2px 4px 6px', fontWeight: 600, fontSize: 13 },
  listFoot: { padding: 6, marginTop: 6, borderTop: '1px solid var(--ui-stroke-secondary)', fontSize: 12, color: 'var(--ui-text-tertiary)', display: 'flex', flexDirection: 'column', gap: 4 },
  search: { width: 'calc(100% - 8px)', margin: '0 4px', padding: '4px 8px', borderRadius: 6, border: '1px solid var(--ui-stroke-secondary)', background: 'transparent', color: 'var(--ui-text-primary)', fontSize: 12 },
  section: { padding: '8px 6px 4px', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ui-text-tertiary)' },
  hint: { padding: 6, fontSize: 12, color: 'var(--ui-text-tertiary)' },
  item: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: 6, border: 0, borderRadius: 6, background: 'transparent', color: 'var(--ui-text-primary)', textAlign: 'left', cursor: 'pointer', fontSize: 13 },
  itemOn: { background: 'var(--ui-row-active-background, rgba(127,127,127,.15))' },
  itemText: { display: 'flex', flexDirection: 'column', minWidth: 0, gap: 1 },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' },
  thumb: { width: 40, height: 40, objectFit: 'cover', borderRadius: 4, flexShrink: 0, background: 'var(--ui-bg-secondary)' },
  main: { flex: 1, minWidth: 0, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 },
  mainHead: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--ui-text-secondary)', minHeight: 28 },
  taskId: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, fontSize: 12, color: 'var(--ui-text-tertiary)' },
  picture: { width: '100%', height: '100%', objectFit: 'contain', borderRadius: 8 },
  madeFrom: { display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', border: '1px solid var(--ui-stroke-secondary)', borderRadius: 8, fontSize: 12, color: 'var(--ui-text-secondary)', maxHeight: 220, overflowY: 'auto', flexShrink: 0 },
  madeHead: { display: 'flex', alignItems: 'center', gap: 6, minHeight: 24 },
  promptRow: { display: 'flex', alignItems: 'flex-start', gap: 4 },
  prompt: { flex: 1, color: 'var(--ui-text-primary)', fontSize: 13, lineHeight: 1.4, whiteSpace: 'pre-wrap', userSelect: 'text' },
  sourceImg: { width: 56, height: 56, objectFit: 'cover', borderRadius: 6, flexShrink: 0 },
  chips: { display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' },
  tag: { padding: '1px 6px', borderRadius: 4, fontSize: 11, background: 'var(--ui-bg-tertiary, rgba(127,127,127,.15))', color: 'var(--ui-text-secondary)' },
  link: { padding: '1px 6px', borderRadius: 4, fontSize: 11, border: '1px solid var(--ui-stroke-secondary)', background: 'transparent', color: 'var(--ui-text-secondary)', cursor: 'pointer' },
  empty: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--ui-text-tertiary)', fontSize: 13 },
  cost: { fontSize: 11, color: 'var(--ui-text-tertiary)', fontVariantNumeric: 'tabular-nums', marginLeft: 12, whiteSpace: 'nowrap' },
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

/** An OBJ's .mtl (the `mtllib` it names) and that file's textures, read from beside it and keyed by the names the
 *  files use. A missing one is left out: the model then draws without it. */
async function objCompanions(rest: Rest, path: string, bytes: ArrayBuffer): Promise<Record<string, string>> {
  const lib = mtlLibOf(new TextDecoder().decode(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 65_536))))
  const mtlPath = lib ? siblingPath(path, lib) : null
  if (!lib || !mtlPath) return {}
  const out: Record<string, string> = {}
  try {
    out[lib] = (await readFile(rest, mtlPath)).dataUrl
  } catch {
    return {}
  }
  for (const tex of mtlTextures(new TextDecoder().decode(dataUrlToBuffer(out[lib])))) {
    const texPath = siblingPath(path, tex)
    if (texPath) await readFile(rest, texPath).then(r => (out[tex] = r.dataUrl), () => undefined)
  }
  return out
}

/** The `preview.png` tripo_download saves beside the model. */
export const previewBeside = (path: string) => path.replace(/[^\\/]*$/, 'preview.png')

/** `text_to_model` → "Text to model". */
export const typeLabel = (type: string) => {
  const words = type.replace(/_/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Tripo task'
}

/** Tripo's `created_at` (epoch seconds or milliseconds, or an ISO date) as a short local date, or with the time. */
export function dateLabel(value: unknown, withTime = false): string {
  const ms = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(ms) ? (withTime ? new Date(ms).toLocaleString() : new Date(ms).toLocaleDateString()) : ''
}

const fmtCount = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`)
export const fmtBytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`)

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

export function ModelViewer({ rest, os, path, height, autoRotate = false }: { rest: Rest; os: Os; path: string; height: number | string; autoRotate?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Stage | null>(null)
  const [state, setState] = useState<{ phase: 'error' | 'loading' | 'ready'; message?: string }>({ phase: 'loading' })
  const [stats, setStats] = useState<ModelStats | null>(null)
  const [file, setFile] = useState<null | { name: string; bytes: number }>(null)
  const [spin, setSpin] = useState(autoRotate)
  const [wire, setWire] = useState(false)
  const [grid, setGrid] = useState(true)
  const [clip, setClip] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [loop, setLoop] = useState(true)

  useEffect(() => {
    const el = hostRef.current
    if (!el) {
      return
    }
    let stage: Stage
    try {
      stage = createStage(el, cssHex(getComputedStyle(el.parentElement ?? el).backgroundColor))
    } catch {
      setState({
        phase: 'error',
        message: 'No 3D preview in this window: WebGL is unavailable, or was switched off after a graphics error. Restart Hermes to turn it back on, or open the file from its folder.'
      })
      return
    }
    stageRef.current = stage
    // A new model gets a new stage: carry the toolbar's current view settings over to it.
    stage.setAutoRotate(spin)
    stage.setGrid(grid)
    stage.setLoop(loop)
    let live = true
    stage.onClipEnd(() => live && setPlaying(false))
    stage.onContextLost(
      () =>
        live &&
        setState({
          phase: 'error',
          message: 'The 3D preview stopped after a graphics error. Until Hermes restarts, this window may show no 3D previews; open the file from its folder instead.'
        })
    )
    setState({ phase: 'loading' })
    setStats(null)
    setClip(0)
    setPlaying(true)
    readFile(rest, path)
      .then(async payload => {
        if (!live) return undefined
        setFile({ name: payload.name, bytes: payload.bytes })
        const bytes = dataUrlToBuffer(payload.dataUrl)
        const siblings = extensionOf(payload.name || path) === 'obj' ? await objCompanions(rest, path, bytes) : {}
        return stage.load(bytes, payload.name || path, siblings)
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

  useEffect(() => setSpin(autoRotate), [autoRotate])
  useEffect(() => stageRef.current?.setAutoRotate(spin), [spin])
  useEffect(() => stageRef.current?.setWireframe(wire), [wire, stats])
  useEffect(() => stageRef.current?.setGrid(grid), [grid])
  useEffect(() => stageRef.current?.setLoop(loop), [loop])
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
          {clips.length > 0 && toggle(loop, setLoop, 'debug-restart', loop ? 'Loop (on)' : 'Loop (off: play once)')}
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
          {toggle(grid, setGrid, 'symbol-numeric', 'Grid')}
          <Button aria-label="Reset view" onClick={() => stageRef.current?.resetView()} size="icon" title="Reset view" variant="ghost">
            <Codicon name="screen-normal" />
          </Button>
          <Button aria-label="Show in folder" onClick={() => os.reveal(path)} size="icon" title="Show in folder" variant="ghost">
            <Codicon name="folder-opened" />
          </Button>
        </div>
      )}
      {stats && (
        <div style={V.stats}>
          {file ? `${file.name} · ${fmtBytes(file.bytes)} · ` : ''}
          {fmtCount(stats.triangles)} tris · {fmtCount(stats.vertices)} verts
          {clips.length ? ` · ${clips.length} clip${clips.length === 1 ? '' : 's'}` : ''}
        </div>
      )}
    </div>
  )
}

/** A model file the user opens with one click: the viewer (and its WebGL context) only exists once asked for. */
export function ModelPoster({ rest, os, path, streaming }: { rest: Rest; os: Os; path: string; streaming: boolean }) {
  const [live, setLive] = useState(false)
  if (live) {
    return <ModelViewer height={320} os={os} path={path} rest={rest} />
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

interface ActionRow {
  id: string
  label: string
  cost: number
  price: string
  choice: boolean
  affordable: boolean
  message: string
}

interface ActionsReply {
  spent: null | number
  balance: null | number
  actions: ActionRow[]
}

const ACTION_ICONS: Record<string, string> = {
  texture: 'symbol-color',
  decimate: 'type-hierarchy',
  rig_check: 'check-all',
  rig: 'person',
  segment: 'split-horizontal',
  regenerate: 'refresh',
  animate: 'play',
  make3d: 'symbol-misc'
}

const warnNoChat = (sent: boolean) => sent || host.notify({ kind: 'warning', message: 'Open a chat to send this to Hermes' })

/** "Next ▾": the follow-ups Tripo supports for this task with their credits. A pick SENDS a chat message: the agent
 *  runs the tool behind Hermes' approval prompt, so nothing here spends. */
export function ActionMenu({ rest, task, chat, what = 'model' }: { rest: Rest; task: string; chat: ChatSender; what?: 'image' | 'model' }) {
  const [data, setData] = useState<ActionsReply | null>(null)
  const [error, setError] = useState<null | string>(null)
  if (!MENU) {
    return null
  }
  const { Menu, Trigger, Content, Item, Separator } = MENU
  const load = () => {
    setError(null)
    rest<ActionsReply>(`actions?task=${encodeURIComponent(task)}`, { timeoutMs: 30_000 })
      .then(setData)
      .catch((err: unknown) => setError(errorText(err)))
  }
  return (
    <Menu onOpenChange={open => open && load()}>
      <Trigger asChild>
        <Button size="sm" variant="ghost">
          <Codicon name="sparkle" /> Next
          <Codicon name="chevron-down" size={12} />
        </Button>
      </Trigger>
      <Content align="end" style={{ minWidth: 290 }}>
        {error ? (
          <Item disabled>{error}</Item>
        ) : data === null ? (
          <Item disabled>
            <Codicon name="loading" spinning /> Checking what this {what} supports…
          </Item>
        ) : (
          <>
            {data.actions.map(row => (
              <Item
                disabled={!row.affordable}
                key={`${row.id}:${row.label}`}
                onSelect={() => void chat.submit(row.message).then(warnNoChat)}
                title={row.affordable ? row.message : `Needs ${row.cost} credits`}
              >
                <Codicon name={ACTION_ICONS[row.id] ?? 'circle-small'} />
                <span style={{ flex: 1 }}>{row.label}</span>
                <span style={V.cost}>{row.choice ? row.price.replace(' credits', ' cr') : row.cost ? `${row.cost} cr` : 'free'}</span>
              </Item>
            ))}
            {data.actions.length === 0 && <Item disabled>No follow-ups for this kind of task</Item>}
            <Separator />
            <Item disabled>
              {[
                typeof data.spent === 'number' ? `This ${what} cost ${data.spent} cr` : null,
                typeof data.balance === 'number' ? `balance ${data.balance.toLocaleString('en-US')} cr` : null
              ]
                .filter(Boolean)
                .join(' · ') || 'Credits unavailable'}
            </Item>
            <Item disabled>Sends a message; Hermes asks before any credits are spent</Item>
          </>
        )}
      </Content>
    </Menu>
  )
}

interface FormatFile {
  field: string
  name: string
  label: string
  saved: null | string
}

interface FormatsReply {
  files: FormatFile[]
  conversions: Array<{ format: string; cost: number; message: string }>
}

/** "Download ▾": the files Tripo made for this task, saved free into the plugin's folder (beside the model) and shown
 *  there; and conversions, each a new billed task, which send a chat message like the Next menu. */
export function FormatMenu({ rest, os, task, chat, onSaved }: { rest: Rest; os: Os; task: string; chat: ChatSender; onSaved?: () => void }) {
  const [data, setData] = useState<FormatsReply | null>(null)
  const [error, setError] = useState<null | string>(null)
  const [busy, setBusy] = useState<null | string>(null)
  if (!MENU) {
    return null
  }
  const { Menu, Trigger, Content, Item, Separator } = MENU
  const load = () => {
    setError(null)
    rest<FormatsReply>(`formats?task=${encodeURIComponent(task)}`, { timeoutMs: 30_000 })
      .then(setData)
      .catch((err: unknown) => setError(errorText(err)))
  }
  const pick = (file: FormatFile) => {
    if (file.saved) {
      os.reveal(file.saved)
      return
    }
    setBusy(file.name)
    rest<{ path: string }>('save', { method: 'POST', body: { task, field: file.field }, timeoutMs: 180_000 })
      .then(r => {
        setData(prev => prev && { ...prev, files: prev.files.map(f => (f.field === file.field ? { ...f, saved: r.path } : f)) })
        host.notify({ kind: 'success', message: `Saved ${file.name}` })
        os.reveal(r.path)
        onSaved?.()
      })
      .catch((err: unknown) => host.notify({ kind: 'error', message: `Tripo ${file.name}: ${errorText(err)}` }))
      .finally(() => setBusy(null))
  }
  return (
    <Menu onOpenChange={open => open && load()}>
      <Trigger asChild>
        <Button size="sm" variant="ghost">
          <Codicon name={busy ? 'loading' : 'cloud-download'} spinning={!!busy} /> {busy ? `Saving ${busy}…` : 'Download'}
          <Codicon name="chevron-down" size={12} />
        </Button>
      </Trigger>
      <Content align="end" style={{ minWidth: 260 }}>
        {error ? (
          <Item disabled>{error}</Item>
        ) : data === null ? (
          <Item disabled>
            <Codicon name="loading" spinning /> Checking the files…
          </Item>
        ) : (
          <>
            {data.files.map(file => (
              <Item disabled={busy !== null} key={file.field} onSelect={() => pick(file)} title={file.saved ?? file.name}>
                <span style={{ flex: 1 }}>{file.label}</span>
                <Codicon name={file.saved ? 'check' : 'cloud-download'} style={{ opacity: file.saved ? 1 : 0.55 }} />
              </Item>
            ))}
            {data.files.length === 0 && <Item disabled>This task has no files to download</Item>}
            {data.conversions.length > 0 && (
              <>
                <Separator />
                {data.conversions.map(row => (
                  <Item key={row.format} onSelect={() => void chat.submit(row.message).then(warnNoChat)} title={row.message}>
                    <span style={{ flex: 1 }}>Convert to {row.format}</span>
                    <span style={V.cost}>{row.cost} cr</span>
                  </Item>
                ))}
                <Item disabled>Converting creates a new task · sends a message</Item>
              </>
            )}
          </>
        )}
      </Content>
    </Menu>
  )
}

/** `::tripo-model{path="/abs/model.glb" task="…" title="…"}`, or `{task="…"}` for a task still running. */
export function TranscriptCard({
  rest,
  os,
  attrs,
  streaming,
  sessionId,
  onOpen
}: {
  rest: Rest
  os: Os
  attrs: Readonly<Record<string, string>>
  streaming: boolean
  /** The chat showing this card (directive render prop); undefined on Desktops that do not pass it. */
  sessionId?: null | string
  /** Opens the gallery with this task selected. */
  onOpen: (task: string) => void
}) {
  const path = (attrs.path || '').trim()
  const task = (attrs.task || '').trim()
  const title = attrs.title || path.split(/[\\/]/).pop() || ''
  if (task) {
    // Captured at render: a button's message goes to THIS card's chat (chat.ts).
    return (
      <TaskCard chat={cardChat(host, sessionId)} onOpen={onOpen} os={os} path={path || undefined} rest={rest} streaming={streaming} task={task} title={title || undefined} />
    )
  }
  if (!path) {
    return <div style={{ ...V.card, ...V.error }}>Tripo model: give a task="…" or path="…"</div>
  }
  return (
    <div data-tripo-card style={V.card}>
      <div style={V.cardHead}>
        <Codicon name="symbol-misc" />
        <span style={V.cardTitle}>{title || 'Tripo model'}</span>
      </div>
      <ModelPoster os={os} path={path} rest={rest} streaming={streaming} />
    </div>
  )
}

interface ModelsReply {
  configured: boolean
  models: GalleryRow[]
  error: null | string
}

interface Details {
  type: string
  tool: null | string
  model: null | string
  prompt: null | string
  image: null | string
  image_viewable: boolean
  parent: null | string
  settings: Record<string, unknown>
  credits: null | number
  created_at: null | number | string
  session_id: null | string
  recorded: boolean
  remote_error: null | string
}

/** "Made from": the prompt, source image or parent task, model, credits and chat behind the selected task. */
function MadeFrom({
  rest,
  os,
  task,
  onPick,
  onDetails
}: {
  rest: Rest
  os: Os
  task: string
  onPick: (task: string) => void
  /** Reports the chat recorded for the task, so the gallery's Next sends there. */
  onDetails: (task: string, sessionId: null | string) => void
}) {
  const [d, setD] = useState<Details | null>(null)
  const [error, setError] = useState<null | string>(null)
  useEffect(() => {
    let live = true
    setD(null)
    setError(null)
    rest<Details>(`details?task=${encodeURIComponent(task)}`, { timeoutMs: 30_000 })
      .then(r => {
        if (live) {
          setD(r)
          onDetails(task, r.session_id ?? null)
        }
      })
      .catch((err: unknown) => live && setError(errorText(err)))
    return () => {
      live = false
    }
  }, [rest, task, onDetails])

  if (error || !d) {
    return <div style={{ ...V.madeFrom, ...V.sub }}>{error ? `Couldn't load what made this task: ${error}` : 'Loading what made this task…'}</div>
  }
  const settings = Object.entries(d.settings ?? {}).filter(([, v]) => v !== '' && v !== null && v !== undefined)
  const when = dateLabel(d.created_at, true)
  return (
    <div style={V.madeFrom}>
      <div style={V.madeHead}>
        <span style={{ fontWeight: 600, color: 'var(--ui-text-primary)' }}>Made from</span>
        <span style={V.spacer} />
        {d.session_id && typeof host.openSession === 'function' && (
          <Button onClick={() => void host.openSession?.(d.session_id as string)} size="sm" variant="ghost">
            <Codicon name="comment-discussion" /> Open chat
          </Button>
        )}
      </div>
      {d.remote_error && <div style={V.sub}>Tripo's record isn't available ({d.remote_error}); showing what this Desktop recorded.</div>}
      {d.prompt ? (
        <div style={V.promptRow}>
          <div style={V.prompt}>{d.prompt}</div>
          <Button aria-label="Copy prompt" onClick={() => os.copy(d.prompt as string, 'Prompt')} size="icon" title="Copy prompt" variant="ghost">
            <Codicon name="copy" />
          </Button>
        </div>
      ) : (
        !d.image &&
        !d.parent && <div style={V.sub}>{d.recorded ? 'No prompt for this step.' : 'Made outside this Desktop, so its chat and source were not recorded.'}</div>
      )}
      {d.image && (
        <div style={V.promptRow}>
          {d.image_viewable ? <Thumb alt="Source image" path={d.image} rest={rest} style={V.sourceImg} /> : <Codicon name="file-media" />}
          <span style={{ ...V.sub, ...V.ellipsis }} title={d.image}>
            Source image: {d.image.split(/[\\/]/).pop()}
          </span>
        </div>
      )}
      <div style={V.chips}>
        {d.type && <span style={V.tag}>{typeLabel(d.type)}</span>}
        {d.model && <span style={V.tag}>{d.model}</span>}
        {settings.map(([k, v]) => (
          <span key={k} style={V.tag}>
            {k.replace(/_/g, ' ')}: {Array.isArray(v) ? v.join(', ') : String(v)}
          </span>
        ))}
        {typeof d.credits === 'number' && <span style={V.tag}>{d.credits} cr</span>}
        {when && <span style={V.tag}>{when}</span>}
        {d.parent && (
          <button onClick={() => onPick(d.parent as string)} style={V.link} title={d.parent} type="button">
            from task {d.parent.slice(0, 8)}
          </button>
        )}
      </div>
    </div>
  )
}

/** An image task's files, saved free into the plugin's folder (all views of a multiview sheet), then shown there. */
function ImageDownload({ rest, os, row, onSaved }: { rest: Rest; os: Os; row: GalleryRow; onSaved: () => void }) {
  const [busy, setBusy] = useState(false)
  if (row.path) {
    return (
      <Button onClick={() => os.reveal(row.path as string)} size="sm" variant="outline">
        <Codicon name="folder-opened" /> Show saved image
      </Button>
    )
  }
  const download = async () => {
    setBusy(true)
    try {
      const { files } = await rest<FormatsReply>(`formats?task=${encodeURIComponent(row.task_id)}`, { timeoutMs: 30_000 })
      let last: null | string = null
      for (const file of files) {
        last = file.saved ?? (await rest<{ path: string }>('save', { method: 'POST', body: { task: row.task_id, field: file.field }, timeoutMs: 180_000 })).path
      }
      if (!last) {
        throw new Error('this task has no image to save')
      }
      host.notify({ kind: 'success', message: files.length === 1 ? 'Image saved' : `${files.length} images saved` })
      os.reveal(last)
      onSaved()
    } catch (err) {
      host.notify({ kind: 'error', message: `Tripo image: ${errorText(err)}` })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button disabled={busy} onClick={() => void download()} size="sm" variant="outline">
      <Codicon name={busy ? 'loading' : 'cloud-download'} spinning={busy} /> {busy ? 'Saving…' : 'Download image'}
    </Button>
  )
}

/** The Tripo 3D workspace tab: recent Tripo images and models (the account's, plus the ones on the Hermes machine)
 *  with search and filters, beside the selected one: viewer or picture, menus, task id and what made it. */
export function Gallery({
  rest,
  os,
  autoRotate,
  focus,
  onOpenSettings
}: {
  rest: Rest
  os: Os
  autoRotate: boolean
  /** A card's Open: the task to select. */
  focus: null | { task: string; at: number }
  onOpenSettings: () => void
}) {
  const [reply, setReply] = useState<ModelsReply | null>(null)
  const [loadError, setLoadError] = useState<null | string>(null)
  const [storage, setStorage] = useState<null | StorageStatus>(null)
  const [selected, setSelected] = useState<null | string>(focus?.task ?? null)
  // A selected task the list does not have (older than the list, or finished before Tripo's usage lists it).
  const [extra, setExtra] = useState<null | GalleryRow>(null)
  const [saves, setSaves] = useState<Record<string, { path?: string; busy?: boolean; error?: string }>>({})
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  const load = useCallback(() => {
    setLoadError(null)
    rest<ModelsReply>('models', { timeoutMs: 60_000 })
      .then(setReply)
      .catch((err: unknown) => setLoadError(errorText(err)))
    rest<StorageStatus>('storage', { timeoutMs: 30_000 })
      .then(setStorage)
      .catch(() => setStorage(null))
  }, [rest])
  useEffect(load, [load])

  const listed = reply?.models ?? []
  const rows = extra && !listed.some(r => r.task_id === extra.task_id) ? [extra, ...listed] : listed

  // A model opens from the plugin's folder: put it there first (free: Tripo made it already; reused when it is there).
  const ensureSaved = (row: GalleryRow) => {
    const save = saves[row.task_id]
    if (kindOf(row) === 'image' || row.path || !row.has_model || save?.path || save?.busy) {
      return
    }
    const id = row.task_id
    setSaves(s => ({ ...s, [id]: { busy: true } }))
    rest<{ path: string }>('save', { method: 'POST', body: { task: id }, timeoutMs: 180_000 })
      .then(r => setSaves(s => ({ ...s, [id]: { path: r.path } })))
      .catch((err: unknown) => setSaves(s => ({ ...s, [id]: { error: `Could not download the model: ${errorText(err)}` } })))
  }

  const select = (task: string) => {
    setSelected(task)
    const found = rows.find(r => r.task_id === task)
    if (found) {
      ensureSaved(found)
      return
    }
    const drop = () => setSelected(s => (s === task ? null : s))
    rest<Parameters<typeof rowFromTask>[0] & { status: string }>(`task?task=${encodeURIComponent(task)}`, { timeoutMs: 20_000 })
      .then(t => {
        if (t.status !== 'success') {
          drop()
          host.notify({ kind: 'info', message: `Tripo task ${task.slice(0, 8)} is ${t.status || 'not finished'}` })
          return
        }
        const row = rowFromTask(t)
        setExtra(row)
        ensureSaved(row)
      })
      .catch((err: unknown) => {
        drop()
        host.notify({ kind: 'error', message: `Tripo task ${task.slice(0, 8)}: ${errorText(err)}` })
      })
  }

  const handled = useRef(0)
  useEffect(() => {
    if (focus && reply && handled.current !== focus.at) {
      handled.current = focus.at
      select(focus.task)
    }
  }, [focus, reply])

  // Next sends to the chat that made the selected task ("Made from" names it), opening that chat when needed.
  const madeIn = useRef(new Map<string, null | string>())
  const noteDetails = useCallback((task: string, sessionId: null | string) => void madeIn.current.set(task, sessionId), [])
  const chat = recordedChat(host, async () => {
    if (!selected) return null
    if (!madeIn.current.has(selected)) {
      const d = await rest<Details>(`details?task=${encodeURIComponent(selected)}`, { timeoutMs: 30_000 })
      madeIn.current.set(selected, d.session_id ?? null)
    }
    return madeIn.current.get(selected) ?? null
  })

  const shown = visibleRows(rows, filter, query)
  const row = rows.find(r => r.task_id === selected)
  const save = row ? saves[row.task_id] : undefined
  const path = row ? row.path || save?.path : undefined
  const image = row ? kindOf(row) === 'image' : false

  let view
  if (!row) {
    view = (
      <div style={V.empty}>
        <Codicon name="symbol-misc" size={28} />
        {reply && !reply.configured && !rows.length ? (
          <>
            <span>Add your Tripo API key to see your generations.</span>
            <Button onClick={onOpenSettings} size="sm" variant="outline">
              Open Tripo settings
            </Button>
          </>
        ) : selected && reply ? (
          <span>Looking up task {selected.slice(0, 8)}…</span>
        ) : (
          <span>Pick an image or a model to preview.</span>
        )}
      </div>
    )
  } else if (image) {
    view = row.path || row.thumbnail ? <Thumb alt={row.prompt ?? ''} path={row.path} rest={rest} style={V.picture} url={row.thumbnail} /> : <div style={V.empty}>No picture for this task.</div>
  } else if (path) {
    view = <ModelViewer autoRotate={autoRotate} height="100%" key={path} os={os} path={path} rest={rest} />
  } else {
    view = (
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
      <aside style={V.list}>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          <div style={V.listHead}>
            <span style={V.spacer}>Tripo assets</span>
            <Button aria-label="Tripo settings" onClick={onOpenSettings} size="icon" title="Tripo settings" variant="ghost">
              <Codicon name="settings-gear" />
            </Button>
            <Button aria-label="Refresh" onClick={load} size="icon" title="Refresh" variant="ghost">
              <Codicon name="refresh" />
            </Button>
          </div>
          <input aria-label="Search prompts" onChange={e => setQuery(e.currentTarget.value)} placeholder="Search prompts…" style={V.search} type="search" value={query} />
          <div aria-label="Asset type" role="group" style={{ display: 'flex', gap: 4, padding: '6px 0' }}>
            {(['all', 'image', 'model'] as const).map(kind => (
              <Button aria-pressed={filter === kind} key={kind} onClick={() => setFilter(kind)} size="sm" variant={filter === kind ? 'outline' : 'ghost'}>
                {kind === 'all' ? 'All' : kind === 'image' ? 'Images' : 'Models'}
              </Button>
            ))}
          </div>
          {!reply && !loadError && <div style={V.hint}>Loading…</div>}
          {loadError && <div style={{ ...V.hint, ...V.error }}>{loadError}</div>}
          {reply?.error && <div style={V.hint}>Tripo: {reply.error}. Showing what is on the Hermes machine.</div>}
          {reply && !rows.length && reply.configured && !reply.error && <div style={V.hint}>No Tripo generations yet.</div>}
          {rows.length > 0 && !shown.length && <div style={V.hint}>Nothing matches.</div>}
          {shown.length > 0 && <div style={V.section}>Recent generations</div>}
          {shown.map(r => (
            <button
              key={r.task_id}
              onClick={() => select(r.task_id)}
              style={{ ...V.item, ...(r.task_id === selected ? V.itemOn : {}) }}
              title={r.prompt ? `${r.prompt}\n${r.task_id}` : r.task_id}
              type="button"
            >
              <Thumb path={r.thumbnail ? null : (r.preview_path ?? (kindOf(r) === 'image' ? r.path : null))} rest={rest} style={V.thumb} url={r.thumbnail} />
              <span style={V.itemText}>
                <span style={V.ellipsis}>{r.prompt || typeLabel(r.type)}</span>
                <span style={{ ...V.sub, ...V.ellipsis }}>
                  {[typeLabel(r.type), typeof r.credits === 'number' ? `${r.credits} credits` : '', dateLabel(r.created_at), r.path || saves[r.task_id]?.path ? 'saved' : '']
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
            </button>
          ))}
        </div>
        <div role="note" style={V.listFoot}>
          {storage && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
              <span>
                {fmtBytes(storage.bytes)} · {storage.files} local file{storage.files === 1 ? '' : 's'}
              </span>
              <Button onClick={() => os.reveal(storage.directory)} size="sm" variant="ghost">
                Show folder
              </Button>
            </div>
          )}
          <div>Save to keep results: Tripo's download links expire in about 5 minutes; saved files stay.</div>
        </div>
      </aside>
      <section style={V.main}>
        {row && (
          <>
            <div style={V.mainHead}>
              <span style={V.cardTitle} title={row.prompt ?? undefined}>
                {row.prompt || typeLabel(row.type)}
              </span>
              <span style={V.spacer} />
              <ActionMenu chat={chat} key={`a:${row.task_id}`} rest={rest} task={row.task_id} what={kindOf(row)} />
              {image ? (
                <ImageDownload key={`i:${row.task_id}`} onSaved={load} os={os} rest={rest} row={row} />
              ) : (
                <FormatMenu chat={chat} key={`f:${row.task_id}`} onSaved={load} os={os} rest={rest} task={row.task_id} />
              )}
            </div>
            <div style={V.taskId}>
              <span>Task ID</span>
              <code style={{ userSelect: 'text', overflowWrap: 'anywhere' }}>{row.task_id}</code>
              <Button aria-label="Copy task ID" onClick={() => os.copy(row.task_id, 'Task ID')} size="sm" variant="ghost">
                <Codicon name="copy" /> Copy ID
              </Button>
            </div>
          </>
        )}
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>{view}</div>
        {row && <MadeFrom key={`m:${row.task_id}`} onDetails={noteDetails} onPick={select} os={os} rest={rest} task={row.task_id} />}
      </section>
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

const taskLine = (t: ActiveTask) => (t.status === 'queued' && !t.progress ? 'queued' : `${t.progress}% · ${stageWord(t.type)}`)

/** Busy chip: "Tripo 42% · modelling" with a thin bar; the tooltip lists every task it follows. */
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
