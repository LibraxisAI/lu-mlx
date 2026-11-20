import { useState } from 'react'
import { Settings2 } from 'lucide-react'
import { BetaMark } from '../ui/BetaMark'
import { VoiceControls } from './VoiceControls'
import { VoiceSessionPanel } from './VoiceSessionPanel'
import { VoiceSettingsPopup } from './VoiceSettingsPopup'
import { VoiceSetupPanel } from './VoiceSetupPanel'
import { VoiceUnloadSwitch } from './VoiceUnloadSwitch'
import { useVoiceSetup } from './useVoiceSetup'

/**
 * The Voice surface: talk to the selected chat model and hear it answer.
 * Until the voice engine is installed it shows the setup, afterwards the
 * session. Settings, repair and uninstall live in one popup behind the gear.
 * The switches of a session sit in one row next to the title, and so does
 * the light switch that unloads Voice while it is in memory.
 */
export function VoiceView() {
  const setup = useVoiceSetup()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const ready = setup.mode === 'ready'

  return (
    <div className="h-full flex flex-col min-w-0" data-testid="voice-view">
      <header className="shrink-0 flex items-center gap-2 h-10 px-4">
        <h1 className="t-title text-gray-900 dark:text-white">Voice</h1>
        <BetaMark feature="voice" />
        {ready && <VoiceUnloadSwitch />}
        {ready
          ? <VoiceControls onOpenSettings={() => setSettingsOpen(true)} />
          : (
            <button type="button" className="lu-control lu-control--icon" onClick={() => setSettingsOpen(true)} aria-label="Voice settings" title="Voice settings">
              <Settings2 size={12} />
            </button>
          )}
      </header>

      {ready ? (
        <VoiceSessionPanel />
      ) : (
        <VoiceSetupPanel
          mode={setup.mode}
          requirements={setup.requirements}
          status={setup.status}
          loadError={setup.loadError}
          actionError={setup.actionError}
          onInstall={() => { void setup.install() }}
          onCancel={() => { void setup.cancel() }}
          onRetryLoad={() => { void setup.refresh() }}
          onChooseVoice={(voice) => { void setup.chooseVoice(voice) }}
          choosingVoice={setup.choosingVoice !== null}
        />
      )}

      <VoiceSettingsPopup open={settingsOpen} onClose={() => setSettingsOpen(false)} setup={setup} />
    </div>
  )
}
