// @vitest-environment jsdom
/**
 * R5-30, Entscheid vom 12.09.2026: der Desktop bekommt den Altpfad fuer
 * alte Cloud-Erinnerungen, den bis dahin nur das Web hatte.
 *
 * Vor dem heutigen Protokoll lag die Kontosammlung als EIN Blob in der Wolke.
 * Das Web konnte ihn ansehen und entfernen, der Desktop nicht, also blieb er
 * dort liegen, wo der Kunde ihn nie zu Gesicht bekam, und eine aeltere Fassung
 * der App konnte weiter aus ihm lesen.
 *
 * Die Reihenfolge ist der eigentliche Schutz: ansehen, Haekchen, entfernen.
 * Der Knopf zum Entfernen bleibt bis dahin tot.
 *
 * Run: npx vitest run src/components/settings/__tests__/der-altpfad-steht-auch-im-desktop.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('../../../api/backend', () => ({
  backendCall: vi.fn(async () => null), isTauri: () => false, isMacOS: () => false, openExternal: vi.fn(),
}))

const befund = {
  owner: 'konto-1', collectionRevision: 0, entries: [],
  previous: [{ id: 'alt-1', content: 'aus der alten Kopie' }],
  current: [{ memory_id: 'alt-1', revision: 4, deleted: false, payload: { id: 'alt-1' }, updated_at: 'x' }],
}
const angesehen = vi.fn(async (_owner: string, _signal?: AbortSignal) => befund)
const entfernt = vi.fn(async (_review: unknown, _confirmed: boolean, _signal?: AbortSignal) => {})
vi.mock('../../../lib/memory-legacy', () => ({
  reviewPreviousMemories: (owner: string, signal?: AbortSignal) => angesehen(owner, signal),
  finalizePreviousMemories: (review: unknown, confirmed: boolean, signal?: AbortSignal) => entfernt(review, confirmed, signal),
}))

const { MemorySettings } = await import('../MemorySettings')
const { useMemoryStore } = await import('../../../stores/memoryStore')

const zustimmen = () => fireEvent.click(screen.getByLabelText('Allow cloud storage for this account collection'))

// jsdom rechnet kein Layout. Diese Lesart formt den Text so, wie die Klassen
// ihn am Schirm formen: block, p und div stehen in eigener Zeile, mr-* und
// ml-* setzen Luft. Mehr Regeln braucht der eine Fall unten nicht.
const sichtbarerText = (el: Element): string => Array.from(el.childNodes).map(node => {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (!(node instanceof Element)) return ''
  const klassen = Array.from(node.classList)
  let text = sichtbarerText(node)
  if (klassen.some(k => /^m[rx]-/.test(k))) text = `${text} `
  if (klassen.some(k => /^m[lx]-/.test(k))) text = ` ${text}`
  if (klassen.includes('block') || node.tagName === 'P' || node.tagName === 'DIV') text = `\n${text}\n`
  return text
}).join('')

beforeEach(() => {
  angesehen.mockClear(); entfernt.mockClear()
  useMemoryStore.setState({ entries: [], activeMemoryOwner: 'konto-1', memoryCollectionRevision: 0 })
})
afterEach(() => { cleanup(); useMemoryStore.setState({ activeMemoryOwner: null }) })

describe('der Altpfad in den Erinnerungseinstellungen', () => {
  it('sieht erst nach, zeigt den Befund und entfernt erst mit Haekchen', async () => {
    render(<MemorySettings />)
    zustimmen()

    fireEvent.click(screen.getByText('Review previous cloud copy for removal'))
    await waitFor(() => expect(angesehen).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('status').textContent)
      .toBe('Review both versions before removing the previous cloud copy.')
    const entfernen = screen.getByText('Remove previous cloud copy') as HTMLButtonElement
    expect(entfernen.disabled, 'entfernen war ohne Haekchen anklickbar').toBe(true)

    fireEvent.click(entfernen)
    expect(entfernt, 'ein toter Knopf hat trotzdem entfernt').not.toHaveBeenCalled()

    fireEvent.click(screen.getByLabelText(/I reviewed these versions and confirm removing the previous cloud copy/))
    expect((screen.getByText('Remove previous cloud copy') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByText('Remove previous cloud copy'))
    await waitFor(() => expect(entfernt).toHaveBeenCalledTimes(1))
    expect(entfernt.mock.calls[0][0]).toBe(befund)
    expect(entfernt.mock.calls[0][1]).toBe(true)
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(
      'Previous cloud copy removed. Older versions can no longer synchronize memories. Conversations keep synchronizing.',
    ))
    expect(screen.queryByText('Remove previous cloud copy'), 'der Befund steht nach dem Entfernen noch da').toBeNull()
  })

  it('fragt ohne Zustimmung zur Wolke gar nicht erst nach', () => {
    // Negativkontrolle: derselbe Riegel wie am Synchronisierungslauf. Ohne das
    // Haekchen zur Wolkenspeicherung geht keine Anfrage raus.
    render(<MemorySettings />)
    const nachsehen = screen.getByText('Review previous cloud copy for removal') as HTMLButtonElement
    expect(nachsehen.disabled).toBe(true)
    fireEvent.click(nachsehen)
    expect(angesehen).not.toHaveBeenCalled()
  })

  it('zeigt den Altpfad nur bei einer Kontosammlung', () => {
    cleanup()
    useMemoryStore.setState({ activeMemoryOwner: null })
    render(<MemorySettings />)
    expect(screen.queryByText('Review previous cloud copy for removal')).toBeNull()
  })

  it('traegt die Aufschriften des Webs, nicht mehr die alten kurzen', async () => {
    // Paritaet mit the web app auf
    // ef0d616a: dort heissen die zwei Knoepfe "Review previous cloud copy for
    // removal" und "Remove previous cloud copy". Der Desktop hat sie
    // abgekuerzt, und der Bericht hat trotzdem "wortgleich mit dem Web"
    // behauptet. Die zwei queryByText sind die Negativkontrolle: faellt eine
    // der alten kurzen Aufschriften zurueck, steht sie hier wieder im Baum.
    render(<MemorySettings />)
    zustimmen()
    expect(screen.queryByText('Check old memory copy'), 'die alte kurze Aufschrift steht wieder da').toBeNull()
    fireEvent.click(screen.getByText('Review previous cloud copy for removal'))
    await waitFor(() => expect(angesehen).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('Remove old copy'), 'die alte kurze Aufschrift steht wieder da').toBeNull()
    expect(screen.getByText('Remove previous cloud copy')).toBeTruthy()
  })

  it('Sync und Review kleben nicht aneinander, Abstand und eigene Zeile wie im Web', () => {
    // T13e, Nebenfund N1: an der Kontosammlung stand am Schirm
    // "Sync account memoriesReview previous cloud copy for removal", eine
    // einzige unterstrichene Zeile, die wie ein Link aussah. Zwei Inline-Knoepfe
    // ohne Luft dazwischen. Das Web setzt an denselben Stellen mr-3 und block
    // (the web app und :277 auf
    // 224f923d). textContent allein beweist hier nichts: Klassen schreiben
    // keinen Text, der Elternknoten klebt die zwei Aufschriften in textContent
    // immer zusammen. Deshalb Elemente, Klassen und die Lesart oben.
    render(<MemorySettings />)
    const sync = screen.getByText('Sync account memories')
    const review = screen.getByText('Review previous cloud copy for removal')
    expect(sync.tagName).toBe('BUTTON')
    expect(review.tagName).toBe('BUTTON')
    expect(sync, 'beide Aufschriften stehen in einem Element').not.toBe(review)
    expect(sync.parentElement).toBe(review.parentElement)
    expect(sync.classList.contains('mr-3'), 'Sync hat keinen Abstand nach rechts').toBe(true)
    expect(review.classList.contains('block'), 'Review steht nicht in eigener Zeile').toBe(true)
    expect(sichtbarerText(sync.parentElement!), 'Sync und Review kleben aneinander').not.toContain('memoriesReview')
  })
})
