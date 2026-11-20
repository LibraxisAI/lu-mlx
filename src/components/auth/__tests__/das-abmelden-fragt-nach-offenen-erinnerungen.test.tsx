// @vitest-environment jsdom
/**
 * R3-19, Entscheid vom 12.09.2026: das Abmelden fragt nach, wenn
 * Kontoerinnerungen noch nicht in der Wolke stehen.
 *
 * Das Abmelden raeumt die Kontosammlung aus der Ansicht. Wer nie
 * synchronisiert hat, sieht seine Eintraege auf dem naechsten Geraet nicht
 * wieder, und das kam ohne Nachfrage als Verlust an.
 *
 * Bei null offenen Eintraegen kommt keine Nachfrage. Eine Nachfrage, die immer
 * kommt, wird weggeklickt wie ein Banner, und die eine, auf die es ankommt,
 * dann mit.
 *
 * Run: npx vitest run src/components/auth/__tests__/das-abmelden-fragt-nach-offenen-erinnerungen.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { MemoryFile } from '../../../types/agent-mode'

const abgemeldet = vi.fn(async () => {})
vi.mock('../../../hooks/useCloudAuth', () => ({
  useCloudAuth: () => ({ status: 'signed-in', login: vi.fn(), signup: vi.fn(), logout: abgemeldet }),
}))
vi.mock('../../../api/cloud/supabase', () => ({ loginWithProvider: vi.fn() }))
vi.mock('../../../api/backend', () => ({ openExternal: vi.fn() }))

const { AccountPanel } = await import('../AccountPanel')
const { useCloudAuthStore } = await import('../../../stores/cloudAuthStore')
const { useMemoryStore } = await import('../../../stores/memoryStore')
const { syncMemoryHash } = await import('../../../lib/memory-sync-plan')

const erinnerung = (id: string): MemoryFile => ({
  id, type: 'project', title: `Titel ${id}`, description: `Beschreibung ${id}`,
  content: `Inhalt ${id}`, tags: [], createdAt: 1, updatedAt: 1, source: 'test',
})

const anmelden = () => useCloudAuthStore.getState().setSignedIn(
  { id: 'konto-1', email: 'a@b.c' },
  { licenseActive: false, tier: 'hosted', access: true, quota: null, paidPlan: false },
)

beforeEach(() => {
  abgemeldet.mockClear()
  anmelden()
})
afterEach(() => { cleanup(); useCloudAuthStore.getState().setSignedOut() })

describe('das Abmelden', () => {
  it('fragt nach und nennt die Zahl, wenn Erinnerungen offen sind', async () => {
    useMemoryStore.setState({
      activeMemoryOwner: 'konto-1',
      entries: [erinnerung('m1'), erinnerung('m2'), erinnerung('m3')],
      memorySyncBaselines: {},
    })
    render(<AccountPanel />)
    fireEvent.click(screen.getByText('Sign out'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('3 memories are not synced yet. Sign out anyway?')).toBeTruthy()
    expect(abgemeldet, 'abgemeldet, bevor jemand geantwortet hat').not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByText('Cancel'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(abgemeldet, 'Cancel hat trotzdem abgemeldet').not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Sign out'))
    const zweiter = await screen.findByRole('dialog')
    fireEvent.click(within(zweiter).getByText('Sign out'))
    await waitFor(() => expect(abgemeldet).toHaveBeenCalledTimes(1))
  })

  it('zaehlt nur, was wirklich offen ist, und fragt sonst nicht', async () => {
    // Negativkontrolle: zwei von drei stehen mit ihrem Fingerabdruck in der
    // Basis, also ist genau eine offen. Und mit allen dreien in der Basis
    // kommt gar kein Dialog.
    const alle = [erinnerung('m1'), erinnerung('m2'), erinnerung('m3')]
    const basen = Object.fromEntries(
      await Promise.all(alle.map(async (m) => [m.id, { revision: 1, hash: await syncMemoryHash(m) }] as const)),
    )
    useMemoryStore.setState({
      activeMemoryOwner: 'konto-1',
      entries: alle,
      memorySyncBaselines: { 'konto-1': { m1: basen.m1, m2: basen.m2 } },
    })
    render(<AccountPanel />)
    fireEvent.click(screen.getByText('Sign out'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('1 memories are not synced yet. Sign out anyway?')).toBeTruthy()
    fireEvent.click(within(dialog).getByText('Cancel'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    useMemoryStore.setState({ memorySyncBaselines: { 'konto-1': basen } })
    fireEvent.click(screen.getByText('Sign out'))
    await waitFor(() => expect(abgemeldet).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog'), 'nachgefragt, obwohl nichts offen war').toBeNull()
  })

  it('fragt nicht, wenn gar keine Kontosammlung gewaehlt ist', async () => {
    useMemoryStore.setState({ activeMemoryOwner: null, entries: [erinnerung('m1')], memorySyncBaselines: {} })
    render(<AccountPanel />)
    fireEvent.click(screen.getByText('Sign out'))
    await waitFor(() => expect(abgemeldet).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
