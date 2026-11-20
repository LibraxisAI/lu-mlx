import { useEffect, useRef, useState } from 'react'
import { Modal } from '../ui/Modal'
import { BetaMark } from '../ui/BetaMark'
import { ModalButton } from '../ui/ModalActions'
import { InlineToggle } from '../settings/InlineToggle'
import { SliderControl } from '../settings/SliderControl'
import { THINKING_BUDGET_STEPS, thinkingBudgetStep } from '../../lib/voice/work-scope'
import { useVoiceStore } from '../../stores/voiceStore'
import { useVoiceSessionStore } from '../../stores/voiceSessionStore'
import { stopVoiceSession } from '../../api/voice-session'
import { chooseMicrophone } from '../../api/microphone'
import { playVoiceSample } from '../../api/voice-sample'
import type { VoiceSample } from '../../api/voice-sample'
import { voiceLabel } from '../../api/voice-loop'
import { detailOf } from '../../lib/error-text'
import { voiceSetupCredits } from '../../lib/voice/setup-view'
import { VoicePicker, voiceDownloadHint } from './VoicePicker'
import type { VoiceSetup } from './useVoiceSetup'

interface Props {
  open: boolean
  onClose: () => void
  setup: VoiceSetup
}

const labelCls = 't-body text-gray-700 dark:text-gray-400'
const hintCls = 't-micro leading-relaxed text-gray-500 dark:text-gray-400'

/**
 * Everything adjustable about Voice, in one popup with its X in the corner.
 * The microphone, the mute default, the start sound and the thinking length
 * are remembered here,
 * the chosen voice with the voice engine itself.
 */
