import { create } from 'zustand'
import { VOICE_IDLE, reduceVoiceSession } from '../lib/voice/session-state'
import type { VoiceEvent, VoiceSessionState } from '../lib/voice/session-state'

interface VoiceSessionStore extends VoiceSessionState {
  dispatch: (event: VoiceEvent) => void
}

// What the Voice surface shows. Not persisted: a session does not survive the
// app, and nothing in here is a setting. No token and no key ever enters it.
export const useVoiceSessionStore = create<VoiceSessionStore>((set) => ({
  ...VOICE_IDLE,
  dispatch: (event) => set((state) => reduceVoiceSession(state, event)),
}))
