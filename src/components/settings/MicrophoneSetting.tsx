import { useCallback, useEffect, useState } from 'react'
import { Mic } from 'lucide-react'
import { HINWEIS_TEXT } from '../../lib/hinweis'
import { classifyMicError } from '../../api/voice-media'
import {
  chooseMicrophone,
  listMicrophones,
  matchMicrophone,
  microphoneSupported,
  unlockMicrophoneNames,
} from '../../api/microphone'
import type { Microphone } from '../../api/microphone'
import { useVoiceStore } from '../../stores/voiceStore'

interface Props {
  /** Voice is part of this mode, so the choice is said to cover it too. */
  coversVoice: boolean
}

const hintCls = 'text-[0.55rem] text-gray-500 leading-snug'

/**
 * Which microphone dictation and Voice record from.
 *
 * A webview names its microphones only after the user has allowed the
 * microphone. Until then the list holds the system default and nothing else,
 * with a button that asks for the access, instead of entries without a name.
 * A chosen microphone that is unplugged stays in the list and stays chosen:
 * recording uses the system default until it is back.
 */
export function MicrophoneSetting({ coversVoice }: Props) {
  const micId = useVoiceStore((s) => s.micId)
  const micLabel = useVoiceStore((s) => s.micLabel)
  // Null until the webview has answered once: nothing is said about names before that.
  const [listed, setListed] = useState<Microphone[] | null>(null)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const supported = microphoneSupported()

  const refresh = useCallback(() => listMicrophones().then(setListed), [])

  useEffect(() => {
    void refresh()
    const devices = navigator.mediaDevices
    if (!devices?.addEventListener) return
    const changed = () => { void refresh() }
    devices.addEventListener('devicechange', changed)
    return () => devices.removeEventListener('devicechange', changed)
  }, [refresh])

  const mics = listed ?? []
  const match = matchMicrophone({ deviceId: micId, label: micLabel }, mics)
  // The chosen device came back under a new id: keep the choice on it.
  const renamedTo = match.state === 'renamed' ? match.deviceId : null
  useEffect(() => {
    if (renamedTo) useVoiceStore.getState().updateVoiceSettings({ micId: renamedTo })
  }, [renamedTo])

  const named = mics.length > 0
  const absent = match.state === 'absent'
  const selected = match.state === 'default' ? '' : match.state === 'absent' ? micId : match.deviceId

  const showNames = async () => {
    setAsking(true)
    setError(null)
    try {
      setListed(await unlockMicrophoneNames())
    } catch (e) {
      setError(classifyMicError(e).message)
    } finally {
      setAsking(false)
    }
  }

  const use = coversVoice ? 'Used for dictation in chat and for Voice.' : 'Used for dictation in chat.'

  return (<>
    <div className="flex items-center justify-between gap-2">
      <label htmlFor="settings-microphone" className="text-[0.7rem] text-gray-500 flex items-center gap-1.5">
        <Mic size={11} className="text-gray-500" />
        Microphone
      </label>
      <select
        id="settings-microphone"
        data-testid="settings-microphone"
        value={selected}
        disabled={!supported}
        onChange={(e) => chooseMicrophone(e.target.value, mics.find((m) => m.deviceId === e.target.value)?.label ?? '')}
        className="max-w-[210px] px-1.5 py-0.5 rounded bg-transparent border border-white/8 text-[0.65rem] text-gray-300 focus:outline-none disabled:opacity-50"
      >
        <option value="">System default</option>
        {mics.map((m) => <option key={m.deviceId} value={m.deviceId}>{m.label}</option>)}
        {absent && micLabel && (
          <option value={micId}>{named ? `${micLabel} (not connected)` : micLabel}</option>
        )}
      </select>
    </div>
    <p data-testid="settings-microphone-hint" className={hintCls}>
      {!supported
        ? 'This window cannot access a microphone.'
        : absent && named
          ? `${use} ${micLabel || 'The chosen microphone'} is not connected, so the system default is used until it is back.`
          : named || !listed
            ? use
            : `${use} Your microphones are listed by name once this app may use the microphone.`}
    </p>
    {supported && listed && !named && (
      <button
        type="button"
        data-testid="settings-microphone-allow"
        onClick={() => void showNames()}
        disabled={asking}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[0.6rem] font-medium bg-blue-500/15 text-blue-400 border border-blue-500/30 hover:bg-blue-500/25 transition-colors disabled:opacity-50"
      >
        Show my microphones
      </button>
    )}
    {error && <p role="alert" className={`text-[0.55rem] leading-snug ${HINWEIS_TEXT.fehler}`}>{error}</p>}
  </>)
}
