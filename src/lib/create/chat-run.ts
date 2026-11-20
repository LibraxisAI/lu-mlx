// MIRRORED from the web app (lib/create/chat-run.ts), without its comments. Do not edit here.
// scripts/create-chat-mirror.mjs writes this file, and web-parity.test.ts
// holds it to its source. Only the import paths differ, the places listed
// under PATCHES in that script, and the classes under CLASSES.
import { useCreateOrderStore, cloudOrderDeps } from '../../stores/createOrderStore'
import { chatHandleContext } from './chat-context'
import { declineNote, orderReport, type CreateReplyDecision } from './chat-control'
import type { Order } from './order'

export type FollowUpMode = 'answer' | 'note'
type FollowUp = (conversationId: string, report: string, mode: FollowUpMode) => void
let followUp: FollowUp | null = null

export function setCreateFollowUp(fn: FollowUp | null): void {
  followUp = fn
}

export async function startOrder(orderId: string, action: 'approve' | 'approveDifference' = 'approve'): Promise<Order | null> {
  const store = useCreateOrderStore.getState()
  const order = store.get(orderId)
  if (!order || store.isRunning(orderId)) return null
  if (action === 'approve') {
    if (order.state !== 'awaiting') return null
    store.approve(orderId)
  } else {
    if (order.state !== 'repricing') return null
    store.approveDifference(orderId)
  }
  let final: Order
  try {
    final = await useCreateOrderStore.getState().run(
      orderId,
      cloudOrderDeps(() => chatHandleContext(order.conversationId, Date.now())),
    )
  } catch (err) {
    const now = useCreateOrderStore.getState().get(orderId) ?? order
    final = { ...now, state: 'stopped', note: err instanceof Error ? err.message : String(err) }
    useCreateOrderStore.getState().put(final)
  }
  followUp?.(final.conversationId, orderReport(final), 'answer')
  return final
}

export function stopOrder(orderId: string): void {
  useCreateOrderStore.getState().stop(orderId)
}

export function declineOrder(orderId: string, report = false): void {
  const store = useCreateOrderStore.getState()
  if (store.get(orderId)?.state !== 'awaiting') return
  store.decline(orderId)
  const order = store.get(orderId)
  if (order?.state !== 'declined') return
  if (report) followUp?.(order.conversationId, orderReport(order), 'answer')
  else followUp?.(order.conversationId, declineNote(order), 'note')
}

export function applyCreateReply(decision: CreateReplyDecision): void {
  if (decision.action === 'approve' || decision.action === 'approveDifference') void startOrder(decision.orderId, decision.action)
  else if (decision.action === 'stop') stopOrder(decision.orderId)
  else declineOrder(decision.orderId, true)
}
