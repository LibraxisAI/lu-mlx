import { useModelStore } from '../stores/modelStore'
import { useSettingsStore } from '../stores/settingsStore'
import { modelOutOfMode } from './modeGate'

/**
 * Does a chat send have a model to run on? The composer asks this before it
 * hands the message over, because `sendMessage` (hooks/useChat.ts) returns
 * without a word when it has none, and the composer would then clear a message
 * that went nowhere.
 *
 * The same two cases `sendMessage` turns away: nothing picked, and a model
 * from the other side of the Cloud switch. That one is cleared here exactly
 * as `sendMessage` clears it (the switch is a money gate), so the picker shows
 * the honest "Select Model" when it opens.
 */
export function chatModelReady(): boolean {
  const { activeModel, setActiveModel } = useModelStore.getState()
  if (!activeModel) return false
  if (modelOutOfMode(activeModel, useSettingsStore.getState().settings.appMode)) {
    setActiveModel(null)
    return false
  }
  return true
}
