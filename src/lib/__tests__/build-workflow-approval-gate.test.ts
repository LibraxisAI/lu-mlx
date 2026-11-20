/**
 * bau/review-wfgate.md Auflage 3: `buildWorkflowApprovalGate`
 * (workflow-engine.ts) had zero direct tests, only the five cases in
 * workflow-engine-approval-gate.test.ts, which exercise the ENGINE with
 * `APPROVE_ALL`, a rejecting stub and `buildSubAgentGates`, never this
 * function itself. This file tests the gate builder directly: 'blocked',
 * 'auto', the chat queue's 'confirm', the Code tab's 'confirm' (Auflage 1),
 * no-conversation fail-closed, and abort cleanup.
 *
 * Each case names its negative control (what fails without the Round 2 fix,
 * bau/wfgate.md "Runde 2" carries the numbers).
 *
 * Run: npx vitest run src/lib/__tests__/build-workflow-approval-gate.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { buildWorkflowApprovalGate } from '../workflow-engine'
import { usePermissionStore } from '../../stores/permissionStore'
import { headApproval, dequeueApproval, resetApprovals } from '../approval-queue'
import { useCodexConfirmStore } from '../../stores/codexConfirmStore'
import { toolRegistry, registerBuiltinTools } from '../../api/mcp'
import type { AgentRunContext } from '../../api/agent-context'
import type { ExecutorToolDef, ExecutionRequest } from '../../api/agents/tool-executor'

const TOOL: ExecutorToolDef = { name: 'shell_execute' }

function makeRun(over: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    token: 'wf-test',
    chatId: null,
    conversationId: 'conv-1',
    workspace: null,
    artifactMode: false,
    readOnlyShellTurn: false,
    mode: null,
    artifacts: [],
    ...over,
  }
}

beforeEach(() => {
  registerBuiltinTools(toolRegistry)
  resetApprovals()
  useCodexConfirmStore.setState({ pending: null, resolve: null, queue: [] })
})

afterEach(() => {
  usePermissionStore.getState().resetToDefaults()
  vi.restoreAllMocks()
})

describe("'blocked': das Gate lehnt sofort ab, ohne je einzureihen", () => {
  it('shell_execute mit Kategorie terminal=blocked liefert false und reiht nichts ein', async () => {
    usePermissionStore.getState().setGlobalPermission('terminal', 'blocked')
    const gate = buildWorkflowApprovalGate(makeRun())

    const approved = await gate(
      { id: 'r1', toolName: 'shell_execute', args: { command: 'echo hi' }, run: undefined } as ExecutionRequest,
      TOOL,
    )

    expect(approved).toBe(false)
    expect(headApproval('conv-1')).toBeNull()
  })
})

describe("'auto': das Gate laesst sofort durch", () => {
  it('shell_execute mit Kategorie terminal=auto liefert true ohne Warteschlange', async () => {
    usePermissionStore.getState().setGlobalPermission('terminal', 'auto')
    const gate = buildWorkflowApprovalGate(makeRun())

    const approved = await gate(
      { id: 'r2', toolName: 'shell_execute', args: { command: 'echo hi' }, run: undefined } as ExecutionRequest,
      TOOL,
    )

    expect(approved).toBe(true)
    expect(headApproval('conv-1')).toBeNull()
  })
})

describe("'confirm' ohne mode: die Frage geht in die Chat-Warteschlange (approval-queue.ts)", () => {
  it('reiht unter der echten conversationId ein, und ein Klick loest auf', async () => {
    usePermissionStore.getState().setGlobalPermission('terminal', 'confirm')
    const gate = buildWorkflowApprovalGate(makeRun({ conversationId: 'conv-chat' }))

    const promise = gate(
      { id: 'r3', toolName: 'shell_execute', args: { command: 'echo hi' }, run: undefined } as ExecutionRequest,
      TOOL,
    )
    // Give the microtask queue a turn so `enqueueApproval` has run.
    await Promise.resolve()
    await Promise.resolve()

    const head = headApproval('conv-chat')
    expect(head).not.toBeNull()
    expect(head!.toolName).toBe('shell_execute')
    expect(useCodexConfirmStore.getState().pending).toBeNull()

    dequeueApproval('conv-chat')?.resolve(true)
    await expect(promise).resolves.toBe(true)
  })

  it('NEGATIVKONTROLLE ohne conversationId: faellt geschlossen aus (false), reiht nichts ein', async () => {
    usePermissionStore.getState().setGlobalPermission('terminal', 'confirm')
    const gate = buildWorkflowApprovalGate(makeRun({ conversationId: null }))

    const approved = await gate(
      { id: 'r4', toolName: 'shell_execute', args: { command: 'echo hi' }, run: undefined } as ExecutionRequest,
      TOOL,
    )

    expect(approved).toBe(false)
  })
})

describe("Auflage 1: 'confirm' MIT run.mode geht ueber codexConfirmStore, NICHT die Chat-Warteschlange", () => {
  it('run.mode gesetzt (Code-Tab/Sub-Agent): fragt useCodexConfirmStore, die Chat-Warteschlange bleibt leer', async () => {
    usePermissionStore.getState().setGlobalPermission('terminal', 'auto')
    // execConfirm true + mode set is what actually drives resolveApprovalLevel
    // to 'confirm' for an arbitrary-exec tool on the Code tab (see
    // agent-approval-policy.ts): the category itself may be 'auto' there,
    // since the Code tab does not read it at all once `codexMode` is set.
    const run = makeRun({ mode: 'ask', execApproval: { confirmExec: true, cloudReason: false }, conversationId: 'conv-code' })
    const gate = buildWorkflowApprovalGate(run)

    const promise = gate(
      { id: 'r5', toolName: 'shell_execute', args: { command: 'rm -rf /tmp/x' }, run: undefined } as ExecutionRequest,
      TOOL,
    )

    for (let i = 0; i < 50 && !useCodexConfirmStore.getState().pending; i++) await Promise.resolve()
    const pending = useCodexConfirmStore.getState().pending
    expect(pending).not.toBeNull()
    expect(pending!.toolName).toBe('shell_execute')
    expect(pending!.command).toMatch(/rm -rf \/tmp\/x/)
    // NEGATIVKONTROLLE, exactly what Auflage 1 says the pre-fix code did:
    // the question also must NOT additionally sit in the chat queue nobody
    // in the Code tab reads.
    expect(headApproval('conv-code')).toBeNull()

    useCodexConfirmStore.getState().answer(true)
    await expect(promise).resolves.toBe(true)
  })

  it('NEGATIVKONTROLLE: dieselbe Frage bei No lehnt ab, ohne die Chat-Warteschlange zu benutzen', async () => {
    usePermissionStore.getState().setGlobalPermission('terminal', 'auto')
    const run = makeRun({ mode: 'ask', execApproval: { confirmExec: true, cloudReason: false }, conversationId: 'conv-code-2' })
    const gate = buildWorkflowApprovalGate(run)

    const promise = gate(
      { id: 'r6', toolName: 'shell_execute', args: { command: 'echo hi' }, run: undefined } as ExecutionRequest,
      TOOL,
    )
    for (let i = 0; i < 50 && !useCodexConfirmStore.getState().pending; i++) await Promise.resolve()
    useCodexConfirmStore.getState().answer(false)

    await expect(promise).resolves.toBe(false)
    expect(headApproval('conv-code-2')).toBeNull()
  })
})

describe('Abbruch waehrend wartender Freigabe raeumt den Warteschlangen-Eintrag ab', () => {
  it('abortSignal.abort() loest die wartende Chat-Freigabe mit false auf und entfernt sie', async () => {
    usePermissionStore.getState().setGlobalPermission('terminal', 'confirm')
    const controller = new AbortController()
    const gate = buildWorkflowApprovalGate(makeRun({ conversationId: 'conv-abort', abortSignal: controller.signal }))

    const promise = gate(
      { id: 'r7', toolName: 'shell_execute', args: { command: 'echo hi' }, run: undefined } as ExecutionRequest,
      TOOL,
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(headApproval('conv-abort')).not.toBeNull()

    controller.abort()

    await expect(promise).resolves.toBe(false)
    expect(headApproval('conv-abort')).toBeNull()
  })
})

describe('Waechter: `run_workflow` (builtin-tools.ts) uebergibt ein ECHTES Gate, kein APPROVE_ALL', () => {
  it('ein blockiertes Werkzeug in einem Werkzeugschritt laeuft NIE, auch nicht ueber run_workflow', async () => {
    // A future silent swap of `buildWorkflowApprovalGate(run)` for
    // `APPROVE_ALL` in builtin-tools.ts's `executeRunWorkflow` would let
    // this pass: this test is the guard the review's Auflage 3 asks for.
    const { useAgentWorkflowStore } = await import('../../stores/agentWorkflowStore')
    useAgentWorkflowStore.setState({
      workflows: [{
        id: 'guard-wf',
        name: 'Guard Workflow',
        description: '',
        icon: 'Zap',
        steps: [{ id: 's1', type: 'tool', label: 'run it', toolName: 'shell_execute', toolArgs: { command: 'echo hi' } }],
        variables: {},
        isBuiltIn: false,
        createdAt: 0,
        updatedAt: 0,
      }],
    })
    usePermissionStore.getState().setGlobalPermission('terminal', 'blocked')
    const execSpy = vi.spyOn(toolRegistry, 'execute')

    const output = await toolRegistry.execute(
      'run_workflow',
      { name: 'Guard Workflow' },
      1,
      makeRun({ conversationId: 'conv-guard' }),
    )

    // toolRegistry.execute is called once for `run_workflow` itself (the
    // spy sees its own outer call too); shell_execute must never be among
    // the calls the workflow's own step made.
    expect(execSpy.mock.calls.map((c) => c[0])).not.toContain('shell_execute')
    expect(output).toMatch(/Workflow stopped at step/)
    expect(output).toMatch(/not approved|rejected/i)
  })
})
