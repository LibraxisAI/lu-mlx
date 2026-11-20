import { voiceLabel } from '../../api/voice-loop'
import type { VoiceLoopVoice } from '../../api/voice-loop'
import { formatBytes } from '../../lib/formatters'

interface Props {
  id: string
  voices: VoiceLoopVoice[]
  /** The chosen voice. */
  value: string
  onChange: (voice: string) => void
  disabled?: boolean
}

const selectCls =
  'w-full h-[var(--control-h-md)] px-2 rounded-md t-control bg-white dark:bg-white/[0.04] border border-gray-200 dark:border-white/10 text-gray-800 dark:text-gray-200 focus:outline-none focus:border-gray-400 dark:focus:border-white/25 disabled:opacity-50'

/** What picking a voice costs, in one sentence, from the sizes Rust reports. */
export function voiceDownloadHint(voices: VoiceLoopVoice[]): string {
  const largest = voices.reduce((most, voice) => Math.max(most, voice.bytes), 0)
  return `A voice that is not on this computer yet is downloaded when you pick it, up to ${formatBytes(largest)}.`
}

/**
 * The list of voices, the same in the setup and in the voice settings. A
 * plain list of names: the voice says the rest when you listen to it.
 */
export function VoicePicker({ id, voices, value, onChange, disabled }: Props) {
  return (
    <select
      id={id}
      data-testid="voice-picker"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      className={selectCls}
    >
      {voices.map((voice) => (
        <option key={voice.name} value={voice.name}>{voiceLabel(voice.name)}</option>
      ))}
    </select>
  )
}
