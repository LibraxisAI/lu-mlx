// The orders of one reply in the chat: card, progress and results.
//
// The desktop twin of the web app. The
// card (CreateOrder) and the media (CreateMedia) are the web's, mirrored; this
// file hangs them onto the app's store. Only an order that a real call of
// create_order put down in THIS conversation is drawn. Text of the model is
// never read, an invented id draws nothing.
//
// Starting, declining and stopping go through lib/create/chat-run.ts, the same
// place as the customer's short "yes".
//
// One difference to the web: the address of a result. The web shows the fixed
// route of the job, which answers with a redirect to a signed address. That
// route wants the session, and an image or a player in a WebView cannot send
// the bearer token. So each result asks for its signed address here
// (resolveResultUrl), when it is drawn and again when it fails to load: a
// signed address lasts about an hour.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useCreateOrderStore } from '../../../stores/createOrderStore'
import { interruptedRuns, toOrderView, type Order, type OrderRun } from '../../../lib/create/order'
import { orderIdsOfMessage } from '../../../lib/create/chat-control'
import { declineOrder, startOrder, stopOrder } from '../../../lib/create/chat-run'
import { resolveResultUrl } from '../../../api/cloud/jobs'
import { modelLabel } from '../../../lib/render/preset-models'
import type { Message } from '../../../types/chat'
import { betaNote } from '../../../lib/beta'
import { BetaMark } from '../../ui/BetaMark'
import { CreateOrder } from './CreateOrder'
import { CreateMedia, CreateMediaPending } from './CreateMedia'
import type { CreateMediaView } from './types'

const ASPECT: Record<string, number> = { '1:1': 1, '3:4': 3 / 4, '4:3': 4 / 3, '16:9': 16 / 9, '9:16': 9 / 16 }

function aspectOf(run: OrderRun): number | undefined {
  const named = ASPECT[String(run.options.aspect ?? run.options.aspect_ratio ?? '')]
  return named ?? (run.kind === 'image' ? 1 : run.kind === 'video' ? 16 / 9 : undefined)
}

/** A finished result and the job it came from. */
export interface OrderMedia extends CreateMediaView {
  jobId: string
}

/** The finished results of an order, in the order of its items. `url` is the
 *  signed address the run ended with; JobMedia below keeps it fresh. */
export function orderMedia(order: Order): OrderMedia[] {
  const out: OrderMedia[] = []
  for (const item of order.items) {
    for (const run of item.runs) {
      // Ein trainierter Charakter ist kein Medium, er steht auf dem Regal.
      if (run.status !== 'done' || !run.jobId || run.intent === 'character' && run.characterTab !== 'use') continue
      out.push({
        kind: run.kind,
        jobId: run.jobId,
        url: run.resultUrl ?? '',
        title: item.runs.length > 1 ? `${item.title} · ${run.title}` : item.title,
        model: modelLabel(run.model),
        ...(run.prompt.trim() ? { prompt: run.prompt } : {}),
        ...(typeof run.spent === 'number' ? { credits: run.spent } : {}),
        ...(aspectOf(run) ? { aspect: aspectOf(run) } : {}),
      })
    }
  }
  return out
}

/** The sentence in place of a result the server no longer has. */
export const RESULT_EXPIRED = 'This result is no longer stored. Results are kept for 7 days.'

/** The line under an order that waits for the OK, next to the Beta mark. */
export const CREATE_ORDER_BETA_LINE = 'Create in chat is new. Read the order before you start it.'

/** How often one result may ask for a new address after a load error. */
const RESIGN_EVERY_MS = 30_000

/** One result with an address that is kept alive. */
function JobMedia({ media }: { media: OrderMedia }) {
  const [url, setUrl] = useState(media.url)
  const [gone, setGone] = useState(false)
  const asked = useRef(0)
  const resign = useCallback((alive: () => boolean = () => true) => {
    asked.current = Date.now()
    void resolveResultUrl(media.jobId).then((state) => {
      if (!alive()) return
      if (state.kind === 'ok') setUrl(state.url)
      else if (state.kind === 'gone') setGone(true)
      // 'retry': the server could not be asked just now; the address stays.
    })
  }, [media.jobId])
  // A card drawn again (a restart, another conversation and back) holds the
  // address its run ended with, which may be hours old.
  useEffect(() => {
    let mounted = true
    resign(() => mounted)
    return () => { mounted = false }
  }, [resign])
  if (gone) return <p className="px-1 t-micro leading-snug text-gray-500" role="status">{RESULT_EXPIRED}</p>
  if (!url) return null
  return (
    // A load error of the image or the player does not bubble; it is caught on
    // the way down.
    <div onErrorCapture={() => { if (Date.now() - asked.current > RESIGN_EVERY_MS) resign() }}>
      <CreateMedia media={{ ...media, url }} />
    </div>
  )
}

