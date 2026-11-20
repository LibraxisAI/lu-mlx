import { useCallback, useEffect, useRef, useState } from 'react'
import { getVoiceLoopStatus } from '../../api/voice-loop'
import { unloadVoiceEngine, voiceLoadedChatModel } from '../../api/voice-session'
import { useVoiceSessionStore } from '../../stores/voiceSessionStore'
import { formatBytes } from '../../lib/formatters'

const POLL_MS = 3000
const CONFIRMATION_MS = 6000

/** What the switch says before the click. */
export function unloadTitle(memoryBytes: number | null, withModel: boolean): string {
  const amount = memoryBytes && memoryBytes > 0 ? `about ${formatBytes(memoryBytes)}` : 'its memory'
  return `Unload Voice and free ${amount}. One click ends the session, stops the voice engine and gives back everything Voice holds`
    + (withModel ? ', the chat model it loaded included.' : '.')
}

/** What it says after the click. */
export function unloadedWords(result: { freedBytes: number | null; modelUnloaded: boolean; gone: boolean }): string {
  if (!result.gone) return 'Voice could not be unloaded. Try again.'
  const freed = result.freedBytes && result.freedBytes > 0 ? `${formatBytes(result.freedBytes)} freed.` : 'Its memory is free again.'
  return `Voice is unloaded. ${freed}${result.modelUnloaded ? ' The chat model is unloaded too.' : ''}`
}

/**
 * The light switch next to the title. It is only there while the voice
 * engine is in memory, it shows how much that is, and one click gives all of
 * it back: session, engine process and the chat model Voice had loaded.
 */
export function VoiceUnloadSwitch() {
  const phase = useVoiceSessionStore((s) => s.phase)
  const [loaded, setLoaded] = useState<{ bytes: number | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const alive = useRef(true)
  const saidTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const look = useCallback(async () => {
    try {
      const status = await getVoiceLoopStatus()
      if (alive.current) setLoaded(status.running ? { bytes: status.memoryBytes ?? null } : null)
    } catch {
      if (alive.current) setLoaded(null)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void look()
    const timer = setInterval(() => { void look() }, POLL_MS)
    return () => {
      alive.current = false
      clearInterval(timer)
      if (saidTimer.current) clearTimeout(saidTimer.current)
    }
  }, [look])
  // A session that starts or ends changes what is loaded: look at once.
  useEffect(() => { void look() }, [phase, look])

  const unload = async () => {
    if (busy) return
    setBusy(true)
    try {
      const result = await unloadVoiceEngine()
      if (!alive.current) return
      setSaid(unloadedWords(result))
      if (saidTimer.current) clearTimeout(saidTimer.current)
      saidTimer.current = setTimeout(() => { if (alive.current) setSaid(null) }, CONFIRMATION_MS)
      await look()
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const title = unloadTitle(loaded?.bytes ?? null, voiceLoadedChatModel())
  return (
    <>
      {loaded && (
        <button
          type="button"
          role="switch"
          aria-checked="true"
          aria-label={title}
          title={title}
          disabled={busy}
          onClick={() => { void unload() }}
          data-testid="voice-unload"
          className="lu-light-switch"
        >
          <span className="lu-light-switch__rocker" aria-hidden />
          <span className="t-micro tabular-nums text-gray-600 dark:text-gray-300">
            {busy ? 'Unloading' : loaded.bytes ? formatBytes(loaded.bytes) : 'Loaded'}
          </span>
        </button>
      )}
      {said && !loaded && (
        <span role="status" className="t-micro text-gray-600 dark:text-gray-300" data-testid="voice-unloaded">{said}</span>
      )}
    </>
  )
}
