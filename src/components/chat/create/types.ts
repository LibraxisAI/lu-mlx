// MIRRORED from the web app (components/chat/create/types.ts), without its comments. Do not edit here.
// scripts/create-chat-mirror.mjs writes this file, and web-parity.test.ts
// holds it to its source. Only the import paths differ, the places listed
// under PATCHES in that script, and the classes under CLASSES.
export type CreateMediaKind = 'image' | 'video' | 'audio'

export type OrderItemStatus = 'waiting' | 'queued' | 'running' | 'done' | 'failed'

export interface OrderStepView {
  title: string
  model: string
  credits: number | null
  status: OrderItemStatus
}

export interface OrderItemView {
  id: string
  title: string
  detail: string
  kind: CreateMediaKind
  thumb?: string
  credits: number | null
  estimated?: boolean
  status: OrderItemStatus
  steps?: OrderStepView[]
  elapsed?: number
  expected?: number
  spent?: number
  error?: string
  refunded?: boolean
}

export type OrderState = 'awaiting' | 'running' | 'done' | 'stopped' | 'declined'

export interface OrderView {
  id: string
  state: OrderState
  items: OrderItemView[]
  spentBefore?: number
}

export interface CreateMediaView {
  kind: CreateMediaKind
  url: string
  poster?: string
  title: string
  model: string
  prompt?: string
  credits?: number
  aspect?: number
}