export function VoiceSettingsPopup({ open, onClose, setup }: Props) {
  const mics = useVoiceSessionStore((s) => s.mics)
  const liveMicId = useVoiceSessionStore((s) => s.micId)
  const phase = useVoiceSessionStore((s) => s.phase)
  const savedMicId = useVoiceStore((s) => s.micId)
  const startMuted = useVoiceStore((s) => s.loopStartMuted)
  const startSound = useVoiceStore((s) => s.loopStartSound)
  const thinking = useVoiceStore((s) => s.loopThinking)
  const budget = thinkingBudgetStep(useVoiceStore((s) => s.loopThinkingBudget))
  const updateVoiceSettings = useVoiceStore((s) => s.updateVoiceSettings)
  const [confirmUninstall, setConfirmUninstall] = useState(false)
  // The sample of a voice: waiting for the engine, playing, or why it did not play.
  const [sample, setSample] = useState<{ state: 'idle' | 'loading' | 'playing'; error: string | null }>({ state: 'idle', error: null })
  const playing = useRef<VoiceSample | null>(null)
  const stopSample = () => {
    playing.current?.stop()
    playing.current = null
  }
  // Leaving the surface ends a sample like closing the popup does.
  useEffect(() => () => { playing.current?.stop() }, [])

  const installed = setup.requirements?.installed === true
  const busy = setup.mode === 'installing' || setup.mode === 'removing'
  const sessionRunning = phase === 'starting' || phase === 'live'
  // A running session knows which device it really opened. Otherwise show
  // the remembered choice, when that device is in the list.
  const wanted = sessionRunning && liveMicId ? liveMicId : savedMicId
  const selected = mics.some((m) => m.deviceId === wanted) ? wanted : ''
  const credits = setup.requirements ? voiceSetupCredits(setup.requirements) : []
  const voices = setup.requirements?.voices ?? []
  const voice = setup.requirements?.voice ?? ''
  const choosing = setup.choosingVoice
  const sampling = sample.state !== 'idle'

  const close = () => {
    stopSample()
    setSample({ state: 'idle', error: null })
    setConfirmUninstall(false)
    onClose()
  }
  const chooseVoice = (next: string) => {
    stopSample()
    setSample({ state: 'idle', error: null })
    void setup.chooseVoice(next)
  }
  const listen = () => {
    if (sampling) {
      stopSample()
      setSample({ state: 'idle', error: null })
      return
    }
    setSample({ state: 'loading', error: null })
    const started = playVoiceSample(voice, () => setSample({ state: 'playing', error: null }))
    playing.current = started
    started.done.then(
      () => { if (playing.current === started) { playing.current = null; setSample({ state: 'idle', error: null }) } },
      (error: unknown) => { if (playing.current === started) { playing.current = null; setSample({ state: 'idle', error: detailOf(error) }) } },
    )
  }
  const voiceLine = choosing
    ? `Getting ${voiceLabel(choosing)} ready.`
    : sample.state === 'loading'
      ? 'Loading the voice. The first time this takes a moment.'
      : sessionRunning
        ? 'A new voice speaks from the next session on. Stop the session to listen to a voice.'
        : `${voiceDownloadHint(voices)} A new voice speaks from the next session on.`
  const repair = () => {
    stopVoiceSession('repair')
    void setup.install({ force: true })
    close()
  }
  const uninstall = () => {
    stopVoiceSession('uninstall')
    void setup.uninstall()
    close()
  }

  return (
    <Modal open={open} onClose={close} title="Voice settings" titleMark={<BetaMark feature="voice" />} maxWidth="max-w-md">
      <div className="space-y-4">
        <section className="space-y-1.5">
          <label htmlFor="voice-mic" className={labelCls}>Microphone</label>
          <select
            id="voice-mic"
            value={selected}
            onChange={(event) => chooseMicrophone(event.target.value, mics.find((m) => m.deviceId === event.target.value)?.label ?? '')}
            className="w-full h-[var(--control-h-md)] px-2 rounded-md t-control bg-white dark:bg-white/[0.04] border border-gray-200 dark:border-white/10 text-gray-800 dark:text-gray-200 focus:outline-none focus:border-gray-400 dark:focus:border-white/25"
          >
            <option value="">System default</option>
            {mics.map((mic) => <option key={mic.deviceId} value={mic.deviceId}>{mic.label}</option>)}
          </select>
          {mics.length === 0 && (
            <p className={hintCls}>Your microphones are listed here once a voice session has started.</p>
          )}
          <InlineToggle
            label="Start with the microphone muted"
            enabled={startMuted}
            onChange={() => updateVoiceSettings({ loopStartMuted: !startMuted })}
          />
          <InlineToggle
            label="Play a short sound when a session starts listening"
            enabled={startSound}
            onChange={() => updateVoiceSettings({ loopStartSound: !startSound })}
          />
        </section>

        <section className="space-y-1.5 pt-3 border-t border-gray-200 dark:border-white/[0.08]" aria-label="Thinking">
          <SliderControl
            label="Thinking length"
            value={THINKING_BUDGET_STEPS.indexOf(budget as typeof THINKING_BUDGET_STEPS[number])}
            min={0}
            max={THINKING_BUDGET_STEPS.length - 1}
            step={1}
            display={`up to ${budget} tokens`}
            onChange={(index) => updateVoiceSettings({ loopThinkingBudget: THINKING_BUDGET_STEPS[Math.round(index)] ?? budget })}
          />
          <p className={hintCls}>
            How long the model may think before it answers, when Thinking is switched on at the top of Voice
            {thinking ? '' : ' (it is off right now)'}. A thought is shown and never read aloud. When it gets longer than this,
            Voice asks again for a direct answer, so you always hear one. Longer thinking means a longer wait.
          </p>
        </section>

        {voices.length > 1 && (
          <section className="space-y-1.5 pt-3 border-t border-gray-200 dark:border-white/[0.08]" aria-label="Voice choice">
            <label htmlFor="voice-voice" className={labelCls}>Voice</label>
            <div className="flex items-center gap-2">
              <VoicePicker id="voice-voice" voices={voices} value={voice} onChange={chooseVoice} disabled={busy || choosing !== null} />
              <ModalButton onClick={listen} disabled={!installed || busy || choosing !== null || (sessionRunning && !sampling)}>
                {sampling ? 'Stop' : 'Listen'}
              </ModalButton>
            </div>
            <p role="status" data-testid="voice-voice-line" className={hintCls}>{voiceLine}</p>
            {(sample.error || setup.actionError) && (
              <p role="alert" className="t-micro leading-relaxed text-red-700 dark:text-red-300">{sample.error ?? setup.actionError}</p>
            )}
          </section>
        )}

        <section className="space-y-2 pt-3 border-t border-gray-200 dark:border-white/[0.08]" aria-label="Voice engine">
          <div className={labelCls}>Voice engine</div>
          <p className={hintCls}>
            {installed
              ? 'Speech recognition and speech output are installed on this computer. Repair checks the packages and every model file, and downloads again only what is missing or does not match.'
              : setup.mode === 'removing' ? 'The voice engine is being removed.' : 'The voice engine is not installed yet.'}
          </p>
          {confirmUninstall ? (
            <div className="space-y-2">
              <p role="alert" className="t-micro leading-relaxed text-gray-700 dark:text-gray-300">
                Remove the voice engine, its packages and its speech models from this computer? Your conversations stay.
              </p>
              <div className="flex gap-2">
                <ModalButton variant="danger" onClick={uninstall}>Remove</ModalButton>
                <ModalButton variant="quiet" onClick={() => setConfirmUninstall(false)}>Keep</ModalButton>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <ModalButton onClick={repair} disabled={!installed || busy}>Repair</ModalButton>
              <ModalButton onClick={() => setConfirmUninstall(true)} disabled={!installed || busy}>Uninstall</ModalButton>
            </div>
          )}
        </section>

        {credits.length > 0 && (
          <section className="space-y-0.5 pt-3 border-t border-gray-200 dark:border-white/[0.08]" aria-label="Credits">
            {credits.map((line) => <p key={line} className="t-micro leading-relaxed text-gray-500">{line}</p>)}
          </section>
        )}
      </div>
    </Modal>
  )
}
