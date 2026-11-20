/**
 * @vitest-environment jsdom
 *
 * Settings, Updates, on a Mac whose release has no Mac build.
 *
 * The store half is in src/stores/__tests__/update-no-mac-build.test.ts. This
 * is the sentence: "No update for this Mac yet." It replaces "Could not check
 * for updates. Check your connection and try again.", which was untrue, and it
 * is not the green tick either, because "you are on the latest version" was
 * not what the server said.
 *
 * Negative control: without the `noBuildForPlatform` branch in UpdateSection
 * the first case shows the green tick instead (lastChecked is set) and is red.
 *
 * Run: npx vitest run src/components/settings/__tests__/update-says-no-mac-build-yet.test.ts
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

vi.mock('../../../api/backend', () => ({
  backendCall: vi.fn(async () => ({})),
  isTauri: () => true,
  isMacOS: () => true,
  isLinux: () => false,
  isWindows: () => false,
  openExternal: vi.fn(),
  secretGet: vi.fn().mockRejectedValue(new Error('no keychain here')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
}))

const { UpdateSection } = await import('../SettingsPage')
const { useUpdateStore } = await import('../../../stores/updateStore')

async function section(over: Record<string, unknown>) {
  useUpdateStore.setState({
    currentVersion: '3.0.5',
    latestVersion: null,
    updateAvailable: false,
    releaseNotes: null,
    isChecking: false,
    lastChecked: null,
    lastCheckFailed: false,
    noBuildForPlatform: false,
    dismissed: null,
    downloadStatus: 'idle',
    downloadProgress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    errorMessage: null,
    progressNote: null,
    installMethod: null,
    ...over,
  })
  render(createElement(UpdateSection))
  fireEvent.click(screen.getByText('Updates'))
  await act(async () => { await Promise.resolve() })
}

afterEach(cleanup)

describe('a release without a Mac build', () => {
  it('reads as one calm sentence, without the connection advice and without the tick', async () => {
    await section({ noBuildForPlatform: true, lastChecked: Date.now() })

    expect(screen.getByTestId('update-no-build').textContent).toBe('No update for this Mac yet.')
    expect(screen.queryByTestId('update-check-failed')).toBeNull()
    expect(screen.queryByText(/Check your connection/)).toBeNull()
    expect(screen.queryByText('You are on the latest version.')).toBeNull()
  })

  it('CONTROL: a failed check keeps its own sentence, word for word', async () => {
    await section({ lastCheckFailed: true })

    expect(screen.getByTestId('update-check-failed').textContent)
      .toBe('Could not check for updates. Check your connection and try again.')
    expect(screen.queryByTestId('update-no-build')).toBeNull()
  })

  it('CONTROL: a check that came through still gets the tick', async () => {
    await section({ lastChecked: Date.now() })

    expect(screen.getByText('You are on the latest version.')).toBeTruthy()
    expect(screen.queryByTestId('update-no-build')).toBeNull()
  })
})
