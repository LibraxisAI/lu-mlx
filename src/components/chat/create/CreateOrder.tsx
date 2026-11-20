// MIRRORED from the web app (components/chat/create/CreateOrder.tsx), without its comments. Do not edit here.
// scripts/create-chat-mirror.mjs writes this file, and web-parity.test.ts
// holds it to its source. Only the import paths differ, the places listed
// under PATCHES in that script, and the classes under CLASSES.
import { Check, Film, Image as ImageIcon, Loader2, Music, Sparkles, Square, X } from 'lucide-react'
import type { CreateMediaKind, OrderItemStatus, OrderItemView, OrderView } from './types'
import { formatClock, formatCredits, orderTotals } from './format'

const KIND_ICON: Record<CreateMediaKind, typeof ImageIcon> = { image: ImageIcon, video: Film, audio: Music }

const STATE_LABEL: Record<OrderView['state'], string> = {
  awaiting: 'Waiting for your OK',
  running: 'Creating',
  done: 'Done',
  stopped: 'Stopped',
  declined: 'Not started',
}

function StatusMark({ status }: { status: OrderItemStatus }) {
  if (status === 'done') return <Check size={12} className="text-emerald-600 dark:text-emerald-400" aria-label="Done" />
  if (status === 'failed') return <X size={12} className="text-red-600 dark:text-red-400" aria-label="Failed" />
  if (status === 'running' || status === 'queued') {
    return <Loader2 size={12} className="animate-spin text-lu-accent" aria-label="Running" />
  }
  return null
}

function Thumb({ item }: { item: OrderItemView }) {
  const Icon = KIND_ICON[item.kind]
  return (
    <div className="relative size-10 shrink-0 overflow-hidden rounded-lg border border-white/[0.06] bg-white/[0.05]">
      {item.thumb
        ? <img src={item.thumb} alt="" className="h-full w-full object-cover" />
        : <Icon size={15} className="absolute inset-0 m-auto text-gray-500" />}
      {(item.status === 'running' || item.status === 'queued') && (
        <span className="absolute inset-0 bg-black/35" aria-hidden />
      )}
    </div>
  )
}

function Price({ item }: { item: OrderItemView }) {
  if (item.status === 'failed') {
    return <span className="text-red-600 dark:text-red-400">{item.refunded ? 'Refunded' : 'Failed'}</span>
  }
  if (item.status === 'done' && typeof item.spent === 'number') {
    return <span className="text-gray-400">{formatCredits(item.spent)}</span>
  }
  if (item.credits === null) return <span className="text-gray-500">Price after upload</span>
  return <span className="text-gray-300">{item.estimated ? '≈ ' : ''}{formatCredits(item.credits)}</span>
}

