/**
 * @vitest-environment jsdom
 *
 * GH #140 (Code Agent, Windows 3.0.2): neither Stop worked, not the big one
 * next to the prompt box and not the one in the blue /loop bar. Both buttons
 * got `stopCodex` handed straight to `onClick`, so React called it with the
 * click EVENT, `stopCodex` took that for the conversation to stop, and the
 * event matched no run, no loop and no timer. The plain chat was fine only
 * because its `stopGeneration` takes no argument at all.
 *
 * The second half of the report: a loop whose pass ended before it reached
 * its driver kept the bar on "running" and the working folder locked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { useCodex } from '../useCodex'
import { LoopBar } from '../../components/chat/LoopBar'
import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useCodexStore } from '../../stores/codexStore'
import { endLoopUnlessRearmed, useAgentLoopStore } from '../../stores/agentLoopStore'
import { useGenerationStore } from '../../stores/generationStore'
import { __resetRunStopsForTests, isRunStopped } from '../../lib/run-stop'

const MODEL = 'ollama::qwen3:14b'

function standingLoop(conversationId: string) {
  useAgentLoopStore.getState().start({
    conversationId, pass: 3, cap: 0, task: 'fix the tests', intervalMs: 30_000, nextAt: Date.now() - 1000,
  })
}

beforeEach(() => {
  __resetRunStopsForTests()
  useChatStore.setState({ conversations: [], activeConversationId: null })
  useCodexStore.setState({ sendsInFlight: 0, threads: {}, workingDirectory: '' })
  useAgentLoopStore.setState({ loops: {} })
  useGenerationStore.setState({ generating: {}, aborters: {}, runs: {} })
  useModelStore.setState({ models: [], activeModel: MODEL })
})
afterEach(() => vi.restoreAllMocks())

describe('Stop in the Code view', () => {
  it('stops the run and the loop when handed the click event (the #140 wiring)', () => {
    const convId = useChatStore.getState().createConversation(MODEL, '', 'codex')
    useChatStore.getState().setActiveConversation(convId)
    const abort = vi.fn()
    useGenerationStore.getState().registerAborter(convId, abort)
    standingLoop(convId)

    const { result } = renderHook(() => useCodex())
    // Exactly what `onClick={stopCodex}` did: React passes the event.
    const click = new MouseEvent('click') as unknown as string
    act(() => { result.current.stopCodex(click) })

    expect(abort).toHaveBeenCalled()
    expect(isRunStopped(convId)).toBe(true)
    expect(useAgentLoopStore.getState().loops[convId]).toBeUndefined()
  })

  it('COUNTER-CHECK: a named conversation is still the one stopped', () => {
    const convA = useChatStore.getState().createConversation(MODEL, '', 'codex')
    const convB = useChatStore.getState().createConversation(MODEL, '', 'codex')
    useChatStore.getState().setActiveConversation(convB)
    standingLoop(convA)
    const { result } = renderHook(() => useCodex())
    act(() => { result.current.stopCodex(convA) })
    expect(isRunStopped(convA)).toBe(true)
    expect(isRunStopped(convB)).toBe(false)
    expect(useAgentLoopStore.getState().loops[convA]).toBeUndefined()
  })

  it('the loop bar calls Stop with no argument', () => {
    const convId = useChatStore.getState().createConversation(MODEL, '', 'codex')
    useChatStore.getState().setActiveConversation(convId)
    standingLoop(convId)
    const onStop = vi.fn()
    render(<LoopBar onStop={onStop} />)
    fireEvent.click(screen.getByTitle('Stop the loop'))
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onStop.mock.calls[0]).toEqual([])
  })

  it('the prompt box Stop does not hand its event on either', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'components', 'chat', 'ChatInput.tsx'), 'utf8')
    expect(src).not.toMatch(/onClick=\{onStop\}/)
    expect(src).toContain('onClick={() => onStop()}')
  })
})

describe('a loop whose pass ended early does not stay "running"', () => {
  it('a pass that settles without arming the next one ends the loop', async () => {
    standingLoop('conv-1')
    await endLoopUnlessRearmed('conv-1', Promise.resolve(), () => false)
    expect(useAgentLoopStore.getState().loops['conv-1']).toBeUndefined()
  })

  it('also when the pass threw, and the throw still reaches the caller', async () => {
    standingLoop('conv-1')
    await expect(endLoopUnlessRearmed('conv-1', Promise.reject(new Error('boom')), () => false)).rejects.toThrow('boom')
    expect(useAgentLoopStore.getState().loops['conv-1']).toBeUndefined()
  })

  it('also when there was no pass to start at all', async () => {
    standingLoop('conv-1')
    await endLoopUnlessRearmed('conv-1', undefined, () => false)
    expect(useAgentLoopStore.getState().loops['conv-1']).toBeUndefined()
  })

  it('COUNTER-CHECK: a pass that armed the next one keeps its bar', async () => {
    standingLoop('conv-1')
    await endLoopUnlessRearmed('conv-1', Promise.resolve(), () => true)
    expect(useAgentLoopStore.getState().loops['conv-1']).toBeDefined()
  })
})
