/**
 * @vitest-environment jsdom
 *
 * A8 (2.6.8), the second surface: the Coding Agent header.
 *
 * The Remove control in the explorer column is the main one, but that column
 * collapses and remembers that it was collapsed (uiStore). A user sitting in
 * front of a collapsed column sees a folder in the header and no way to let it
 * go, which is exactly the report we got: two people searched, a moderator said
 * "There isn't one". So the header, which always shows the folder, also carries
 * the way to give it back.
 *
 * CodexView is mounted for real here. Everything that talks to a model, a
 * bridge or a microphone is mocked away, because none of it is what this file
 * is about.
 *
 * Run: npx vitest run src/components/chat/__tests__/the-header-can-let-the-folder-go.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

vi.mock('../../../hooks/useCodex', () => ({
  useCodex: () => ({ sendInstruction: () => {}, stopCodex: () => {}, isRunning: false }),
}))
vi.mock('../../../api/backend', () => ({
  checkGitInstalled: async () => ({ installed: true, download_url: '' }),
  openExternal: () => {},
  backendCall: async () => ({ entries: [], truncated: false }),
  isTauri: () => false,
  isMacOS: () => false,
}))
vi.mock('../ChatInput', () => ({ ChatInput: () => null }))
vi.mock('../ExplorerPanel', () => ({ ExplorerPanel: () => null }))
vi.mock('../../models/ModelSelector', () => ({ ModelSelector: () => null }))
vi.mock('../TokenCounter', () => ({ TokenCounter: () => null }))
vi.mock('../ContextDropdown', () => ({ ContextDropdown: () => null }))
vi.mock('../PluginsDropdown', () => ({ PluginsDropdown: () => null }))
vi.mock('../SmallModelModeToggle', () => ({ SmallModelModeToggle: () => null }))
vi.mock('../StagedChangesPanel', () => ({ StagedChangesPanel: () => null }))
vi.mock('../CodexConfirmDialog', () => ({ CodexConfirmDialog: () => null }))

const { CodexView } = await import('../CodexView')
const { useCodexStore } = await import('../../../stores/codexStore')
const { useGenerationStore } = await import('../../../stores/generationStore')
const { useAgentLoopStore } = await import('../../../stores/agentLoopStore')
const { useAgentModeStore } = await import('../../../stores/agentModeStore')
const { useSettingsStore } = await import('../../../stores/settingsStore')
const { useChatStore } = await import('../../../stores/chatStore')
const { useUIStore } = await import('../../../stores/uiStore')
const { DEFAULT_SETTINGS } = await import('../../../lib/constants')

const WINDOWS_PATH = 'C:\\Users\\alice\\Documents\\huge-tree'

// The git probe on mount resolves after the first paint, so every render is
// awaited: without it React logs an act() warning for a state update this file
// does not care about.
const show = async () => {
  let out!: ReturnType<typeof render>
  await act(async () => { out = render(createElement(CodexView)) })
  return out
}
const removeButton = () => screen.queryByTestId('codex-remove-folder')

beforeEach(() => {
  useCodexStore.setState({ workingDirectory: '', threads: {}, sendsInFlight: 0 })
  useGenerationStore.setState({ generating: {} })
  useAgentLoopStore.setState({ loops: {} })
  useAgentModeStore.setState({ workspaces: {} })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
  useChatStore.setState({ conversations: [], activeConversationId: null })
  useUIStore.setState({ explorerCollapsed: false })
})
afterEach(() => cleanup())

describe('the header shows the folder, so it also gives it back', () => {
  it('carries a Remove control while a folder is set', async () => {
    act(() => useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH))
    await show()
    expect(removeButton()).not.toBeNull()
  })

  it('stays reachable while the explorer column is collapsed (S7, the other half)', async () => {
    // The column hides its own Remove control when collapsed; the header is
    // the exit the report asked for, so it must not depend on that state.
    act(() => useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH))
    act(() => useUIStore.getState().setExplorerCollapsed(true))
    await show()
    expect(removeButton()).not.toBeNull()
  })

  it('carries none while the agent is in its sandbox', async () => {
    await show()
    // Negative control: bound to the folder, not always painted.
    expect(removeButton()).toBeNull()
  })

  it('a click empties the store and the header names the fallback instead', async () => {
    act(() => useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH))
    const { container } = await show()
    expect(container.textContent).toContain(WINDOWS_PATH)

    fireEvent.click(removeButton()!)
    expect(useCodexStore.getState().workingDirectory).toBe('')
    expect(container.textContent).not.toContain(WINDOWS_PATH)
    expect(container.textContent).toContain('~/agent-workspace')
  })

  it('and names the workspace that really wins, not a sandbox it will never use', async () => {
    // review S4, the header half.
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, defaultWorkspace: { kind: 'folder', path: '/home/alex/default' } },
    })
    act(() => useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH))
    const { container } = await show()
    fireEvent.click(removeButton()!)
    expect(container.textContent).toContain('/home/alex/default')
    expect(container.textContent).not.toContain('~/agent-workspace')
  })

  it('the empty transcript then says how to pick a new folder', async () => {
    act(() => useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH))
    await show()
    expect(screen.queryByTestId('codex-no-folder-hint')).toBeNull()

    fireEvent.click(removeButton()!)
    const hint = screen.getByTestId('codex-no-folder-hint')
    expect(hint.textContent).toContain('Select folder...')
    expect(hint.textContent).toContain('~/agent-workspace')
  })

  it('is locked with a reason from the first synchronous moment of a send', async () => {
    act(() => {
      useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH)
      useCodexStore.getState().beginSend()
    })
    await show()
    const button = removeButton() as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('title')).toContain('Wait for it to finish or press Stop')

    fireEvent.click(button)
    expect(useCodexStore.getState().workingDirectory).toBe(WINDOWS_PATH)
  })

  it('R2-21: the lock reason is visible, not just a title on a disabled button', async () => {
    // The `title` on a disabled button never shows: disabled elements take no
    // pointer events in Chromium, so the reason was invisible before this fix
    // (same bug as the ExplorerPanel's `explorer-workdir-lock`, review R2-21).
    act(() => {
      useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH)
      useCodexStore.getState().beginSend()
      useUIStore.getState().setExplorerCollapsed(true)
    })
    await show()
    const lock = screen.getByTestId('codex-workdir-lock')
    expect(lock.textContent).toContain('Wait for it to finish or press Stop')
  })

  it('says it once: with the explorer open, only the explorer does', async () => {
    // Both lines stood next to each other in the UX pass 30.09.2026. The
    // explorer's own line is covered by its tests (explorer-workdir-lock).
    act(() => {
      useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH)
      useCodexStore.getState().beginSend()
    })
    await show()
    expect(screen.queryByTestId('codex-workdir-lock')).toBeNull()
  })

  it('and shows no lock line while nothing holds the folder (negative control)', async () => {
    act(() => useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH))
    await show()
    expect(screen.queryByTestId('codex-workdir-lock')).toBeNull()
  })

  it('and lets go again once the run is no longer alive', async () => {
    // Ein Faden bleibt auf 'running' stehen, bis der Lauf sich abgewickelt
    // hat. Haengt der Schwanz des Laufs, sperrte er diesen Knopf bis zum
    // Neustart der App, und der Grund hing als `title` an einem `disabled`
    // Knopf, der ihn nie zeigt.
    act(() => {
      useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH)
      useCodexStore.getState().initThread('conv-1', WINDOWS_PATH)
      useCodexStore.getState().setThreadStatus('conv-1', 'running')
    })
    useGenerationStore.setState({ generating: {} })
    await show()
    const button = removeButton() as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(useCodexStore.getState().workingDirectory).toBe('')
  })

  it('is locked between two loop passes as well', async () => {
    act(() => useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH))
    useAgentLoopStore.setState({
      loops: { 'conv-1': { conversationId: 'conv-1', pass: 2, cap: 0, task: 'go', intervalMs: 30000, nextAt: 0 } },
    })
    await show()
    expect((removeButton() as HTMLButtonElement).getAttribute('title')).toContain('loop')
  })

  it('is NOT locked by a Chat tab streaming somewhere else', async () => {
    act(() => useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH))
    useGenerationStore.setState({ generating: { 'some-other-chat': true } })
    await show()
    expect((removeButton() as HTMLButtonElement).disabled).toBe(false)
  })

  it('and unlocked again once nothing is running', async () => {
    act(() => useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH))
    await show()
    expect((removeButton() as HTMLButtonElement).disabled).toBe(false)
  })
})
