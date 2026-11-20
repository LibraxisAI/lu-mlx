// MIRRORED from the web app (components/chat/create/format.ts), without its comments. Do not edit here.
// scripts/create-chat-mirror.mjs writes this file, and web-parity.test.ts
// holds it to its source. Only the import paths differ, the places listed
// under PATCHES in that script, and the classes under CLASSES.
import type { OrderView } from './types'

export function formatCredits(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`
}

export interface OrderTotals {
  order: number
  unknown: boolean
  estimated: boolean
  before?: number
  together?: number
}

export function orderTotals(order: OrderView): OrderTotals {
  let sum = 0
  let unknown = false
  let estimated = false
  for (const item of order.items) {
    if (item.status === 'failed' && item.refunded) continue
    if (order.state === 'stopped' && item.status === 'waiting') continue
    if (item.status === 'done' && typeof item.spent === 'number') {
      sum += item.spent
      continue
    }
    if (item.credits === null) {
      unknown = true
      continue
    }
    sum += item.credits
    if (item.estimated) estimated = true
  }
  const totals: OrderTotals = { order: sum, unknown, estimated }
  if (typeof order.spentBefore === 'number') {
    totals.before = order.spentBefore
    totals.together = order.spentBefore + sum
  }
  return totals
}
