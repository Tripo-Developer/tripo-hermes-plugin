/**
 * The gallery's list decisions: which rows the search box and the All / Images / Models filter leave, and the row for
 * a task the list does not have (a card's Open right after the task finished, before Tripo's usage lists it). Pure
 * (no SDK, no React) so the node tests drive it.
 *
 * Adapted from Nous Research's Meshy plugin (hermes-official-plugins, MIT, Copyright (c) 2025 Nous Research).
 */

export type Kind = 'image' | 'model'
export type Filter = 'all' | Kind

/** One row of GET /models: a finished task of the account, merged with its copy in the plugin's folder. */
export interface GalleryRow {
  task_id: string
  type: string
  /** Absent from older backends: a model. */
  kind?: Kind
  prompt: null | string
  created_at?: null | number | string
  credits?: null | number
  thumbnail: null | string
  has_model: boolean
  path: null | string
  preview_path: null | string
}

/** GET /storage: what the plugin's tripo-out/ folder holds. */
export interface StorageStatus {
  bytes: number
  files: number
  directory: string
}

// The image task types (the backend's _IMAGES).
const IMAGE_TYPES = new Set(['text_to_image', 'generate_image', 'generate_multiview_image', 'edit_multiview_image'])

export const kindOfType = (type: string): Kind => (IMAGE_TYPES.has(type) ? 'image' : 'model')

export const kindOf = (row: GalleryRow): Kind => (row.kind === 'image' ? 'image' : 'model')

/** The rows of the filter's kind whose prompt, type or task id contains every word of the query. */
export function visibleRows(rows: readonly GalleryRow[], filter: Filter, query: string): GalleryRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return rows.filter(row => {
    if (filter !== 'all' && kindOf(row) !== filter) {
      return false
    }
    const text = `${row.prompt ?? ''} ${row.type.replace(/_/g, ' ')} ${row.task_id}`.toLowerCase()
    return words.every(word => text.includes(word))
  })
}

/** GET /task's answer for a finished task, as a gallery row. */
export function rowFromTask(task: {
  task: string
  type: string
  prompt: null | string
  credits?: null | number
  thumbnail: null | string
  has_model: boolean
  path: null | string
}): GalleryRow {
  return {
    task_id: task.task,
    type: task.type,
    kind: kindOfType(task.type),
    prompt: task.prompt,
    credits: task.credits,
    thumbnail: task.thumbnail,
    has_model: task.has_model,
    path: task.path,
    preview_path: null
  }
}