function ItemRow({ item }: { item: OrderItemView }) {
  const running = item.status === 'running' || item.status === 'queued'
  const share = running && item.expected ? Math.min(0.96, (item.elapsed ?? 0) / item.expected) : 0
  return (
    <li className="px-3 py-2.5">
      <div className="flex items-center gap-3">
        <Thumb item={item} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-xs text-gray-900 dark:text-gray-100">{item.title}</span>
            <StatusMark status={item.status} />
          </div>
          <div className="truncate t-micro text-gray-500">
            {running
              ? item.status === 'queued'
                ? 'Waiting for a GPU…'
                : `${formatClock(item.elapsed ?? 0)}${item.expected ? ` of about ${formatClock(item.expected)}` : ''}`
              : item.detail}
          </div>
          {running && (
            <div className="mt-1.5 h-[2px] overflow-hidden rounded-full bg-white/[0.08]">
              <div
                className={`h-full rounded-full bg-lu-accent ${item.expected ? '' : 'w-1/3 animate-pulse'}`}
                style={item.expected ? { width: `${Math.max(4, share * 100)}%`, transition: 'width 1s linear' } : undefined}
              />
            </div>
          )}
        </div>
        <div className="shrink-0 text-right t-micro tabular-nums">
          <Price item={item} />
        </div>
      </div>
      {item.steps && item.steps.length > 0 && (
        <ol className="mt-2 space-y-1 pl-[52px]">
          {item.steps.map((step, i) => (
            <li key={i} className="flex items-center gap-2 t-micro">
              <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border t-micro tabular-nums ${
                step.status === 'done'
                  ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
                  : step.status === 'running' || step.status === 'queued'
                    ? 'border-lu-accent/60 text-lu-accent'
                    : 'border-white/10 text-gray-500'
              }`}>
                {step.status === 'done' ? <Check size={9} /> : i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-gray-400">
                {step.title}
                <span className="text-gray-600"> · {step.model}</span>
              </span>
              <span className="shrink-0 tabular-nums text-gray-500">
                {step.credits === null ? '' : formatCredits(step.credits)}
              </span>
            </li>
          ))}
        </ol>
      )}
      {item.error && (
        <p className="mt-1.5 pl-[52px] t-micro leading-snug text-red-600 dark:text-red-400">{item.error}</p>
      )}
    </li>
  )
}

export interface CreateOrderProps {
  order: OrderView
  onStart?: () => void
  onDecline?: () => void
  onStop?: () => void
}

export function CreateOrder({ order, onStart, onDecline, onStop }: CreateOrderProps) {
  const totals = orderTotals(order)
  const stacked = typeof totals.before === 'number'
  const awaiting = order.state === 'awaiting'
  const totalLabel = `${totals.estimated ? '≈ ' : ''}${formatCredits(totals.order)}${totals.unknown ? ' +' : ''}`
  return (
    <section
      aria-label="Create order"
      className="w-full max-w-[440px] overflow-hidden rounded-xl border border-white/[0.08] bg-white dark:bg-lu-panel"
    >
      <header className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2">
        <Sparkles size={12} className="text-lu-accent" />
        <span className="text-xs font-medium text-gray-800 dark:text-gray-200">
          {order.items.length === 1 ? '1 item' : `${order.items.length} items`}
        </span>
        <span className={`ml-auto rounded-full px-2 py-0.5 t-micro ${
          awaiting
            ? 'bg-lu-accent-soft text-lu-accent'
            : order.state === 'running'
              ? 'bg-white/[0.06] text-gray-300'
              : order.state === 'done'
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'bg-white/[0.05] text-gray-500'
        }`}>
          {STATE_LABEL[order.state]}
        </span>
      </header>

      <ul className="divide-y divide-black/[0.06] dark:divide-white/[0.04]">
        {order.items.map((item) => <ItemRow key={item.id} item={item} />)}
      </ul>

      <div className="space-y-1 border-t border-white/[0.06] px-3 py-2.5 t-micro tabular-nums">
        {stacked && (
          <>
            <div className="flex justify-between text-gray-500">
              <span>Already used in this chat</span>
              <span>{formatCredits(totals.before!)}</span>
            </div>
            <div className="flex justify-between text-gray-400">
              <span>This order</span>
              <span>{totalLabel}</span>
            </div>
          </>
        )}
        <div className="flex justify-between font-medium text-gray-900 dark:text-gray-100">
          <span>{stacked ? 'Together' : order.state === 'done' || order.state === 'stopped' ? 'Used' : 'Total'}</span>
          <span>
            {stacked
              ? `${totals.estimated ? '≈ ' : ''}${formatCredits(totals.together!)}${totals.unknown ? ' +' : ''}`
              : totalLabel}
            <span className="ml-1 font-normal text-gray-500">credits</span>
          </span>
        </div>
      </div>

      {awaiting && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 pb-3">
          <button
            type="button"
            onClick={onStart}
            className="flex h-[var(--control-h-md)] items-center gap-1.5 rounded-lg bg-lu-accent px-3.5 text-xs font-medium text-gray-950 transition-colors hover:bg-lu-accent-hover"
          >
            Start
            <span className="font-normal opacity-70">· {totalLabel}</span>
          </button>
          <button
            type="button"
            onClick={onDecline}
            className="t-micro text-gray-500 transition-colors hover:text-gray-900 dark:hover:text-gray-300"
          >
            Not now
          </button>
          <span className="w-full t-micro text-gray-600 sm:ml-auto sm:w-auto">or just reply "yes"</span>
        </div>
      )}

      {order.state === 'running' && onStop && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 pb-3">
          <button
            type="button"
            onClick={onStop}
            className="flex items-center gap-1.5 rounded-md border border-white/10 px-2 py-1 t-micro text-gray-400 transition-colors hover:border-black/20 dark:hover:border-white/20 hover:text-gray-900 dark:hover:text-gray-200"
          >
            <Square size={9} className="fill-current" />
            Stop
          </button>
          <span className="t-micro text-gray-600 sm:ml-auto">Items that have not started are not charged</span>
        </div>
      )}
    </section>
  )
}
