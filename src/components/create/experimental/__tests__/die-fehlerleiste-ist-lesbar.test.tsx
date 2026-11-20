// @vitest-environment jsdom
/**
 * Die rote Leiste der Create-Oberflaeche zeigt die GANZE Meldung.
 *
 * GitHub #121 und (04.09.2026): der Trainer starb mit
 * "RuntimeError: use_libuv was requested but PyTorch was build without libuv
 * support", und die Leiste schnitt den Satz ab, auch im breiten Fenster. Der
 * Melder konnte den Fehler weder lesen noch kopieren. d5f5b32 hat die Notiz
 * unter den Character-Studio-Knoepfen geheilt; das hier ist die zweite
 * Flaeche, auf der ein gescheiterter LAUF landet.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { BannerText } from '../BannerText'

const MELDUNG = [
  'Training failed.',
  'Traceback (most recent call last):',
  ...Array.from({ length: 40 }, (_, i) => `  File "zimage_train_network.py", line ${i + 1}, in <module>`),
  'RuntimeError: use_libuv was requested but PyTorch was build without libuv support',
].join('\n')

const schreiben = vi.fn(async () => {})

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: schreiben },
    configurable: true,
  })
})

describe('the error bar on the Create surface', () => {
  it('shows the last line of a traceback, not only the first', () => {
    render(<BannerText text={MELDUNG} />)
    const text = screen.getByTestId('create-error-text')
    expect(text.textContent).toBe(MELDUNG)
    expect(text.textContent).toContain('use_libuv was requested but PyTorch was build without libuv support')
  })

  it('scrolls and lets the text be selected instead of cutting it', () => {
    render(<BannerText text={MELDUNG} />)
    const kasten = screen.getByTestId('create-error-text')
    expect(kasten.className).not.toContain('truncate')
    expect(kasten.className).not.toContain('line-clamp')
    for (const k of ['overflow-y-auto', 'select-text', 'whitespace-pre-wrap', 'break-words', 'max-h-40']) {
      expect(kasten.className).toContain(k)
    }
    // Ohne tabindex kann die Tastatur den Kasten nicht rollen.
    expect(kasten.getAttribute('tabindex')).toBe('0')
  })

  it('copies the whole message, not the visible part', async () => {
    render(<BannerText text={MELDUNG} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy error' }))
    await waitFor(() => expect(schreiben).toHaveBeenCalledWith(MELDUNG))
    await screen.findByText('Copied')
  })

  it('is what the red bar actually renders', () => {
    const src = readFileSync(resolve(__dirname, '..', 'CreateExperimental.tsx'), 'utf8')
    expect(src).toContain('<BannerText text={banner} />')
    expect(src).not.toContain('block truncate')
  })

  it('gets the whole failure from the run, not three log lines cut at 420 characters', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', '..', '..', 'hooks', 'useCreate.ts'), 'utf8')
    const lauf = src.slice(src.indexOf('await startCharacterTraining('))
    const zweig = lauf.slice(0, lauf.indexOf('} catch (e) {'))
    expect(zweig).toContain("setError(detail ? `Training failed.\\n${detail}` : 'Training failed.')")
    expect(zweig).not.toContain('.slice(0, 420)')
    expect(zweig).not.toContain("s.logs.slice(-3).join(' ')")
  })
})