/** Der Lauf, der gerade entsteht, fuer den Platzhalter. */
function activeRun(order: Order): { n: number; title: string; run: OrderRun } | null {
  if (order.state !== 'running') return null
  for (const item of order.items) {
    for (const run of item.runs) {
      if (run.status === 'queued' || run.status === 'running') {
        return { n: item.n, title: item.runs.length > 1 ? `${item.title} · ${run.title}` : item.title, run }
      }
    }
  }
  return null
}

/** Sekunden, seit dieser Lauf hier zu sehen ist. Eine Uhr fuer die Zeile der
 *  Karte und den Platzhalter, damit beide dieselbe Zeit zeigen. */
function useElapsed(key: string | null): number {
  // The count belongs to the run it was counted for: a new run reads 0 until
  // its own first second, without an effect that resets anything.
  const [count, setCount] = useState<{ key: string | null; seconds: number }>({ key: null, seconds: 0 })
  useEffect(() => {
    if (!key) return
    const started = Date.now()
    const timer = setInterval(() => setCount({ key, seconds: Math.round((Date.now() - started) / 1000) }), 1000)
    return () => clearInterval(timer)
  }, [key])
  return count.key === key ? count.seconds : 0
}

function OrderCard({ order }: { order: Order }) {
  const live = useCreateOrderStore((s) => s.isRunning(order.id))
  const waiting = order.state === 'awaiting' || order.state === 'repricing'
  const active = activeRun(order)
  const elapsed = useElapsed(active ? `${active.n}:${active.run.requestId ?? ''}` : null)
  const view = toOrderView(order)
  // Die laufende Zeile zaehlt mit; ohne das stuende dort dauerhaft "0:00".
  if (active) {
    view.items = view.items.map((item) => (item.id === `${order.id}:${active.n}` ? { ...item, elapsed } : item))
  }
  // Nach einem Neuladen: was der Server aus einem unterbrochenen Lauf gemacht
  // hat, wird nachgetragen. Es startet nichts und bucht nichts.
  const lost = interruptedRuns(order).length > 0
  useEffect(() => {
    if (lost) void useCreateOrderStore.getState().catchUp(order.id)
  }, [lost, order.id])
  return (
    <div className="space-y-2" data-testid="create-order" data-order-state={order.state}>
      <CreateOrder
        order={view}
        onStart={waiting ? () => { void startOrder(order.id, order.state === 'repricing' ? 'approveDifference' : 'approve') } : undefined}
        onDecline={order.state === 'awaiting' ? () => declineOrder(order.id) : undefined}
        onStop={live ? () => stopOrder(order.id) : undefined}
      />
      {/* Not in the card: the card is the web's file. Said where the customer
          is about to spend credits, and gone once the order runs. */}
      {waiting && betaNote('create-in-chat') && (
        <p className="px-1 flex items-start gap-1.5 t-micro leading-snug text-gray-500" data-testid="create-order-beta">
          <BetaMark feature="create-in-chat" className="mt-px" />
          <span className="min-w-0">{CREATE_ORDER_BETA_LINE}</span>
        </p>
      )}
      {order.note && order.state !== 'running' && (
        <p className="px-1 t-micro leading-snug text-gray-500" role="status">{order.note}</p>
      )}
      {orderMedia(order).map((media) => <JobMedia key={media.jobId} media={media} />)}
      {/* Eine Tonspur hat kein Bild, das sich entwickelt; ihr Stand steht in der Karte. */}
      {active && active.run.kind !== 'audio' && (
        <CreateMediaPending aspect={aspectOf(active.run)} label={active.title} elapsed={elapsed} />
      )}
    </div>
  )
}

/** Alle Auftraege, die diese Antwort vorgelegt hat. */
export function CreateOrders({ message, conversationId }: { message: Message; conversationId: string | null }) {
  const orders = useCreateOrderStore((s) => (conversationId ? s.byConversation[conversationId] : undefined))
  if (!conversationId || !orders?.length) return null
  const ids = orderIdsOfMessage(message)
  const mine = ids.map((id) => orders.find((o) => o.id === id)).filter((o): o is Order => !!o)
  if (!mine.length) return null
  return <div className="space-y-3 py-1">{mine.map((order) => <OrderCard key={order.id} order={order} />)}</div>
}
