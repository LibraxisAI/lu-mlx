// @vitest-environment jsdom
/**
 * "What's new" can be opened again (box run, 03.10.2026): the sheet showed
 * once after the update and there was no way back to it, not in Settings and
 * not in a menu. The version row under Settings, Updates carries a plain
 * "What's new" link that opens the same sheet.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { version } from '../../../../package.json'
import { UpdateSection } from '../SettingsPage'
import { ReleaseNotesModal } from '../../release/ReleaseNotesModal'
import { useReleaseNotesStore } from '../../../stores/releaseNotesStore'
import { useSettingsStore } from '../../../stores/settingsStore'

beforeEach(() => {
  useSettingsStore.getState().updateSettings({ onboardingDone: true })
  // The sheet was read and closed after the update.
  useReleaseNotesStore.setState({ lastNotesVersion: version, reopened: false })
})
afterEach(() => { cleanup() })

function openUpdates() {
  render(<><UpdateSection /><ReleaseNotesModal /></>)
  fireEvent.click(screen.getByRole('button', { name: 'Updates' }))
}

describe("What's new can be opened again from Settings", () => {
  it('the link sits at the version number and opens the sheet that was already read', async () => {
    openUpdates()
    expect(screen.queryByTestId('release-heading')).toBeNull()
    const link = screen.getByRole('button', { name: "What's new" })
    expect(link.parentElement?.textContent).toContain(`v${version}`)
    fireEvent.click(link)
    await waitFor(() => expect(screen.getByTestId('release-heading').textContent).toBe(`What's new in ${version}`))
  })

  it('"Got it" closes it again and it stays closed', async () => {
    openUpdates()
    fireEvent.click(screen.getByRole('button', { name: "What's new" }))
    fireEvent.click(await screen.findByRole('button', { name: 'Got it' }))
    await waitFor(() => expect(screen.queryByTestId('release-heading')).toBeNull())
    expect(useReleaseNotesStore.getState().reopened).toBe(false)
    expect(useReleaseNotesStore.getState().lastNotesVersion).toBe(version)
  })

  it('reopening is not remembered across a restart', () => {
    useReleaseNotesStore.getState().reopen()
    const stored = JSON.parse(localStorage.getItem('lu_release_notes') ?? '{}') as { state?: Record<string, unknown> }
    expect(stored.state).not.toHaveProperty('reopened')
  })
})
