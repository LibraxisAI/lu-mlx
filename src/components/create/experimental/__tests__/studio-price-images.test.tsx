// @vitest-environment jsdom
// Der Vorab-Preis im Create-Tab nennt die Bildzahl, die der Start schickt
// (Endpruefung 02.10.2026, MiniMax H3 Reference rechnet je Referenzbild).
//
// Desktop: die Bildzahl geht als `quote_images` nur an einen Server, der sie
// kennt. Das sagt er selbst, sein Katalog fuehrt dann `tier`. Der Server von
// heute ignorierte das Feld und lehnte ein Modell mit Pflichtbild vor dem
// Hochladen mit 400 ab, und das sperrte den Startknopf. Dort steht stattdessen
// die Formel-Vorschau, und die Buchung holt ihre bestaetigte Zahl nach dem
// Hochladen (useCloudCreate).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useStudioPrice } from '../useStudioPrice'
import { useCloudCatalogStore } from '../../../../stores/cloudCatalogStore'
import { alterServer, neuerServer } from '../../../../lib/render/__tests__/fixtures/test-catalogs'

const hoisted = vi.hoisted(() => ({ studioQuote: vi.fn() }))
vi.mock('../../../../api/cloud/studio', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../api/cloud/studio')>()),
  studioQuote: hoisted.studioQuote,
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  hoisted.studioQuote.mockReset()
})

describe('mit dem Katalog des neuen Servers', () => {
  beforeEach(() => { useCloudCatalogStore.setState({ models: neuerServer() }) })

  it('ein Modell mit Bildvorlage fragt mit quote_images 1', async () => {
    hoisted.studioQuote.mockResolvedValue({ credits: 13500 })
    const { result } = renderHook(() => useStudioPrice('minimax-h3-ref', { duration: 5, resolution: '480p' }, 'a runner', undefined))
    await waitFor(() => expect(result.current?.live).toBe(true), { timeout: 3000 })
    expect(hoisted.studioQuote.mock.calls[0][3]).toBe(1)
    expect(result.current?.credits).toBe(13500)
  })

  it('ein Modell ohne Bildvorlage schickt keine Bildzahl', async () => {
    hoisted.studioQuote.mockResolvedValue({ credits: 8000 })
    const { result } = renderHook(() => useStudioPrice('minimax-h3-t2v', { duration: 5, resolution: '480p' }, 'a runner', undefined))
    await waitFor(() => expect(result.current?.live).toBe(true), { timeout: 3000 })
    expect(hoisted.studioQuote.mock.calls[0][3]).toBeUndefined()
  })

  it('die Schaetzung ohne Antwort rechnet mit derselben Bildzahl', async () => {
    hoisted.studioQuote.mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useStudioPrice('minimax-h3-ref', { duration: 5, resolution: '480p' }, 'x', undefined))
    expect(result.current?.live).toBe(false)
    expect(result.current?.credits).toBeGreaterThan(0)
    await act(async () => { await Promise.resolve() })
  })
})

describe('mit dem Katalog des Servers von heute', () => {
  beforeEach(() => { useCloudCatalogStore.setState({ models: alterServer() }) })

  it('ein Modell mit Pflichtbild fragt vor dem Hochladen nicht an, und sperrt nichts', async () => {
    // minimax-h3-edit liest ein Pflichtbild und stand schon im alten Katalog.
    vi.useFakeTimers()
    const { result } = renderHook(() => useStudioPrice('minimax-h3-edit', { resolution: '480p' }, 'make it dusk', undefined))
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(hoisted.studioQuote).not.toHaveBeenCalled()
    expect(result.current?.error).toBeUndefined()
    expect(result.current?.live).toBe(false)
    expect(result.current?.credits).toBeGreaterThan(0)
  })

  it('ein Modell aus Worten allein fragt wie gehabt, ohne Bildzahl', async () => {
    hoisted.studioQuote.mockResolvedValue({ credits: 4000 })
    const { result } = renderHook(() => useStudioPrice('z-image', {}, 'a runner', undefined))
    await waitFor(() => expect(result.current?.live).toBe(true), { timeout: 3000 })
    expect(hoisted.studioQuote.mock.calls[0][3]).toBeUndefined()
    expect(result.current?.credits).toBe(4000)
  })

  it('ein Videomodell mit Pflichtbild fragt ebenfalls nicht vor dem Hochladen an', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useStudioPrice('wan-3.0', { duration: 5, resolution: '720p' }, 'a runner', undefined))
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(hoisted.studioQuote).not.toHaveBeenCalled()
    expect(result.current?.error).toBeUndefined()
  })
})
