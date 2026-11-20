// MIRRORED from the web app (lib/create/chat-control.ts), without its comments. Do not edit here.
// scripts/create-chat-mirror.mjs writes this file, and web-parity.test.ts
// holds it to its source. Only the import paths differ, the places listed
// under PATCHES in that script, and the classes under CLASSES.
import { ADULT_BLOCK_MESSAGE, SAFETY_BLOCK_MESSAGE } from '../render/safety'
import { ORDER_RESULT_PREFIX, orderDifference, orderIdFromToolResult, orderSum, type Order } from './order'
import type { ImageAttachment, MediaAttachment, Message } from '../../types/chat'

export type CreateReplyWord = 'approve' | 'stop'

const APPROVE_WORDS = new Set([
  'yes', 'y', 'yep', 'yeah', 'ja', 'jo', 'jep', 'go', 'los', 'ok', 'okay', 'start', 'mach', 'do it', 'go ahead',
  'yes please', 'ja bitte', 'los gehts', "los geht's", 'leg los', 'mach das', 'starten', 'start it', 'approve',
  'approved', 'confirm', 'si', 'oui',
])
const STOP_WORDS = new Set(['stop', 'stopp', 'cancel', 'abbrechen', 'halt', 'abort', 'stop it'])

const MAX_REPLY_CHARS = 16

export function createReplyWord(text: string): CreateReplyWord | null {
  const t = (text || '').trim().toLowerCase().replace(/[.!\s]+$/u, '').replace(/\s+/g, ' ')
  if (!t || t.length > MAX_REPLY_CHARS) return null
  if (APPROVE_WORDS.has(t)) return 'approve'
  if (STOP_WORDS.has(t)) return 'stop'
  return null
}

export interface CreateReplyDecision {
  action: 'approve' | 'approveDifference' | 'stop' | 'decline'
  orderId: string
}

export function openOrder(orders: Order[]): Order | null {
  const last = orders[orders.length - 1]
  if (!last) return null
  return last.state === 'awaiting' || last.state === 'repricing' || last.state === 'running' ? last : null
}

export function decideCreateReply(text: string, orders: Order[], hasAttachments = false): CreateReplyDecision | null {
  if (hasAttachments) return null
  const word = createReplyWord(text)
  if (!word) return null
  const order = openOrder(orders)
  if (!order) return null
  if (word === 'approve') {
    if (order.state === 'awaiting') return { action: 'approve', orderId: order.id }
    if (order.state === 'repricing') return { action: 'approveDifference', orderId: order.id }
    return null
  }
  if (order.state === 'running') return { action: 'stop', orderId: order.id }
  if (order.state === 'awaiting') return { action: 'decline', orderId: order.id }
  return null
}

export interface CreateCallState {
  placed: boolean
  safetyRefused: boolean
}

export function newCreateCallState(): CreateCallState {
  return { placed: false, safetyRefused: false }
}

export const CREATE_ORDER_TOOL = 'create_order'

export function createCallAllowed(state: CreateCallState, pendingInTurn: number): boolean {
  if (state.safetyRefused) return false
  return !state.placed && pendingInTurn === 0
}

export function noteCreateResult(state: CreateCallState, result: unknown): void {
  const text = typeof result === 'string' ? result : ''
  if (text.startsWith(ORDER_RESULT_PREFIX)) state.placed = true
  else if (text.includes(SAFETY_BLOCK_MESSAGE) || text.includes(ADULT_BLOCK_MESSAGE)) state.safetyRefused = true
}

export function createCallSteer(state: CreateCallState): string {
  return state.safetyRefused
    ? 'Stop. The order was refused by the content check. Do not call create_order again in this reply and do not rephrase the request to get around the check. Tell the customer plainly that this cannot be created here.'
    : 'Stop. You already placed an order in this reply and it is waiting for the customer\'s approval. Do not call create_order again. Tell the customer in their language what the order contains and what it costs in credits.'
}

