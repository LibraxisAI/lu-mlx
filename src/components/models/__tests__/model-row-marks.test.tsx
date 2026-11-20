// @vitest-environment jsdom
/**
 * Die Marken sagen in beiden Apps dasselbe: unzensiert nur gemessen und nur
 * ganz, die Freimenge nur fuer ein Konto, das dafuer zahlt.
 *
 * R5-17: die Zeile zeichnete die Freimengenmarke ohne jede Kontoabfrage. Der
 * Server liefert `flash` an JEDES Konto mit Cloud, abgerechnet wird aber nach
 * `accountPlanPays`. Ein Starter-Konto, das nie gezahlt hat, las damit eine
 * Zusage und bekam die Rechnung.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ModelRowMarks } from '../ModelRowMarks'
import { FLASH_MARK_LABEL } from '../../../lib/flash-entitlement'
import { useCloudAuthStore } from '../../../stores/cloudAuthStore'

const flash = { dailyTokens: 500_000, defaultMaxOutput: 8192, requestSeconds: 240, billingKey: 'k' }

const signIn = (paidPlan: boolean | null) =>
  useCloudAuthStore.getState().setSignedIn(
    { id: 'u1' },
    { licenseActive: true, tier: 'hosted', access: true, quota: null, paidPlan },
  )

beforeEach(() => {
  cleanup()
  useCloudAuthStore.getState().setSignedOut()
})

describe('ModelRowMarks', () => {
  it('marks a measured, fully unfiltered model regardless of the plan', () => {
    render(<ModelRowMarks model={{ unfiltered: 'full' }} />)
    expect(screen.getByText('No Filter')).toBeTruthy()
  })

  // K12 (3.0.1): the Discord report was "can't find it", not "it's wrong":
  // plain text at the smallest size on a crowded row. First answered with an
  // icon and bold type; since the picker of 3.0.5 the mark is a tag of its
  // own, framed by a hairline, and the picker has a chip that narrows the
  // list to the marked models. Since 09.10.2026 the tag is grey: the
  // accent belongs to the statement that shares its place.
  it('is a framed tag, quiet and not plain text (K12)', () => {
    render(<ModelRowMarks model={{ unfiltered: 'full' }} />)
    const mark = screen.getByText('No Filter')
    expect(mark.getAttribute('data-mark')).toBe('unfiltered')
    expect(mark.className).toContain('lu-picker-tag')
    expect(mark.className).not.toContain('is-accent')
    expect(mark.className).not.toContain('is-statement')
    expect(mark.getAttribute('title')).toContain('Measured')
  })

  it('shows the statement at the same place, in the accent tag, and never both words', () => {
    render(<ModelRowMarks model={{ unrestricted: true, unfiltered: 'full' }} />)
    const mark = screen.getByText('Uncensored')
    expect(mark.getAttribute('data-mark')).toBe('statement')
    expect(mark.className).toContain('lu-picker-tag')
    expect(mark.className).toContain('is-statement')
    expect(mark.getAttribute('title')).toContain('Released by its makers')
    expect(screen.queryByText('No Filter')).toBeNull()
    expect(document.querySelectorAll('[data-mark]')).toHaveLength(1)
  })

  it('keeps the statement in a picker row and in a row without a plan', () => {
    render(<ModelRowMarks model={{ unrestricted: true }} row />)
    expect(screen.getByText('Uncensored')).toBeTruthy()
  })

  it('in a picker row shows the measured mark only, the allowance stands behind the question mark', () => {
    signIn(true)
    render(<ModelRowMarks model={{ unfiltered: 'full', flash }} row />)
    expect(screen.getByText('No Filter')).toBeTruthy()
    expect(screen.queryByText(FLASH_MARK_LABEL)).toBeNull()
  })

  it('stays silent on partial and on a model with nothing measured', () => {
    for (const unfiltered of ['partial', undefined] as const) {
      cleanup()
      render(<ModelRowMarks model={{ unfiltered }} />)
      expect(screen.queryByText('No Filter')).toBeNull()
    }
  })

  it('names the daily number the server sent, never a number of its own', () => {
    signIn(true)
    render(<ModelRowMarks model={{ flash }} />)
    expect(screen.getByText(FLASH_MARK_LABEL).getAttribute('title')).toContain('500,000')
  })

  it('carries the wording the owner decided on 12.09.2026, to the character', () => {
    // Die Marke hiess zwischendurch "Included". Sie heisst wieder
    // "No credits", und der Titel ist der eine Satz, den das Web auch traegt.
    // Zeichengleich, weil zwei Apps mit zwei Formulierungen derselben Zusage
    // dem Kunden zwei Zusagen vorlesen.
    expect(FLASH_MARK_LABEL).toBe('No credits')
    signIn(true)
    render(<ModelRowMarks model={{ flash }} />)
    expect(screen.getByText('No credits').getAttribute('title'))
      .toBe('No credits on your plan, up to 500,000 tokens per day.')
  })

  it('carries both marks at once for a paying account', () => {
    signIn(true)
    render(<ModelRowMarks model={{ flash, unfiltered: 'full' }} />)
    expect(screen.getByText('No Filter')).toBeTruthy()
    expect(screen.getByText(FLASH_MARK_LABEL)).toBeTruthy()
  })

  it('promises nothing to an account that pays for these very models', () => {
    signIn(false)
    render(<ModelRowMarks model={{ flash, unfiltered: 'full' }} />)
    expect(screen.queryByText(FLASH_MARK_LABEL)).toBeNull()
    expect(screen.queryByText('No credits')).toBeNull()
    // Die gemessene Marke haengt nicht am Geld und bleibt stehen.
    expect(screen.getByText('No Filter')).toBeTruthy()
  })

  it('promises nothing while the account probe has not answered', () => {
    signIn(null)
    render(<ModelRowMarks model={{ flash }} />)
    expect(screen.queryByText(FLASH_MARK_LABEL)).toBeNull()
  })

  it('shows nothing at all for a model without the free class', () => {
    signIn(true)
    render(<ModelRowMarks model={{}} />)
    expect(screen.queryByText(FLASH_MARK_LABEL)).toBeNull()
    expect(screen.queryByText('No Filter')).toBeNull()
  })
})
