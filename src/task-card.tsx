/**
 * A card given only a Tripo task id (`::tripo-model{task="…"}`), posted right after a create: it shows Tripo's
 * progress while the task runs and the preview once it is done, so the agent can reply at once instead of waiting.
 * The model is saved (free) into the plugin's own folder only when the user opens it.
 *
 * Adapted from Nous Research's Meshy plugin (hermes-official-plugins, MIT, Copyright (c) 2025 Nous Research).
 */

import { Button, Codicon } from '@hermes/plugin-sdk'
import { useCallback, useEffect, useRef, useState } from 'react'

import { createTaskPoller, type PollState, RUNNING } from './active.ts'
import { errorText, ModelViewer, previewBeside, type Rest, Thumb, typeLabel, V } from './views.tsx'

interface TaskInfo {
  task: string
  status: string
  progress: number
  type: string
  prompt: null | string
  thumbnail: null | string
  credits: null | number
  seconds_left: null | number
  has_model: boolean
  path: null | string
  error: null | string
}

function useTask(rest: Rest, task: string): PollState<TaskInfo> & { retry: () => void } {
  const [state, setState] = useState<PollState<TaskInfo>>({ info: null, error: null, stopped: false })
  const poller = useRef<null | { retry: () => void }>(null)
  useEffect(() => {
    setState({ info: null, error: null, stopped: false })
    const p = createTaskPoller<TaskInfo>(() => rest<TaskInfo>(`task?task=${encodeURIComponent(task)}`, { timeoutMs: 20_000 }), setState, errorText)
    poller.current = p
    return () => {
      p.dispose()
      if (poller.current === p) poller.current = null
    }
  }, [rest, task])
  const retry = useCallback(() => poller.current?.retry(), [])
  return { ...state, retry }
}

export function TaskCard({ rest, task, title, streaming }: { rest: Rest; task: string; title?: string; streaming: boolean }) {
  const { info, error, stopped, retry } = useTask(rest, task)
  const [path, setPath] = useState<null | string>(null)
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<null | string>(null)
  const busy = useRef(false) // state lags a render: two clicks in one tick would both pass an `opening` check
  const name = title || info?.prompt || `Tripo task ${task.slice(0, 8)}`
  const done = info?.status === 'success'

  const open = async () => {
    if (busy.current) {
      return
    }
    busy.current = true
    setOpening(true)
    setOpenError(null)
    try {
      const saved = info?.path ? { path: info.path } : await rest<{ path: string }>('save', { method: 'POST', body: { task }, timeoutMs: 180_000 })
      setPath(saved.path)
    } catch (e) {
      setOpenError(`Could not download the model: ${errorText(e)}. Click to try again.`)
    } finally {
      busy.current = false
      setOpening(false)
    }
  }

  let body
  if (stopped && error) {
    body = (
      <div style={{ ...V.line, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ ...V.error, flex: 1 }}>Tripo: {error}</span>
        <Button onClick={retry} size="sm" variant="outline">
          <Codicon name="refresh" /> Retry
        </Button>
      </div>
    )
  } else if (!info) {
    body = <div style={V.line}>{error ? `Tripo: ${error}` : 'Checking the Tripo task…'}</div>
  } else if (info.error) {
    body = (
      <div style={{ ...V.line, ...V.error }}>
        Tripo task {info.status}: {info.error}
      </div>
    )
  } else if (RUNNING.includes(info.status)) {
    const pct = Math.max(0, Math.min(100, info.progress))
    const left = typeof info.seconds_left === 'number' && info.seconds_left > 0 ? ` · about ${Math.ceil(info.seconds_left)} s left` : ''
    body = (
      <div data-tripo-task-progress style={V.run}>
        <div style={{ flex: 1 }}>
          <div style={V.line}>
            {info.status === 'queued' && !pct ? 'Queued at Tripo' : `Tripo ${pct}%`}
            {left}
          </div>
          <div style={V.bar}>
            <div style={{ ...V.barFill, width: `${pct}%` }} />
          </div>
        </div>
      </div>
    )
  } else if (!done) {
    body = <div style={V.line}>Tripo task {info.status || 'state unknown'}.</div>
  } else if (path && !opening) {
    body = <ModelViewer height={320} path={path} rest={rest} />
  } else if (info.has_model || info.path) {
    body = (
      <button disabled={streaming || opening} onClick={() => void open()} style={V.poster} type="button">
        <Thumb path={!info.thumbnail && info.path ? previewBeside(info.path) : null} rest={rest} style={{ ...V.image, maxHeight: 100, width: 'auto' }} url={info.thumbnail} />
        <span style={{ ...V.posterLabel, ...(openError ? V.error : {}) }}>
          <Codicon name="play-circle" /> {opening ? 'Downloading the model…' : streaming ? 'Waiting for the reply to finish…' : (openError ?? 'View in 3D')}
        </span>
      </button>
    )
  } else {
    body = info.thumbnail ? <Thumb alt={name} rest={rest} style={V.image} url={info.thumbnail} /> : <div style={V.line}>Done. This task has no 3D model to show.</div>
  }

  return (
    <div data-tripo-task-card={stopped ? 'stopped' : (info?.status ?? 'loading')} style={V.card}>
      <div style={V.cardHead}>
        <Codicon name="symbol-misc" />
        <span style={V.cardTitle}>{name}</span>
        <span style={V.spacer} />
        <span style={V.sub}>
          {[info?.type ? typeLabel(info.type) : '', done && typeof info?.credits === 'number' ? `${info.credits} cr` : ''].filter(Boolean).join(' · ')}
        </span>
      </div>
      {body}
    </div>
  )
}
