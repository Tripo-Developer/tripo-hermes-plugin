/**
 * A card for a Tripo task (`::tripo-model{task="…"}`), often posted right after a create: it shows Tripo's progress
 * while the task runs and the preview once it is done, so the agent can reply at once instead of waiting. The model
 * is saved (free) into the plugin's own folder only when the user opens it; with `path` (the directive's, after a
 * download) it is already on disk. Once done, the header offers the Next and Download menus and Open.
 *
 * Adapted from Nous Research's Meshy plugin (hermes-official-plugins, MIT, Copyright (c) 2025 Nous Research).
 */

import { Button, Codicon } from '@hermes/plugin-sdk'
import { useCallback, useEffect, useRef, useState } from 'react'

import { createTaskPoller, type PollState, RUNNING, stageWord } from './active.ts'
import type { ChatSender } from './chat.ts'
import { kindOfType } from './gallery.ts'
import { ActionMenu, errorText, FormatMenu, ModelViewer, type Os, previewBeside, type Rest, Thumb, V } from './views.tsx'

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
  /** A conversion that only changed the file format: the source task, whose model the card shows instead. */
  view_task?: null | string
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

export function TaskCard({
  rest,
  os,
  task,
  path: savedPath,
  title,
  streaming,
  chat,
  onOpen
}: {
  rest: Rest
  os: Os
  task: string
  /** The model already on disk (the directive's `path`): opened without a download, even with Tripo unreachable. */
  path?: string
  title?: string
  streaming: boolean
  /** Sends Next and Convert requests to the chat this card is in (chat.ts cardChat). */
  chat: ChatSender
  onOpen: (task: string) => void
}) {
  const { info, error, stopped, retry } = useTask(rest, task)
  const [path, setPath] = useState<null | string>(null)
  const [fromSource, setFromSource] = useState(false)
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<null | string>(null)
  const busy = useRef(false) // state lags a render: two clicks in one tick would both pass an `opening` check
  const name = title || info?.prompt || `Tripo task ${task.slice(0, 8)}`
  const done = info?.status === 'success' || Boolean(savedPath)
  const local = savedPath || info?.path

  const open = async () => {
    if (busy.current) {
      return
    }
    busy.current = true
    setOpening(true)
    setOpenError(null)
    try {
      const save = (id: string) => rest<{ path: string }>('save', { method: 'POST', body: { task: id }, timeoutMs: 180_000 })
      const source = info?.view_task ? await save(info.view_task).catch(() => null) : null
      const saved = source ?? (local ? { path: local } : await save(task))
      setFromSource(Boolean(source))
      setPath(saved.path)
    } catch (e) {
      setOpenError(`Could not download the model: ${errorText(e)}. Click to try again.`)
    } finally {
      busy.current = false
      setOpening(false)
    }
  }

  let body
  if (done) {
    if (path && !opening) {
      body = (
        <>
          <ModelViewer height={320} os={os} path={path} rest={rest} />
          {fromSource && <div style={{ ...V.line, ...V.sub }}>Shown from the source model: this conversion only changed the file format.</div>}
        </>
      )
    } else if (local || info?.has_model || info?.view_task) {
      body = (
        <button disabled={streaming || opening} onClick={() => void open()} style={V.poster} type="button">
          <Thumb path={!info?.thumbnail && local ? previewBeside(local) : null} rest={rest} style={{ ...V.image, maxHeight: 100, width: 'auto' }} url={info?.thumbnail} />
          <span style={{ ...V.posterLabel, ...(openError ? V.error : {}) }}>
            <Codicon name="play-circle" /> {opening ? 'Downloading the model…' : streaming ? 'Waiting for the reply to finish…' : (openError ?? 'View in 3D')}
          </span>
        </button>
      )
    } else {
      body = info?.thumbnail ? <Thumb alt={name} rest={rest} style={V.image} url={info.thumbnail} /> : <div style={V.line}>Done. This task has no 3D model to show.</div>
    }
  } else if (stopped && error) {
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
            {info.status === 'queued' && !pct ? 'Queued at Tripo' : `Tripo ${pct}% · ${stageWord(info.type)}`}
            {left}
          </div>
          <div style={V.bar}>
            <div style={{ ...V.barFill, width: `${pct}%` }} />
          </div>
        </div>
      </div>
    )
  } else {
    body = <div style={V.line}>Tripo task {info.status || 'state unknown'}.</div>
  }

  return (
    <div data-tripo-task-card={stopped ? 'stopped' : (info?.status ?? 'loading')} style={V.card}>
      <div style={V.cardHead}>
        <Codicon name="symbol-misc" />
        <span style={V.cardTitle}>{name}</span>
        {typeof info?.credits === 'number' && info.credits > 0 && <span style={V.sub}>{info.credits} cr</span>}
        <span style={V.spacer} />
        {done && !streaming && <ActionMenu chat={chat} rest={rest} task={task} what={kindOfType(info?.type ?? '')} />}
        {done && !streaming && <FormatMenu chat={chat} os={os} rest={rest} task={task} />}
        {done && (
          <Button onClick={() => onOpen(task)} size="sm" variant="ghost">
            <Codicon name="link-external" /> Open
          </Button>
        )}
      </div>
      {body}
    </div>
  )
}
