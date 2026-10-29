/**
 * Which tool call made which Tripo task. Tripo's own record keeps the prompt and the request but not the chat that
 * asked for it, so Desktop posts each creating call (from its tool.complete event, with the event's session id) to
 * the backend's /provenance; the gallery shows it as "Made from" and its Open chat goes back to that chat. Pure (no
 * SDK) so the node tests drive it.
 *
 * Adapted from Nous Research's Meshy plugin (hermes-official-plugins, MIT, Copyright (c) 2025 Nous Research).
 */

import { taskStatuses } from './active.ts'

const PREFIX = 'mcp__tripo__'
/** Every tool that creates a task: all but the six read-only ones, tripo_download and tripo_upload_image. */
const CREATE_TOOLS = new Set([
  'tripo_text_to_3d', 'tripo_image_to_3d', 'tripo_multiview_to_3d', 'tripo_import_model', 'tripo_image_to_splat',
  'tripo_generate_image', 'tripo_image_to_multiview', 'tripo_edit_multiview', 'tripo_texture', 'tripo_rig_check',
  'tripo_rig', 'tripo_animate', 'tripo_convert', 'tripo_decimate', 'tripo_smart_uv', 'tripo_segment',
  'tripo_mesh_complete', 'tripo_mesh_edit', 'tripo_smart_segment'
])

export interface Creation {
  task_id: string
  tool: string
  args: Record<string, unknown>
}

const parsed = (value: unknown): unknown => {
  if (typeof value !== 'string') {
    return value
  }
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

const record = (value: unknown): Record<string, unknown> => {
  const v = parsed(value)
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

const createTool = (name: unknown) => {
  const bare = typeof name === 'string' && name.startsWith(PREFIX) ? name.slice(PREFIX.length) : ''
  return CREATE_TOOLS.has(bare) ? bare : null
}

/** The task a create call's result names (`{task_id, status: "queued"}`); none for a dry run or an error. */
const createdTask = (result: unknown): null | string => [...taskStatuses(result).keys()][0] ?? null

/** Every Tripo task this tool call created: a direct `mcp__tripo__*` call, or each call a `tool_call` bridge ran
 *  (its result lists one entry per call, in order). */
export function creationsFrom(name: unknown, args: unknown, result: unknown): Creation[] {
  const direct = createTool(name)
  if (direct) {
    const id = createdTask(result)
    return id ? [{ task_id: id, tool: direct, args: record(args) }] : []
  }
  if (name !== 'tool_call') {
    return []
  }
  const a = record(args)
  const calls = parsed(a.calls ?? (a.name !== undefined ? [a] : []))
  const reply = parsed(result)
  const listed = reply && typeof reply === 'object' ? (reply as { results?: unknown }).results : undefined
  const results = Array.isArray(listed) ? listed : [reply]
  const out: Creation[] = []
  ;(Array.isArray(calls) ? calls : [calls]).forEach((call, i) => {
    const c = record(call)
    const tool = createTool(c.name)
    const id = tool ? createdTask(results[i]) : null
    if (tool && id) {
      out.push({ task_id: id, tool, args: record(c.arguments) })
    }
  })
  return out
}
