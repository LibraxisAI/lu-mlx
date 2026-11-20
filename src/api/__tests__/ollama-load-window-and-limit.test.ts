import { describe, it, expect, vi, beforeEach } from 'vitest'

// Handtest Mac 10.10.2026, Ollama ("Other"): the load button of a second model
// sat in "loading" until the app was quit. Ollama's own log shows why. The
// model that was still resident had just been reloaded with -c 262144 by a
// /api/chat that carried the user's context override, and the load request of
// the second model waited behind that busy runner for 1 min 18 s with nothing
// on the app side to end the wait.
//
// These tests show the two halves that live in loadModel. They were written
// red, as a probe (branch probe/load-b), and are kept as they were.
//
// On the first one: the window loadModel sends is the window the chat sends
// next, whatever that is. With the override of the hand test that is 262144,
// which looks like the very number that caused the reload. It is not the
// cause: the reload came from two calls to ONE model carrying two windows.
// The third test below pins the same rule without an override.

vi.mock('../backend', async () => {
  const actual = await vi.importActual<typeof import('../backend')>('../backend')
  return {
    ...actual,
    localFetch: vi.fn(),
    isTauri: () => false,
    ollamaUrl: (p: string) => `http://localhost:11434/api${p.startsWith('/') ? p : '/' + p}`,
  }
})

import { localFetch } from '../backend'
import { loadModel } from '../ollama'
import { effectiveContextWindow } from '../../lib/context-window'
import { useSettingsStore } from '../../stores/settingsStore'

type LocalFetchInit = Parameters<typeof localFetch>[1]
const mockedFetch = localFetch as unknown as ReturnType<typeof vi.fn>

/** The window the user picked in the context dropdown ("max" of a 262144 model). */
const OVERRIDE = 262144

function lastCall(): { body: Record<string, unknown>; init: LocalFetchInit } {
  const [, init] = mockedFetch.mock.calls[mockedFetch.mock.calls.length - 1] as [string, LocalFetchInit]
  const body: Record<string, unknown> = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
  return { body, init }
}

describe('loadModel against the chat that follows it', () => {
  beforeEach(() => {
    mockedFetch.mockReset()
    mockedFetch.mockResolvedValue(new Response(JSON.stringify({ done: true }), { status: 200 }))
    useSettingsStore.getState().updateSettings({ contextWindowOverride: OVERRIDE })
  })

  it('asks Ollama for the same num_ctx the next chat request will carry', async () => {
    await loadModel('some-model:9b')
    const { body } = lastCall()
    // What useChat sends on the very next turn (useChat.ts, effectiveCtx).
    const chatWindow = effectiveContextWindow(OVERRIDE, useSettingsStore.getState().settings.contextWindowOverride)
    const loadWindow = (body.options as { num_ctx?: number } | undefined)?.num_ctx
    // Today: undefined. Ollama then loads with its own default, and the first
    // chat with another num_ctx throws that runner away and loads again.
    expect(loadWindow).toBe(chatWindow)
  })

  it('without an override it asks for the chat window of that model, not for the agent one', async () => {
    useSettingsStore.getState().updateSettings({ contextWindowOverride: 0 })
    // /api/show of a model trained on 131072 tokens, then the load itself.
    mockedFetch.mockImplementation(async (url: string) => new Response(
      JSON.stringify(url.endsWith('/show') ? { model_info: { 'general.context_length': 131072 } } : { done: true }),
      { status: 200 },
    ))
    await loadModel('trained-on-131072:9b')
    const { body } = lastCall()
    expect((body.options as { num_ctx?: number }).num_ctx).toBe(effectiveContextWindow(131072, 0))
    expect((body.options as { num_ctx?: number }).num_ctx).toBe(16384)
  })

  it('does not wait without a limit when Ollama cannot make room', async () => {
    await loadModel('some-model:9b')
    const { init } = lastCall()
    // Today: neither. The Rust proxy then waits its default of 300 s, and the
    // button that awaits this call cannot be cancelled by anything.
    expect(init?.timeoutMs ?? init?.signal).toBeDefined()
  })
})
