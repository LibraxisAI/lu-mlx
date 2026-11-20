/**
 * Create in chat: a reply that says an order exists although none does.
 *
 * 09.10.2026: a local 9B model had its create_order call refused (an empty
 * step) and wrote "Here is your order". The customer saw the sentence and no
 * card. The words and the objection are the web's (mirrored chat-control.ts);
 * the guard in the desktop's tool loop is written by hand and is held here.
 *
 * Run: npx vitest run src/lib/create/__tests__/order-claim-guard.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CREATE_ORDER_CLAIM_NOTE, CREATE_ORDER_CLAIM_STEER, claimsCreateOrder, openOrder } from '../chat-control'
import { planOrder } from '../order'

describe('a reply that says an order exists', () => {
  it('is recognised in the words a model uses for it', () => {
    for (const claim of [
      'Here is your order: one image of a red fox, 300 credits.', "Here's the order for your video.",
      'Here is your order to create a single image of "a red fox in the snow" using the Flux Schnell model:',
      'I have placed the order for you.', "I've created an order with two items.",
      'Your order is ready. Please approve it.', 'Please approve the order to start.',
    ]) {
      expect(claimsCreateOrder(claim), claim).toBe(true)
    }
  })

  it('leaves talk about ordering alone', () => {
    for (const talk of [
      'What would you like me to create?', 'I can put an order together once you tell me the subject of the image.',
      'I could not create the order: the prompt is missing. What should the image show?',
      'In order to make a video I need a prompt.', 'Which model do you prefer?',
    ]) {
      expect(claimsCreateOrder(talk), talk).toBe(false)
    }
  })

  it('the objection tells the model there is no card, and the note says so to the customer', () => {
    expect(CREATE_ORDER_CLAIM_STEER).toContain('There is no order')
    expect(CREATE_ORDER_CLAIM_NOTE).toBe('Note: no order was created, so there is nothing to approve yet. Say again what you would like and the order appears here with its price.')
  })

  it('an order that waits for approval counts as open, a declined one does not', async () => {
    const order = await planOrder([{ intent: 'image', prompt: 'a fox' }], {
      conversationId: 'conv-a',
      handles: { now: 1, results: [], gallery: [], attachments: [] },
      openAllowed: false, characters: [], checkSafety: () => ({ blocked: false }),
      spentBefore: 0, now: 1,
      newId: () => '0f0f0f0f-0000-4000-8000-000000000001',
    }, { fetch: async () => { throw new Error('no quote') } })
    expect(openOrder([order])).toBe(order)
    expect(openOrder([{ ...order, state: 'stopped' }])).toBeNull()
    expect(openOrder([])).toBeNull()
  })

  it('is asked by the tool loop only when no order was placed and none is open, once, and then the note stands', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/hooks/useAgentChat.ts'), 'utf8')
    const at = src.indexOf('&& claimsCreateOrder(turnContent)')
    expect(at).toBeGreaterThan(0)
    const guard = src.slice(src.lastIndexOf('if (', at), src.indexOf('if (isFinalTurn) {', at))
    expect(guard).toContain('isFinalTurn && opts?.createTools && !opts?.hiddenUser && !createCalls.placed')
    expect(guard).toContain('!openOrder(useCreateOrderStore.getState().ordersFor(convId))')
    expect(guard).toMatch(/if \(!createOrderClaimSteered\) \{\s*createOrderClaimSteered = true[\s\S]*CREATE_ORDER_CLAIM_STEER[\s\S]*continue\s*\}/)
    expect(guard).toContain('CREATE_ORDER_CLAIM_NOTE')
    // It stands directly behind the guard for claimed work.
    expect(src.indexOf('&& claimsCreateWork(turnContent)')).toBeLessThan(at)
  })
})
