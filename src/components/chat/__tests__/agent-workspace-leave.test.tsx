// @vitest-environment jsdom
/**
 * Bug E, a user 01.09.2026: der Agent stand in einem riesigen Baum,
 * "in dem er nichts zu suchen hat", und es gab keinen Weg hinaus. Ordner
 * wechseln half nicht, weil ein einmal gemerkter Vorgabeordner die Frage in
 * jedem neuen Agentenchat ueberspringt.
 *
 * Zwei Ausgaenge, zwei Faelle: die Plakette verlaesst den Ordner dieser
 * Unterhaltung, der Dialog vergisst den gemerkten Vorgabeordner.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AgentWorkspaceBadge } from '../AgentWorkspaceBadge'
import { useAgentModeStore } from '../../../stores/agentModeStore'
import { useChatStore } from '../../../stores/chatStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import { resolveWorkspace } from '../../../api/agents/workspace-resolve'

const CONV = 'conv-e'

beforeEach(() => {
  cleanup()
  useChatStore.setState({ activeConversationId: CONV })
  useAgentModeStore.setState({
    agentModeActive: { [CONV]: true },
    workspaces: { [CONV]: { kind: 'folder', path: '/Users/x/enormous-monorepo' } },
  })
  useSettingsStore.getState().updateSettings({ defaultWorkspace: null })
})

/** Was der Agent nach dem Klick wirklich sieht, beide Schichten zusammen. */
function effectiveWorkspace() {
  return resolveWorkspace({
    perChat: useAgentModeStore.getState().workspaces[CONV],
    defaultWorkspace: useSettingsStore.getState().settings.defaultWorkspace,
  })
}

describe('leaving a workspace', () => {
  it('shows the folder and an explicit way out', () => {
    render(<AgentWorkspaceBadge />)
    expect(screen.getByText('enormous-monorepo')).toBeTruthy()
    expect(screen.getByTestId('agent-workspace-leave')).toBeTruthy()
  })

  it('really drops the workspace, it does not just hide the pill', () => {
    render(<AgentWorkspaceBadge />)
    fireEvent.click(screen.getByTestId('agent-workspace-leave'))
    expect(useAgentModeStore.getState().workspaces[CONV]).toBeUndefined()
    expect(screen.queryByText('enormous-monorepo')).toBeNull()
    // Der Agentenmodus selbst bleibt an: der Nutzer wollte den ORDNER los,
    // nicht den Modus.
    expect(useAgentModeStore.getState().agentModeActive[CONV]).toBe(true)
  })

  it('leaves other conversations alone', () => {
    useAgentModeStore.setState({
      workspaces: {
        [CONV]: { kind: 'folder', path: '/Users/x/enormous-monorepo' },
        other: { kind: 'sandbox' },
      },
    })
    render(<AgentWorkspaceBadge />)
    fireEvent.click(screen.getByTestId('agent-workspace-leave'))
    expect(useAgentModeStore.getState().workspaces.other).toEqual({ kind: 'sandbox' })
  })
})

/**
 * R2-1: das x loeschte nur den Eintrag je Chat. workspace-resolve.ts faellt
 * danach sofort auf settings.defaultWorkspace zurueck, und AgentModeToggle
 * steigt bei gesetztem Vorgabeordner ohne Dialog aus. Der Agent behielt damit
 * Schreib- und Shellzugriff auf einen Baum, den der Nutzer gerade verlassen
 * hatte, und der einzige Knopf dagegen lag hinter einem Dialog, den niemand
 * mehr oeffnen konnte.
 */
describe('leaving while a default workspace is remembered', () => {
  it('opens the dialog that owns Forget it, and forgetting really empties both layers', () => {
    useSettingsStore.getState().updateSettings({
      defaultWorkspace: { kind: 'folder', path: '/Users/x/enormous-monorepo' },
    })
    render(<AgentWorkspaceBadge />)
    fireEvent.click(screen.getByTestId('agent-workspace-leave'))

    // Der Eintrag je Chat ist weg, der Vorgabeordner wuerde aber nachruecken.
    expect(useAgentModeStore.getState().workspaces[CONV]).toBeUndefined()
    expect(effectiveWorkspace()).toEqual({ kind: 'folder', path: '/Users/x/enormous-monorepo' })

    expect(screen.getByTestId('agent-workspace-default-note').textContent)
      .toContain('/Users/x/enormous-monorepo')
    fireEvent.click(screen.getByTestId('agent-workspace-forget-default'))

    expect(useSettingsStore.getState().settings.defaultWorkspace).toBeNull()
    expect(effectiveWorkspace()).toBeNull()
  })

  it('stays quiet without a remembered default, and the agent is nowhere', () => {
    render(<AgentWorkspaceBadge />)
    fireEvent.click(screen.getByTestId('agent-workspace-leave'))

    expect(screen.queryByTestId('agent-workspace-default-note')).toBeNull()
    expect(screen.queryByTestId('agent-workspace-options')).toBeNull()
    expect(effectiveWorkspace()).toBeNull()
  })
})

describe('the remembered default', () => {
  it('can be forgotten, so a new agent chat asks again', async () => {
    useSettingsStore.getState().updateSettings({
      defaultWorkspace: { kind: 'folder', path: '/Users/x/enormous-monorepo' },
    })
    const { AgentWorkspaceDialog } = await import('../AgentWorkspaceDialog')
    render(
      <AgentWorkspaceDialog
        open
        conversationId={CONV}
        initialWorkspace={{ kind: 'folder', path: '/Users/x/enormous-monorepo' }}
        onChoose={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByTestId('agent-workspace-default-note').textContent)
      .toContain('/Users/x/enormous-monorepo')
    fireEvent.click(screen.getByTestId('agent-workspace-forget-default'))
    expect(useSettingsStore.getState().settings.defaultWorkspace).toBeNull()
    expect(screen.queryByTestId('agent-workspace-default-note')).toBeNull()
  })

  it('says nothing when no default is remembered', async () => {
    useSettingsStore.getState().updateSettings({ defaultWorkspace: null })
    const { AgentWorkspaceDialog } = await import('../AgentWorkspaceDialog')
    render(
      <AgentWorkspaceDialog
        open
        conversationId={CONV}
        initialWorkspace={{ kind: 'folder', path: '/Users/x/repo' }}
        onChoose={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('agent-workspace-default-note')).toBeNull()
  })
})