const MEDIA_NOUN_RE =
  /\b(image|picture|photo|video|clip|song|track|music|voice|audio|render|bild|foto|musik|lied|stimme|animation)\b/i
const CLAIMS_WORK_RE =
  /\b(generating|rendering|i('|\s+a)m\s+(now\s+)?(generating|creating|rendering|making)|has\s+been\s+(successfully\s+)?(generated|created|rendered)|is\s+(being\s+)?(generated|created|rendered)|is\s+ready|wird\s+(gerade\s+|jetzt\s+)?(erstellt|generiert|gerendert)|ist\s+fertig|generiere\s+(jetzt|das|es))\b|\(\s*(generat|creating|rendering)/i

export function claimsCreateWork(text: string): boolean {
  return MEDIA_NOUN_RE.test(text) && CLAIMS_WORK_RE.test(text)
}

export const CREATE_CLAIM_STEER =
  'Nothing is being created: you have not placed an order, and nothing runs before the customer approves one. Either call create_order now, or tell the customer plainly what you still need from them. Do not say that something is being made or is ready.'

const ORDER_NOUN = '(?:order|auftrag|bestellung)'
const CLAIMS_ORDER_RE = new RegExp([
  `\\b(?:here(?:'s|\\s+is)|hier\\s+ist)\\s+(?:your|the|dein|deine|der|die|ihr|ihre)\\s+${ORDER_NOUN}\\b`,
  `\\bI(?:'ve|\\s+have)?\\s+(?:just\\s+)?(?:placed|created|prepared|set\\s+up|put)\\b[^.!?\\n]{0,40}\\b${ORDER_NOUN}\\b`,
  `\\b(?:your|the|dein|der|die)\\s+${ORDER_NOUN}\\s+(?:is|has\\s+been|ist|steht|wurde|liegt)\\s+(?:now\\s+)?(?:ready|waiting|placed|created|prepared|set|bereit|fertig|erstellt|angelegt|vor)\\b`,
  `\\b(?:approve|confirm|freigeben|bestaetigen|bestätigen)\\b[^.!?\\n]{0,30}\\b${ORDER_NOUN}\\b`,
  `\\border\\s+card\\b`,
  `\\bich\\s+habe\\b[^.!?\\n]{0,40}\\b${ORDER_NOUN}\\b[^.!?\\n]{0,20}\\b(?:erstellt|angelegt|vorgelegt|vorbereitet)\\b`,
].join('|'), 'i')

export function claimsCreateOrder(text: string): boolean {
  return CLAIMS_ORDER_RE.test(text)
}

export const CREATE_ORDER_CLAIM_STEER =
  'There is no order: none was created in this reply, and the customer sees no order card. If create_order answered with an error, correct the call as the error says and call it again. Otherwise tell the customer plainly what you still need from them. Do not say that an order exists, is ready or can be approved.'

export const CREATE_ORDER_CLAIM_NOTE =
  'Note: no order was created, so there is nothing to approve yet. Say again what you would like and the order appears here with its price.'

export const CREATE_CLAIM_NOTE =
  'Note: nothing has been started yet. An order with its price appears here first, and it only runs after you approve it.'

const credits = (n: number) => Math.round(n).toLocaleString('en-US')

export const CREATE_REPORT_PREFIX = '[Create report]'

export function orderReport(order: Order): string {
  const lines: string[] = []
  const short = order.id.slice(0, 8)
  if (order.state === 'declined') {
    return `${CREATE_REPORT_PREFIX} The customer declined order ${short}. Nothing was created and no credits were used. Ask what they would like to change.`
  }
  const head = order.state === 'done'
    ? `Order ${short} is finished.`
    : order.state === 'repricing'
      ? `Order ${short} is paused: one item costs more than the customer approved.`
      : `Order ${short} stopped before it was finished.`
  lines.push(`${CREATE_REPORT_PREFIX} ${head}`)
  for (const item of order.items) {
    for (const run of item.runs) {
      const name = item.runs.length > 1 ? `${item.title} · ${run.title}` : item.title
      if (run.status === 'done') {
        lines.push(`${item.n}. ${name}: done${run.jobId ? `, result job:${run.jobId.slice(0, 8)}` : ''}${typeof run.spent === 'number' ? `, ${credits(run.spent)} credits` : ''}`)
      } else if (run.status === 'failed') {
        lines.push(`${item.n}. ${name}: failed${run.error ? ` (${run.error})` : ''}${run.refunded ? ', refunded' : ''}`)
      } else {
        lines.push(`${item.n}. ${name}: not run, nothing charged`)
      }
    }
  }
  const sum = orderSum(order)
  const spent = order.items.reduce((n, item) => n + item.runs.reduce((m, run) => m + (run.status === 'done' ? run.spent ?? 0 : 0), 0), 0)
  lines.push(`Credits used by this order: ${credits(spent)}. Used in this chat so far: ${credits(sum.spentBefore + spent)}.`)
  const diff = orderDifference(order)
  if (diff) {
    lines.push(`Item ${diff.item} now costs ${credits(diff.credits)} credits, ${credits(diff.difference)} more than approved. Nothing was charged for it. Ask the customer whether to continue at the new price; they confirm on the order card or with a short yes.`)
  } else if (order.note) {
    lines.push(order.note)
  }
  lines.push(order.state === 'done'
    ? 'The customer already sees the results in the chat. Comment briefly in their language and suggest one sensible next step. Do not list the links, and do not start anything without a new order.'
    : 'Tell the customer briefly, in their language, what happened and what they can do next. Do not start anything without a new order.')
  return lines.join('\n')
}

export function declineNote(order: Order): string {
  return `${CREATE_REPORT_PREFIX} The customer declined order ${order.id.slice(0, 8)} with the "Not now" button on the order card. Nothing was created and no credits were used. That order is closed: do not say it is running or ready, and do not place it again unless the customer asks.`
}

export function supersedeOpenOrders(orders: Order[]): Order[] {
  return orders.map((o) => (o.state === 'awaiting' || o.state === 'repricing'
    ? { ...o, state: 'declined' as const, note: 'Replaced by a newer order.' }
    : o))
}

type BlockMessage = Pick<Message, 'agentBlocks'>

function toolCallsOf(message: BlockMessage) {
  return (message.agentBlocks ?? []).flatMap((block) => (block.toolCalls?.length ? block.toolCalls : block.toolCall ? [block.toolCall] : []))
}

export function orderIdsOfMessage(message: BlockMessage): string[] {
  const ids: string[] = []
  for (const call of toolCallsOf(message)) {
    const id = orderIdFromToolResult(call.toolName, call.result)
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

export function messageHasCreateOrder(message: BlockMessage): boolean {
  return toolCallsOf(message).some((call) => call.toolName === CREATE_ORDER_TOOL)
}

export function ordersInView(messages: (BlockMessage & Pick<Message, 'role' | 'hidden'>)[], orders: Order[]): Order[] {
  const shown = new Set<string>()
  for (const m of messages) {
    if (m.role !== 'assistant' || m.hidden) continue
    for (const id of orderIdsOfMessage(m)) shown.add(id)
  }
  return orders.filter((o) => shown.has(o.id))
}

type TurnMessage = Pick<Message, 'id' | 'role' | 'content' | 'hidden' | 'displayContent'> & {
  images?: ImageAttachment[]
  media?: MediaAttachment[]
}

export type RegenerateTarget =
  | { kind: 'user'; message: TurnMessage }
  | { kind: 'report'; message: TurnMessage }

export function regenerateTarget(messages: TurnMessage[], assistantMessageId: string): RegenerateTarget | null {
  const at = messages.findIndex((m) => m.id === assistantMessageId)
  for (let i = at - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.hidden) {
      if (m.role === 'user' && m.content.startsWith(CREATE_REPORT_PREFIX)) return { kind: 'report', message: m }
      continue
    }
    return m.role === 'user' ? { kind: 'user', message: m } : null
  }
  return null
}
