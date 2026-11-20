/**
 * A release without a Mac build is not a broken connection.
 *
 * Fehlerkontrolle Mac 2, Fund 6: when `latest.json` has no `darwin-aarch64`
 * entry, the updater plugin refuses with `Error::TargetNotFound`, whose text
 * is "the platform `darwin-aarch64` was not found in the response `platforms`
 * object". The store filed every error from `check()` as a failed check, and
 * Settings then said "Check your connection and try again." on a Mac whose
 * connection was fine. That is the state of every Mac install until the first
 * Mac release is out, and of any later release whose Mac job was skipped.
 *
 * On a Mac the case now lands in a state of its own: no failed check, no
 * update on offer, no handle left behind. Windows and Linux keep the old
 * answer, and a real network error is a failed check on every platform.
 *
 * Negative control: with the `catch` as it was (`set({ isChecking: false,
 * lastCheckFailed: true })`) the three Mac cases are red.
 *
 * Run: npx vitest run src/stores/__tests__/update-no-mac-build.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const platform = vi.hoisted(() => ({ mac: true }))
const check = vi.hoisted(() => vi.fn())

vi.mock('../../api/backend', () => ({
  isTauri: () => true,
  isMacOS: () => platform.mac,
  isLinux: () => false,
  backendCall: vi.fn(async () => null),
  openExternal: vi.fn(),
}))
vi.mock('@tauri-apps/plugin-updater', () => ({ check: () => check() }))
vi.mock('../../../package.json', () => ({ version: '3.0.5' }))

import { useUpdateStore, releaseHasNoBuildForThisPlatform } from '../updateStore'

/** What the plugin sends for a release that lacks this platform. */
const TARGET_NOT_FOUND = 'the platform `darwin-aarch64` was not found in the response `platforms` object'

beforeEach(() => {
  platform.mac = true
  check.mockReset()
  useUpdateStore.setState({
    latestVersion: null,
    updateAvailable: false,
    releaseNotes: null,
    isChecking: false,
    lastChecked: null,
    lastCheckFailed: false,
    noBuildForPlatform: false,
    downloadStatus: 'idle',
    errorMessage: null,
  })
})

describe('recognising the case', () => {
  it('knows the plugin text, as a string and as an Error, and the variant name', () => {
    expect(releaseHasNoBuildForThisPlatform(TARGET_NOT_FOUND)).toBe(true)
    expect(releaseHasNoBuildForThisPlatform(new Error(TARGET_NOT_FOUND))).toBe(true)
    expect(releaseHasNoBuildForThisPlatform('TargetNotFound("darwin-aarch64")')).toBe(true)
  })

  it('NEGATIVE CONTROL: a network error, a bad signature and nothing at all are not that case', () => {
    expect(releaseHasNoBuildForThisPlatform('error sending request for url (https://github.com/...)')).toBe(false)
    expect(releaseHasNoBuildForThisPlatform(new Error('Failed to fetch'))).toBe(false)
    expect(releaseHasNoBuildForThisPlatform('the signature was not found in the release')).toBe(false)
    expect(releaseHasNoBuildForThisPlatform(undefined)).toBe(false)
  })
})

describe('a Mac checking a release that has no Mac build', () => {
  it('the manual check ends calm: not failed, nothing on offer, and it says so', async () => {
    check.mockRejectedValue(TARGET_NOT_FOUND)
    await useUpdateStore.getState().checkForUpdate(true)
    const s = useUpdateStore.getState()
    expect(s.noBuildForPlatform).toBe(true)
    expect(s.lastCheckFailed).toBe(false)
    expect(s.updateAvailable).toBe(false)
    expect(s.latestVersion).toBeNull()
    expect(s.isChecking).toBe(false)
    expect(s.downloadStatus).toBe('idle')
    expect(s.errorMessage).toBeNull()
  })

  it('the silent background check raises nothing either: no failure, no badge, no error text', async () => {
    check.mockRejectedValue(new Error(TARGET_NOT_FOUND))
    await useUpdateStore.getState().checkForUpdate()
    const s = useUpdateStore.getState()
    expect(s.lastCheckFailed).toBe(false)
    expect(s.updateAvailable).toBe(false)
    expect(s.errorMessage).toBeNull()
    // The check did reach the server, so it counts as a check: the six hour
    // pause applies and the app does not ask again on every tick.
    expect(typeof s.lastChecked).toBe('number')
  })

  it('a later release that does carry a Mac build clears the state', async () => {
    check.mockRejectedValueOnce(TARGET_NOT_FOUND)
    await useUpdateStore.getState().checkForUpdate(true)
    expect(useUpdateStore.getState().noBuildForPlatform).toBe(true)

    check.mockResolvedValueOnce(null)
    await useUpdateStore.getState().checkForUpdate(true)
    expect(useUpdateStore.getState().noBuildForPlatform).toBe(false)
    expect(useUpdateStore.getState().lastCheckFailed).toBe(false)
  })

  it('NEGATIVE CONTROL: a real network error on a Mac is still a failed check', async () => {
    check.mockRejectedValue('error sending request for url (https://github.com/x/latest.json)')
    await useUpdateStore.getState().checkForUpdate(true)
    const s = useUpdateStore.getState()
    expect(s.lastCheckFailed).toBe(true)
    expect(s.noBuildForPlatform).toBe(false)
    expect(s.lastChecked).toBeNull()
  })
})

describe('WINDOWS CONTROL', () => {
  it('the same plugin error is a failed check there, exactly as before', async () => {
    platform.mac = false
    check.mockRejectedValue('the platform `windows-x86_64` was not found in the response `platforms` object')
    await useUpdateStore.getState().checkForUpdate(true)
    const s = useUpdateStore.getState()
    expect(s.lastCheckFailed).toBe(true)
    expect(s.noBuildForPlatform).toBe(false)
    expect(s.lastChecked).toBeNull()
  })
})
