// Minimal ambient types for the parts of `@hermes/plugin-sdk` this plugin uses (typecheck only; the host supplies
// the real module at runtime). Shapes mirror apps/desktop/src/sdk and lib/tool-media-renderers.ts.
import type { ComponentProps, CSSProperties, ReactNode } from 'react'

export interface PluginRestOptions {
  method?: string
  body?: unknown
  timeoutMs?: number
}
export interface PluginOs {
  revealPath: (path: string) => Promise<boolean>
  /** Newer Desktops only: feature-detect. */
  writeClipboard?: (text: string) => Promise<boolean>
}
export interface GatewayEvent {
  type: string
  payload?: unknown
  session_id?: string
  profile?: string
  connectionId?: string
}
export interface ReadableAtom<T> {
  get: () => T
  subscribe: (fn: (value: T) => void) => () => void
}
export interface PluginContribution {
  id: string
  area: string
  order?: number
  data?: unknown
  render?: () => ReactNode
}
export interface PluginContext {
  readonly source: string
  registerMany: (cs: PluginContribution[]) => () => void
  onDispose: (fn: () => void) => void
  onEvent: (type: string, listener: (event: GatewayEvent) => void) => () => void
  rest: <T>(path: string, opts?: PluginRestOptions) => Promise<T>
  /** Absent on older Desktops. */
  os?: PluginOs
}
export interface HermesPlugin {
  id: string
  name: string
  description?: string
  register: (ctx: PluginContext) => void
}
/** Props a TRANSCRIPT_DIRECTIVE_AREA `render` receives. */
export interface TranscriptDirectiveProps {
  attrs: Readonly<Record<string, string>>
  source: string
  streaming: boolean
  sessionId?: null | string
}
export interface PaletteContribution {
  id: string
  label: string
  keywords?: string[]
  run: () => void
}
/** The file a tool-media renderer draws (`transcript.toolMedia`, newer Desktops). */
export interface ToolMediaFile {
  path: string
  name: string
  kind: string
  mime: string
  resolveUrl: () => Promise<string>
}
export interface ToolMediaRendererProps {
  file: ToolMediaFile
  toolName: string
  toolCallId: string
  args: Readonly<Record<string, unknown>>
  result: unknown
  sessionId: null | string
  fallback: ReactNode
}

export const PALETTE_AREA: string
export const STATUSBAR_AREAS: { left: string; right: string }
export const TRANSCRIPT_DIRECTIVE_AREA: string
/** Only on Desktops with the tool-media renderer seam: read it through a namespace import. */
export const TOOL_MEDIA_RENDERER_AREA: string | undefined
export const host: {
  /** Composer bus: `null` = the composer the user is typing in. */
  composer?: { submit: (sessionId: null | string, text: string) => boolean }
  state?: { profile?: ReadableAtom<string>; connectionId?: ReadableAtom<null | string> }
  openSession?: (storedSessionId: string, options?: { intent?: 'in-place' | 'stack' | 'tab' | 'window' }) => Promise<void>
  navigate: (path: string) => void
  notify: (input: { kind: 'error' | 'info' | 'success' | 'warning'; message: string }) => string
  openWorkspace?: (
    id: string,
    options: {
      dock?: { before?: null | string; pane: string; pos: 'bottom' | 'center' | 'left' | 'right' | 'top' }
      minWidth?: string
      onClose?: () => void
      render: () => ReactNode
      title?: string
    }
  ) => () => void
}
export function Button(
  props: ComponentProps<'button'> & { size?: 'default' | 'icon' | 'sm'; variant?: 'default' | 'ghost' | 'outline' }
): ReactNode
export function Codicon(props: { name: string; size?: number; spinning?: boolean; style?: CSSProperties }): ReactNode
// Radix-backed menu primitives (components/ui/dropdown-menu), newer Desktops only: read them through a namespace import.
export const DropdownMenu: undefined | ((props: { children?: ReactNode; onOpenChange?: (open: boolean) => void }) => ReactNode)
export const DropdownMenuTrigger: undefined | ((props: { asChild?: boolean; children?: ReactNode }) => ReactNode)
export const DropdownMenuContent: undefined | ((props: { align?: 'center' | 'end' | 'start'; children?: ReactNode; style?: CSSProperties }) => ReactNode)
export const DropdownMenuItem: undefined | ((props: { children?: ReactNode; disabled?: boolean; onSelect?: (event: Event) => void; title?: string }) => ReactNode)
export const DropdownMenuSeparator: undefined | (() => ReactNode)
