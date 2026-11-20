import { describe, it, expect, beforeEach } from 'vitest'
import { useCodexConfirmStore } from '../codexConfirmStore'

// The gate used to be window.confirm, which blocks the whole webview and cannot
// be styled or dismissed with "stop asking". This store is the bridge that lets
// an in-app popup answer the same awaited boolean.

const req = (command: string, cloudReason = false) => ({
  toolName: 'shell_execute',
  command,
  cloudReason,
})

beforeEach(() => {
  useCodexConfirmStore.setState({ pending: null, resolve: null, queue: [] })
})

describe('codexConfirmStore', () => {
  it('parks the request and resolves true on Run', async () => {
    const p = useCodexConfirmStore.getState().ask(req('ls -la'))
    expect(useCodexConfirmStore.getState().pending?.command).toBe('ls -la')
    useCodexConfirmStore.getState().answer(true)
    await expect(p).resolves.toBe(true)
  })

  it('resolves false on No', async () => {
    const p = useCodexConfirmStore.getState().ask(req('rm -rf /'))
    useCodexConfirmStore.getState().answer(false)
    await expect(p).resolves.toBe(false)
  })

  it('clears the pending request once answered, so the popup closes', () => {
    void useCodexConfirmStore.getState().ask(req('echo hi'))
    useCodexConfirmStore.getState().answer(true)
    expect(useCodexConfirmStore.getState().pending).toBeNull()
    expect(useCodexConfirmStore.getState().resolve).toBeNull()
  })

  // Bug hunt 01.10.2026 (C4). A second request used to answer the first "no"
  // and take its place: a command the user never saw was refused in their
  // name. Two runs in two conversations, or a run and its sub-agent, ask at
  // the same time. The second waits behind the first; nobody is stranded.
  it('a second request waits behind the first instead of refusing it', async () => {
    let firstAnswer: boolean | null = null
    const first = useCodexConfirmStore.getState().ask(req('first')).then((a) => { firstAnswer = a; return a })
    const second = useCodexConfirmStore.getState().ask(req('second'))
    await Promise.resolve()
    expect(firstAnswer).toBeNull()
    expect(useCodexConfirmStore.getState().pending?.command).toBe('first')

    useCodexConfirmStore.getState().answer(true)
    await expect(first).resolves.toBe(true)
    expect(useCodexConfirmStore.getState().pending?.command).toBe('second')

    useCodexConfirmStore.getState().answer(false)
    await expect(second).resolves.toBe(false)
    expect(useCodexConfirmStore.getState().pending).toBeNull()
  })

  it('a stopped run takes only its own request out of the line', async () => {
    const ac = new AbortController()
    const first = useCodexConfirmStore.getState().ask(req('first'))
    const second = useCodexConfirmStore.getState().ask(req('second'), ac.signal)
    const third = useCodexConfirmStore.getState().ask(req('third'))
    ac.abort()
    await expect(second).resolves.toBe(false)
    expect(useCodexConfirmStore.getState().queue.map((w) => w.req.command)).toEqual(['first', 'third'])
    useCodexConfirmStore.getState().answer(true)
    await expect(first).resolves.toBe(true)
    expect(useCodexConfirmStore.getState().pending?.command).toBe('third')
    useCodexConfirmStore.getState().answer(true)
    await expect(third).resolves.toBe(true)
  })

  it('carries the cloud reason through, since it picks which setting to clear', () => {
    void useCodexConfirmStore.getState().ask(req('whoami', true))
    expect(useCodexConfirmStore.getState().pending?.cloudReason).toBe(true)
  })

  it('answering with nothing pending does not throw', () => {
    expect(() => useCodexConfirmStore.getState().answer(true)).not.toThrow()
  })
})
