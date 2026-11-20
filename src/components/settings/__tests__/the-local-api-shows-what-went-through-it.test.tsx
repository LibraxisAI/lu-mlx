// @vitest-environment jsdom
/**
 * GH Discussion #4 (2026-09-22): "If I connect an IDE with the Local
 * API, I really would appreciate some statistics like connections or context
 * (tokens, etc.)." The panel now shows what went through the API since it
 * started; the counting itself is tested in commands/local_api.rs.
 *
 * Run: npx vitest run src/components/settings/__tests__/the-local-api-shows-what-went-through-it.test.tsx
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

const usage = {
  since: Date.now() - 600_000, requests: 1234, failed: 2, active: 1,
  promptTokens: 48_210, completionTokens: 9_034, withoutCounts: 3,
  lastModel: 'ollama/qwen3:8b', lastAt: Date.now() - 5_000,
}
const backendCall = vi.fn(async (cmd: string) => (cmd === 'local_api_usage' ? usage : cmd === 'local_api_status' ? { running: true } : null))
vi.mock('../../../api/backend', async (o) => ({
  ...(await o<typeof import('../../../api/backend')>()),
  isTauri: () => true,
  backendCall: (...a: unknown[]) => backendCall(...(a as [string])),
}))

import { LocalApiSettings } from '../LocalApiSettings'
import { useLocalApiStore } from '../../../stores/localApiStore'
import { nutzungZeilen, ohneZahlenText } from '../../../lib/local-api'

beforeEach(() => {
  cleanup()
  backendCall.mockClear()
  useLocalApiStore.setState({ laeuft: true, token: 'abc', auffrischen: async () => {} } as never)
})

describe('the Local API panel', () => {
  it('shows requests, running, tokens and the last model while it runs', async () => {
    render(<LocalApiSettings />)
    await screen.findByTestId('local-api-usage')
    expect(screen.getByText('1,234 (2 failed)')).toBeTruthy()
    // Says what it counts: calls that reach a model, not the model list.
    expect(screen.getByText('Model requests')).toBeTruthy()
    expect(screen.getByText('48,210')).toBeTruthy()
    expect(screen.getByText('9,034')).toBeTruthy()
    expect(screen.getByText('ollama/qwen3:8b, just now')).toBeTruthy()
    expect(screen.getByText('3 answers came without token counts from the model server, so the totals above leave them out.')).toBeTruthy()
  })

  // Negative control: a stopped API asks for nothing and shows nothing.
  it('shows nothing and asks nothing while stopped', () => {
    useLocalApiStore.setState({ laeuft: false } as never)
    render(<LocalApiSettings />)
    expect(screen.queryByTestId('local-api-usage')).toBeNull()
    expect(backendCall.mock.calls.filter((c) => c[0] === 'local_api_usage')).toHaveLength(0)
  })

  it('a clean run has no failed count and no missing-counts line', () => {
    const clean = { ...usage, failed: 0, withoutCounts: 0, lastModel: null, lastAt: null }
    expect(nutzungZeilen(clean, Date.now())[0].wert).toBe('1,234')
    expect(nutzungZeilen(clean, Date.now())[4].wert).toBe('none yet')
    expect(ohneZahlenText(clean)).toBeNull()
  })
})
