// @vitest-environment jsdom
/**
 * R5-32: was der Kunde ins Erinnerungsformular tippt, verschwindet nicht stumm.
 *
 * Zwei Haelften desselben Fundes, und beide kommen beim Kunden an:
 *
 *   1. `addMemory` sperrte gegen JEDEN inhaltsgleichen Eintrag, auch gegen
 *      einen veralteten, einen abgeloesten und einen mit der anderen Marke.
 *      Das sind genau die Datensaetze, die der Kunde in der Liste nicht mehr
 *      sieht, also wurde er gegen einen Zwilling abgewiesen, den es fuer ihn
 *      nicht gibt. Das Web hat die drei Bedingungen schon
 *      (the web app).
 *   2. Die Aufrufstelle las den Rueckgabewert nicht. Bei einer Abweisung
 *      leerte sie trotzdem beide Felder und schloss das Formular, also sah die
 *      Oberflaeche aus wie nach einem erfolgreichen Speichern, waehrend der
 *      Text weg war.
 *
 * Run: npx vitest run src/components/settings/__tests__/das-erinnerungsformular-verschluckt-nichts.test.tsx
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useMemoryStore, __setMemoryEmbedFn } from '../../../stores/memoryStore'
import type { MemoryFile } from '../../../types/agent-mode'
import { MemorySettings } from '../MemorySettings'

const ZWILLING: MemoryFile = {
  id: 'zwilling',
  type: 'user',
  title: 'Arbeitet auf Deutsch',
  description: 'Der Kunde schreibt auf Deutsch',
  content: 'Der Kunde schreibt auf Deutsch.',
  tags: [],
  source: 'manual',
  createdAt: 1,
  updatedAt: 1,
}

const store = () => useMemoryStore.getState()

/** Das Formular oeffnen und beide Felder fuellen, wie ein Kunde es tut. */
function tippen(titel: string, inhalt: string) {
  fireEvent.click(screen.getByText('Add Memory'))
  fireEvent.change(screen.getByPlaceholderText('What should I remember?'), { target: { value: titel } })
  fireEvent.change(screen.getByPlaceholderText('Details… (required)'), { target: { value: inhalt } })
  fireEvent.click(screen.getByText('Save'))
}

beforeEach(() => {
  cleanup()
  __setMemoryEmbedFn(async () => [])
  useMemoryStore.setState({ entries: [], localEntries: [], activeMemoryOwner: null })
})

describe('das Erinnerungsformular', () => {
  it('HAUPTFALL: ein veralteter Zwilling blockiert die Neuaufnahme nicht mehr', () => {
    useMemoryStore.setState({ entries: [{ ...ZWILLING, stale: true }] })
    render(<MemorySettings />)

    tippen('Arbeitet auf Deutsch', ZWILLING.content)

    expect(store().entries.filter((e) => !e.stale)).toHaveLength(1)
    expect(store().entries.filter((e) => !e.stale)[0].content).toBe(ZWILLING.content)
  })

  it('HAUPTFALL: ein abgeloester Zwilling blockiert die Neuaufnahme nicht mehr', () => {
    useMemoryStore.setState({ entries: [{ ...ZWILLING, supersededBy: 'neuer' }] })
    render(<MemorySettings />)

    tippen('Arbeitet auf Deutsch', ZWILLING.content)

    expect(store().entries).toHaveLength(2)
  })

  it('HAUPTFALL: ein sensibel markierter Zwilling ist ein anderer Datensatz', () => {
    useMemoryStore.setState({ entries: [{ ...ZWILLING, sensitive: true }] })
    render(<MemorySettings />)

    tippen('Arbeitet auf Deutsch', ZWILLING.content)

    expect(store().entries).toHaveLength(2)
    expect(store().entries.filter((e) => e.sensitive === true)).toHaveLength(1)
  })

  it('NEGATIVKONTROLLE: ein wirklich gleicher Eintrag wird weiter abgewiesen', () => {
    useMemoryStore.setState({ entries: [ZWILLING] })
    render(<MemorySettings />)

    tippen('Arbeitet auf Deutsch', ZWILLING.content)

    expect(store().entries).toHaveLength(1)
  })

  it('NEGATIVKONTROLLE: und der Kunde liest jetzt, warum, statt in ein leeres Feld zu sehen', () => {
    useMemoryStore.setState({ entries: [ZWILLING] })
    render(<MemorySettings />)

    tippen('Arbeitet auf Deutsch', ZWILLING.content)

    expect(screen.getByText('This memory is already saved.')).toBeTruthy()
    // Das Formular steht noch offen und haelt den Text, den der Kunde getippt
    // hat. Genau das ging vorher verloren.
    expect((screen.getByPlaceholderText('What should I remember?') as HTMLInputElement).value)
      .toBe('Arbeitet auf Deutsch')
    expect((screen.getByPlaceholderText('Details… (required)') as HTMLTextAreaElement).value)
      .toBe(ZWILLING.content)
  })

  it('POSITIVKONTROLLE: ohne Zwilling speichert das Formular und raeumt sich auf', () => {
    render(<MemorySettings />)

    tippen('Neue Sache', 'Etwas, das noch nicht in der Sammlung steht.')

    expect(store().entries).toHaveLength(1)
    expect(screen.queryByPlaceholderText('What should I remember?')).toBeNull()
    expect(screen.getByText('Add Memory')).toBeTruthy()
  })
})
