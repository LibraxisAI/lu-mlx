/**
 * @vitest-environment jsdom
 *
 * 3.0.5: a file attached in the Code tab is copied into the folder the coding
 * run works in, and the instruction tells the model its path. The folder is
 * the one the run's jail is pinned to, so the file tools can open the file
 * the message names.
 *
 * Driven through the real `useCodex().sendInstruction`; only the network is
 * replaced. Outside Tauri the fs commands are HTTP calls to the dev server.
 *
 * Run: npx vitest run src/hooks/__tests__/code-files-land-in-the-working-folder.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('../../api/cloud/supabase', () => ({ getAccessToken: async () => 'session-token-abc' }))
vi.mock('../../api/rag', () => ({
  retrieveContext: async () => ({ context: { chunks: [], query: '', documentIds: [] }, scoredChunks: [] }),
  generateEmbeddings: async () => [[0.1, 0.2]],
}))
vi.mock('../../lib/ttsBridge', () => ({ autoSpeak: () => {} }))
vi.mock('../../api/vram-handoff', () => ({ requestGenerationCancel: () => {} }))
vi.mock('../useMemory', () => ({
  useMemory: () => ({ extractAndSave: async () => {} }),
  extractMemoriesFromPair: async () => {},
}))

import { useCodex } from '../useCodex'
import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useProviderStore } from '../../stores/providerStore'
import { useAgentModeStore } from '../../stores/agentModeStore'
import { useCodexStore } from '../../stores/codexStore'
import { useGenerationStore } from '../../stores/generationStore'
import { useChatNoticeStore } from '../../stores/chatNoticeStore'
import { DEFAULT_SETTINGS } from '../../lib/constants'
import { toolRegistry, registerBuiltinTools } from '../../api/mcp'
import type { ChatFileInput } from '../../lib/chat-files'

const MODEL = 'lu-cloud::zai-org/GLM-5.3'
const BYTES = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x00, 0xff])

function attached(): ChatFileInput {
  return {
    attachment: {
      name: 'firmware.bin',
      size: BYTES.length,
      kind: 'ELF executable',
      sha256: 'cd'.repeat(32),
      summary: 'This is a binary file. SUMMARY-MARKER',
    },
    file: new File([BYTES], 'firmware.bin'),
  }
}

interface Upload { path: string; base64: string; offset: number; last: boolean; chatId?: string; workingDirectory?: string }
let uploads: Upload[] = []
let modelRequests: string[] = []

beforeEach(() => {
  uploads = []
  modelRequests = []
  registerBuiltinTools(toolRegistry)
  useChatStore.setState({ conversations: [], activeConversationId: null })
  useCodexStore.setState({ sendsInFlight: 0, threads: {}, workingDirectory: '' })
  useGenerationStore.setState({ generating: {}, aborters: {}, runs: {} })
  useAgentModeStore.setState({ agentModeActive: {}, workspaces: {}, workspaceSlugs: {} })
  useChatNoticeStore.getState().clear()
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, appMode: 'cloud', cavemanMode: 'off' } })
  useProviderStore.setState((s) => ({
    providers: { ...s.providers, 'lu-cloud': { ...s.providers['lu-cloud'], enabled: true } },
  }))
  useModelStore.setState({ models: [], activeModel: MODEL })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/local-api/fs-write-bytes')) {
      uploads.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ status: 'saved' }), { status: 200 })
    }
    if (url.includes('/chat/completions')) {
      modelRequests.push(String(init?.body))
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'It is an ELF binary.' } }] })}\n\ndata: [DONE]\n\n`, {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })
    }
    return new Response('{}', { status: 200 })
  })
})
afterEach(() => vi.restoreAllMocks())

function openCodeChat(): string {
  const convId = useChatStore.getState().createConversation(MODEL, '', 'codex')
  useChatStore.getState().setActiveConversation(convId)
  return convId
}

const userMessage = (convId: string) =>
  useChatStore.getState().conversations.find((c) => c.id === convId)!.messages.find((m) => m.role === 'user' && !m.hidden)!

describe('Code: the attached file is in the working folder of the run', () => {
  it('uploads it into the chat sandbox and names the path in the instruction', async () => {
    const convId = openCodeChat()
    const { result } = renderHook(() => useCodex())
    await act(async () => { await result.current.sendInstruction('what does this binary do?', { files: [attached()] }) })

    expect(uploads).toHaveLength(1)
    expect(uploads[0]).toMatchObject({ path: 'firmware.bin', offset: 0, last: true })
    expect(uploads[0].chatId).toBe(useAgentModeStore.getState().workspaceSlugs[convId])
    expect(uploads[0].workingDirectory).toBeUndefined()
    expect([...atob(uploads[0].base64)].map((c) => c.charCodeAt(0))).toEqual([...BYTES])

    expect(modelRequests.length).toBeGreaterThan(0)
    expect(modelRequests[0]).toContain('[Attached file: firmware.bin]')
    expect(modelRequests[0]).toContain('Path in your working folder: firmware.bin')

    const stored = userMessage(convId)
    expect(stored.displayContent).toBe('what does this binary do?')
    expect(stored.files).toEqual([{ ...attached().attachment, workspacePath: 'firmware.bin' }])
  })

  it('with a project folder picked in the Code tab, that folder gets the file', async () => {
    openCodeChat()
    useCodexStore.setState({ workingDirectory: '/home/me/project' })
    const { result } = renderHook(() => useCodex())
    await act(async () => { await result.current.sendInstruction('look at it', { files: [attached()] }) })
    expect(uploads[0].workingDirectory).toBe('/home/me/project')
  })

  it('NEGATIVE CONTROL: an instruction without files uploads nothing and is stored as typed', async () => {
    const convId = openCodeChat()
    const { result } = renderHook(() => useCodex())
    await act(async () => { await result.current.sendInstruction('list the files') })
    expect(uploads).toEqual([])
    const stored = userMessage(convId)
    expect(stored.content).toBe('list the files')
    expect('files' in stored).toBe(false)
    expect('displayContent' in stored).toBe(false)
  })
})
