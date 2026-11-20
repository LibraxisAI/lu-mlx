/**
 * DEFAULT, LOCAL and CLOUD beside a backend can be read in the light theme
 * (persona walk, 09.10.2026, Fund 29). The rule holds on every platform.
 *
 * Run: npx vitest run src/lib/__tests__/provider-badge.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { providerBadgeClass, type ProviderBadge } from '../provider-badge'

// The Tailwind palette, sRGB.
const HEX: Record<string, string> = {
  'purple-300': '#d8b4fe', 'purple-500': '#a855f7', 'purple-700': '#7e22ce',
  'green-400': '#4ade80', 'green-500': '#22c55e', 'green-800': '#166534',
  'blue-400': '#60a5fa', 'blue-500': '#3b82f6', 'blue-700': '#1d4ed8',
}
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
const lum = (c: number[]) => {
  const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: number[], b: number[]) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }
/** A tint of `alpha` laid over white. */
const overWhite = (hex: string, alpha: number) => rgb(hex).map((v) => Math.round(v * alpha + 255 * (1 - alpha)))

/** The contrast of a badge in the light theme: its light text on its tint over white. */
function lightContrast(cls: string): number {
  const text = cls.split(' ').find((c) => c.startsWith('text-') && !c.startsWith('text-['))!.replace('text-', '')
  const [, tint, alpha] = cls.match(/bg-([a-z]+-\d+)\/(\d+)/)!
  return contrast(rgb(HEX[text]), overWhite(HEX[tint], Number(alpha) / 100))
}

const BADGES: ProviderBadge[] = ['default', 'local', 'cloud']

/** The colours the marks were first drawn in, for both themes. */
const FIRST: Record<ProviderBadge, string> = {
  default: 'bg-purple-500/15 text-purple-300',
  local: 'bg-green-500/10 text-green-400',
  cloud: 'bg-blue-500/10 text-blue-400',
}

describe('in the light theme', () => {
  it('each mark reaches 4.5 to 1 on white', () => {
    for (const badge of BADGES) expect(lightContrast(providerBadgeClass(badge)), badge).toBeGreaterThanOrEqual(4.5)
  })

  it('COUNTER-CHECK: the first colours are the ones that could not be read', () => {
    for (const badge of BADGES) expect(lightContrast(FIRST[badge]), badge).toBeLessThan(3)
  })
})

describe('in the dark theme', () => {
  it('each mark keeps the colour it had', () => {
    expect(providerBadgeClass('default')).toContain('dark:text-purple-300')
    expect(providerBadgeClass('local')).toContain('dark:text-green-400')
    expect(providerBadgeClass('cloud')).toContain('dark:text-blue-400')
  })

  it('and the tint it had', () => {
    for (const badge of BADGES) expect(providerBadgeClass(badge).split(' ')).toContain(FIRST[badge].split(' ')[0])
  })
})

describe('the backend list', () => {
  it('draws its three marks through this module, and asks no platform', () => {
    const source = readFileSync(resolve(__dirname, '../../components/settings/ProviderConfig.tsx'), 'utf-8')
    for (const badge of BADGES) expect(source).toContain(`providerBadgeClass('${badge}')`)
    expect(source).not.toMatch(/text-purple-300 shrink-0">DEFAULT/)
    expect(providerBadgeClass.length).toBe(1)
  })
})
