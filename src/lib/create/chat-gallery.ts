// Results of Create in chat on the Create tab's shelf.
//
// The web app fills its gallery from the server's job list whenever it loads,
// so a result made in the chat simply shows up there. The desktop has no job
// list: its gallery holds what this app made. A finished item of an order is
// therefore laid onto the shelf here, once, the moment it is done.
//
// mergeGallery and not addToGallery: adding moves the Create tab's model
// picker onto the model of the new item, and a chat must not reach into the
// tab's controls. Merging also makes this safe to run twice (same job, one
// entry).

import { useCreateOrderStore } from '../../stores/createOrderStore'
import { useCreateStore, type GalleryItem } from '../../stores/createStore'
import { galleryItemFromJob } from '../render/cloud-jobs'
import type { Order, OrderRun } from './order'

/** A trained character is not a medium, it goes onto the character shelf. */
const isMedium = (run: OrderRun) => !(run.intent === 'character' && run.characterTab !== 'use')

/** The gallery entries of every finished run of these orders. */
export function galleryItemsOf(orders: readonly Order[]): GalleryItem[] {
  const out: GalleryItem[] = []
  for (const order of orders) {
    for (const item of order.items) {
      for (const run of item.runs) {
        if (run.status !== 'done' || !run.jobId || !run.resultUrl || !isMedium(run)) continue
        out.push({
          ...galleryItemFromJob({ id: run.jobId, kind: run.kind, model: run.model, result_url: run.resultUrl, attestation: null }),
          prompt: run.prompt,
          label: item.runs.length > 1 ? `${item.title} · ${run.title}` : item.title,
          createdAt: order.approvedAt ?? order.createdAt,
        })
      }
    }
  }
  return out
}

/** Lays every finished run that is not on the shelf yet onto it. */
export function shelveOrderResults(byConversation: Record<string, Order[]>, seen: Set<string>): void {
  const fresh = galleryItemsOf(Object.values(byConversation).flat()).filter((g) => !seen.has(g.id))
  if (!fresh.length) return
  for (const g of fresh) seen.add(g.id)
  const have = new Set(useCreateStore.getState().gallery.map((g) => g.jobId ?? g.id))
  const missing = fresh.filter((g) => !have.has(g.id))
  if (missing.length) useCreateStore.getState().mergeGallery(missing)
}

/** Follows the order store for as long as the chat is mounted. Returns the
 *  function that stops it. Orders that were finished before this session are
 *  not laid out again: what the customer removed from the shelf stays removed. */
export function watchOrderResults(): () => void {
  const seen = new Set(galleryItemsOf(Object.values(useCreateOrderStore.getState().byConversation).flat()).map((g) => g.id))
  return useCreateOrderStore.subscribe((state) => shelveOrderResults(state.byConversation, seen))
}
