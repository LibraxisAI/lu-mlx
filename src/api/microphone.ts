/**
 * The one microphone choice of the app.
 *
 * Dictation in chat and the Voice surface both record in the webview through
 * getUserMedia, so one remembered device serves both. The voice loop process
 * never opens a device itself: it gets the audio over its socket.
 *
 * Two things a device id alone cannot carry, and why the label is remembered
 * next to it:
 *  - A microphone that is unplugged must not end a recording in an error.
 *    The default one is opened instead, and the choice stays remembered for
 *    the day the device is back.
 *  - A webview may hand out a new id for the same device (WebKit ties ids to
 *    stored site data). The device is then found again by its name.
 */

import { useVoiceStore } from '../stores/voiceStore'

export interface Microphone {
  deviceId: string
  label: string
}

/** Entries some webviews add for "whatever the system uses". The list has its own. */
const SYSTEM_ALIASES = new Set(['default', 'communications'])

/** Failures that a second attempt would only repeat, or ask the user about twice. */
const REFUSALS = new Set(['NotAllowedError', 'SecurityError', 'PermissionDeniedError'])

function mediaDevices(): MediaDevices | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
}

/** Whether this window can record at all. */
export function microphoneSupported(): boolean {
  return typeof mediaDevices()?.getUserMedia === 'function'
}

/**
 * The microphones that can be named. Before the user has allowed the
 * microphone a webview lists devices without a name or without an id; those
 * are left out, so the list is empty until there is something to show.
 */
export async function listMicrophones(): Promise<Microphone[]> {
  const devices = mediaDevices()
  if (!devices?.enumerateDevices) return []
  const all = await devices.enumerateDevices().catch(() => [] as MediaDeviceInfo[])
  return all
    .filter((d) => d.kind === 'audioinput' && d.deviceId && d.label && !SYSTEM_ALIASES.has(d.deviceId))
    .map((d) => ({ deviceId: d.deviceId, label: d.label }))
}

/**
 * Ask for the microphone once, so the devices get their names, and let go of
 * it again. Rejects with the getUserMedia failure when access is refused.
 */
export async function unlockMicrophoneNames(): Promise<Microphone[]> {
  const devices = mediaDevices()
  if (!devices?.getUserMedia) return []
  const stream = await devices.getUserMedia({ audio: true, video: false })
  stream.getTracks().forEach((track) => track.stop())
  return listMicrophones()
}

/** Where a remembered choice stands against the devices that are there now. */
export type MicrophoneMatch =
  | { state: 'default' }
  | { state: 'present'; deviceId: string }
  /** The same device under a new id. */
  | { state: 'renamed'; deviceId: string }
  | { state: 'absent' }

export function matchMicrophone(chosen: Microphone, present: Microphone[]): MicrophoneMatch {
  if (!chosen.deviceId) return { state: 'default' }
  if (present.some((m) => m.deviceId === chosen.deviceId)) return { state: 'present', deviceId: chosen.deviceId }
  const byName = chosen.label ? present.find((m) => m.label === chosen.label) : undefined
  return byName ? { state: 'renamed', deviceId: byName.deviceId } : { state: 'absent' }
}

function remember(deviceId: string, label: string): void {
  useVoiceStore.getState().updateVoiceSettings({ micId: deviceId, micLabel: deviceId ? label : '' })
}

const chosenListeners = new Set<(deviceId: string) => void>()

/** Hear about every choice the user makes. Returns the way to stop listening. */
export function onMicrophoneChosen(listener: (deviceId: string) => void): () => void {
  chosenListeners.add(listener)
  return () => { chosenListeners.delete(listener) }
}

/**
 * The user picked a microphone, for dictation and Voice alike. An empty id is
 * the system default. A running Voice session switches over right away.
 */
export function chooseMicrophone(deviceId: string, label: string): void {
  remember(deviceId, label)
  for (const listener of chosenListeners) listener(deviceId)
}

function constraints(audio: MediaTrackConstraints, deviceId?: string): MediaStreamConstraints {
  return { audio: deviceId ? { ...audio, deviceId: { exact: deviceId } } : Object.keys(audio).length ? audio : true, video: false }
}

/**
 * Open the chosen microphone, or the system default when it cannot be had.
 *
 * `micId` is the remembered choice unless the caller passes its own. A device
 * that is gone, busy or known under a new id never fails the call: the default
 * microphone is opened, and when the device then shows up under its name with
 * another id, that one is taken and the remembered id is brought up to date.
 * Only a refusal and a failure of the default microphone itself are thrown.
 */
export async function openMicrophone(
  audio: MediaTrackConstraints = {},
  micId: string | null = useVoiceStore.getState().micId,
): Promise<MediaStream> {
  const devices = mediaDevices()
  if (!devices?.getUserMedia) throw new DOMException('This window cannot access a microphone.', 'NotSupportedError')
  if (!micId) return devices.getUserMedia(constraints(audio))

  try {
    return await devices.getUserMedia(constraints(audio, micId))
  } catch (error) {
    if (REFUSALS.has((error as { name?: string } | null)?.name ?? '')) throw error
  }

  const fallback = await devices.getUserMedia(constraints(audio))
  const saved = useVoiceStore.getState()
  const remembered = saved.micId === micId
  const match = matchMicrophone({ deviceId: micId, label: remembered ? saved.micLabel : '' }, await listMicrophones())
  if (match.state !== 'renamed') return fallback
  try {
    const stream = await devices.getUserMedia(constraints(audio, match.deviceId))
    fallback.getTracks().forEach((track) => track.stop())
    // Not a choice of the user, only the new id of the device already chosen.
    if (remembered) remember(match.deviceId, saved.micLabel)
    return stream
  } catch {
    return fallback
  }
}
