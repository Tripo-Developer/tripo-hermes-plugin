/**
 * Where a card or gallery button sends its chat message. Pure (the host is passed in) so the node tests drive it.
 *
 * - A transcript card sends to the chat whose transcript shows it: Desktop passes that chat's id to directive renders
 *   as `sessionId` (null while the chat has no session yet). Desktops without the field pass nothing and keep
 *   `submit(null, …)`: the composer the user is typing in.
 * - The gallery is in no chat, so it sends to the chat that made the selected task (the session id "Made from"
 *   recorded), opening that chat first when no composer for it is on screen. With no recorded chat, or a Desktop
 *   without `openSession`, it uses the composer the user is typing in.
 *
 * Both resolve false when nothing took the text; the caller shows the warning.
 *
 * Adapted from Nous Research's Meshy plugin (hermes-official-plugins, MIT, Copyright (c) 2025 Nous Research).
 */

export interface ChatHost {
  composer?: { submit?: (sessionId: null | string, text: string) => boolean }
  openSession?: (storedSessionId: string) => Promise<void>
}

export interface ChatSender {
  /** Send `text` as a user message. */
  submit: (text: string) => Promise<boolean>
}

const submitTo = (host: ChatHost, id: null | string, text: string): boolean => {
  try {
    return typeof host.composer?.submit === 'function' && Boolean(host.composer.submit(id, text))
  } catch {
    return false
  }
}

/** Sender for a transcript card; `sessionId` is the directive render prop (undefined on Desktops without it). */
export function cardChat(host: ChatHost, sessionId: null | string | undefined): ChatSender {
  const id = sessionId ?? null
  return { submit: text => Promise.resolve(submitTo(host, id, text)) }
}

/** After `openSession` resolves, the chat's composer can take a moment to mount and claim its address. */
export const OPEN_RETRY_MS = 150
export const OPEN_RETRIES = 20

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** Sender for the gallery: `resolveSession` names the chat recorded for the selected task (null = none). */
export function recordedChat(
  host: ChatHost,
  resolveSession: () => Promise<null | string | undefined>,
  wait: (ms: number) => Promise<void> = sleep
): ChatSender {
  return {
    async submit(text) {
      if (typeof host.composer?.submit !== 'function') {
        return false // never open a chat this Desktop cannot send to
      }
      let id: null | string | undefined = null
      try {
        id = await resolveSession()
      } catch {
        id = null
      }
      if (!id || typeof host.openSession !== 'function') {
        return submitTo(host, null, text)
      }
      if (submitTo(host, id, text)) {
        return true
      }
      try {
        await host.openSession(id)
      } catch {
        return false
      }
      for (let i = 0; i < OPEN_RETRIES; i++) {
        if (submitTo(host, id, text)) {
          return true
        }
        await wait(OPEN_RETRY_MS)
      }
      return false
    }
  }
}
