// A microphone picked in the settings or in the Voice popup reaches a running
// voice session, and no session that is over.
//
// Run: npx vitest run src/api/__tests__/voice-session-mic.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'

const media = vi.hoisted(() => ({
  made: [] as { options: { micId?: string | null }; updateMic: ReturnType<typeof vi.fn> }[],
}))
vi.mock('../voice-media', () => {
  class VoiceMicError extends Error {}
  class LuVoiceMediaManager {
    updateMic = vi.fn(async () => {})
    selectedMic = {}
    readonly options: { micId?: string | null }
    constructor(options: { micId?: string | null }) { this.options = options; media.made.push(this) }
    // The permission prompt is still up: the session exists and is not live yet.
    initialize() { return new Promise<void>(() => {}) }
    disconnect() { return Promise.resolve() }
    enableMic() {}
    levels() { return { mic: 0, bot: 0 } }
  }
  return { LuVoiceMediaManager, VoiceMicError }
})

import { startVoiceSession, stopVoiceSession } from '../voice-session'
import { chooseMicrophone } from '../microphone'
import { useVoiceStore } from '../../stores/voiceStore'

afterEach(() => {
  stopVoiceSession()
  useVoiceStore.getState().resetVoiceDefaults()
  media.made.length = 0
})

describe('the chosen microphone and a voice session', () => {
  it('starts on the remembered microphone and switches when another one is picked', async () => {
    chooseMicrophone('desk-1', 'Desk microphone')
    void startVoiceSession()
    expect(media.made).toHaveLength(1)
    const session = media.made[0]
    expect(session.options.micId).toBe('desk-1')

    chooseMicrophone('head-1', 'Headset')
    expect(session.updateMic).toHaveBeenCalledWith('head-1')
    chooseMicrophone('', '')
    expect(session.updateMic).toHaveBeenLastCalledWith('')

    stopVoiceSession()
    chooseMicrophone('desk-1', 'Desk microphone')
    expect(session.updateMic).toHaveBeenCalledTimes(2)
  })
})
