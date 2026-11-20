import { create } from 'zustand'

/**
 * Is Create in chat released for THIS account?
 *
 * The server decides (CREATE_CHAT and CREATE_CHAT_ALLOWLIST on the web side)
 * and says so in /api/me as features.createChat. The app holds only that
 * answer: nothing in the build and no setting can switch it on. The answer
 * rides on the account probe the app already makes (hooks/useCloudAuth), so it
 * costs no request of its own.
 *
 * `null` means not answered yet, and everything reads that as "not released":
 * until the server has said yes, the cloud chat is the one that shipped before.
 *
 * The web twin is the web app. It is not mirrored
 * because the two apps probe /api/me in different places.
 */
export const useCreateChatReleaseStore = create<{ released: boolean | null }>(() => ({ released: null }))

/** Takes the answer out of an /api/me body. A body without the field (an older
 *  server, a signed out account) is a no. */
export function noteCreateChatRelease(me: unknown): void {
  const flag = (me as { features?: { createChat?: unknown } } | null)?.features?.createChat
  useCreateChatReleaseStore.setState({ released: flag === true })
}

/** Signed out, or the probe was refused: nothing is released. */
export function clearCreateChatRelease(): void {
  useCreateChatReleaseStore.setState({ released: null })
}

/** For code outside React: the answer as it stands right now. */
export function createChatReleasedHere(): boolean {
  return useCreateChatReleaseStore.getState().released === true
}

/** For components. Kept current by the account probe. */
export function useCreateChatReleased(): boolean {
  return useCreateChatReleaseStore((s) => s.released === true)
}
