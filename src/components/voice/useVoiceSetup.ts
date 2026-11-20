import { useCallback, useEffect, useRef, useState } from 'react'
import {
  cancelVoiceLoopInstall,
  getVoiceLoopInstallStatus,
  getVoiceLoopRequirements,
  installVoiceLoop,
  setVoiceLoopVoice,
  uninstallVoiceLoop,
} from '../../api/voice-loop'
import type { VoiceLoopInstallStatus, VoiceLoopRequirements } from '../../api/voice-loop'
import { detailOf } from '../../lib/error-text'
import { voiceSetupMode } from '../../lib/voice/setup-view'
import type { VoiceSetupMode } from '../../lib/voice/setup-view'

const POLL_MS = 1000

export interface VoiceSetup {
  mode: VoiceSetupMode
  requirements: VoiceLoopRequirements | null
  status: VoiceLoopInstallStatus | null
  /** Why the requirements could not be read. */
  loadError: string | null
  /** Why the last button press did not work. */
  actionError: string | null
  /** Start or continue the setup. `force` is the repair. */
  install: (options?: { force?: boolean }) => Promise<void>
  cancel: () => Promise<void>
  uninstall: () => Promise<void>
  refresh: () => Promise<void>
  /** Choose the voice the answers are spoken in. On an installed engine this can download the one voice. */
  chooseVoice: (voice: string) => Promise<void>
  /** The voice that is being fetched right now, null otherwise. */
  choosingVoice: string | null
}

/**
 * The voice setup as the surface sees it. The setup itself runs in Rust and
 * survives this page, so opening the surface again finds a running setup and
 * follows it.
 */
export function useVoiceSetup(): VoiceSetup {
  const [requirements, setRequirements] = useState<VoiceLoopRequirements | null>(null)
  const [status, setStatus] = useState<VoiceLoopInstallStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // Removing takes a few seconds, and until it is done the files still count
  // as installed. Without this the surface offered Start on an engine that
  // was being deleted.
  const [removing, setRemoving] = useState(false)
  const [choosingVoice, setChoosingVoice] = useState<string | null>(null)
  const alive = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const [nextRequirements, nextStatus] = await Promise.all([
        getVoiceLoopRequirements(),
        getVoiceLoopInstallStatus().catch(() => null),
      ])
      if (!alive.current) return
      setRequirements(nextRequirements)
      setStatus(nextStatus)
      setLoadError(null)
    } catch (error) {
      if (!alive.current) return
      setLoadError(detailOf(error) || 'The voice setup could not be read.')
    }
  }, [])

  useEffect(() => {
    alive.current = true
    // Reads the setup once. Every setState in refresh() comes after an await.
    void refresh()
    return () => { alive.current = false }
  }, [refresh])

  const running = status?.status === 'running'
  useEffect(() => {
    if (!running) return
    const id = setInterval(async () => {
      try {
        const next = await getVoiceLoopInstallStatus()
        if (!alive.current) return
        setStatus(next)
        // The setup is over: what is installed has changed.
        if (next.status !== 'running') void refresh()
      } catch { /* one failed poll is not the end of a setup */ }
    }, POLL_MS)
    return () => clearInterval(id)
  }, [running, refresh])

  const act = useCallback(async (action: () => Promise<unknown>) => {
    setActionError(null)
    try {
      await action()
    } catch (error) {
      if (alive.current) setActionError(detailOf(error) || 'That did not work. Try again.')
    }
    await refresh()
  }, [refresh])

  const install = useCallback((options?: { force?: boolean }) => act(() => installVoiceLoop(options)), [act])
  const cancel = useCallback(() => act(() => cancelVoiceLoopInstall()), [act])
  const uninstall = useCallback(async () => {
    setRemoving(true)
    try {
      await act(() => uninstallVoiceLoop())
    } finally {
      if (alive.current) setRemoving(false)
    }
  }, [act])

  const chooseVoice = useCallback(async (voice: string) => {
    setChoosingVoice(voice)
    try {
      await act(() => setVoiceLoopVoice(voice))
    } finally {
      if (alive.current) setChoosingVoice(null)
    }
  }, [act])

  return {
    mode: removing ? 'removing' : voiceSetupMode(requirements, status, loadError),
    requirements, status, loadError, actionError, install, cancel, uninstall, refresh, chooseVoice, choosingVoice,
  }
}
