/**
 * The Create switch on the desktop: who sees it, when it is greyed, what the
 * model is told. Every fact comes from the server (account release, model
 * release, window); a missing answer is a no.
 */
import { describe, expect, it } from 'vitest'
import {
  CREATE_MODEL_REASON, CREATE_OFF_BLOCKED_HINT, CREATE_OFF_HINT, CREATE_ON_PARAGRAPH,
  CREATE_UNAVAILABLE_SENTENCE, createActive, createChatLive, createInChatOf, createSupport,
  servedWindowOf, withCreateText,
} from '../chat-switch'
import {
  clearCreateChatRelease, createChatReleasedHere, noteCreateChatRelease,
} from '../chat-release'
import { ToolRegistry } from '../../../api/mcp/tool-registry'
import { syncCreateTools } from '../../../api/mcp/create-tools'
import { CREATE_TOOL_NAMES } from '../chat-origin'

const BIG = 'lu-cloud::big'
const rows = [
  { name: BIG, type: 'text', contextLength: 128_000, supportsTools: true, createInChat: true },
  { name: 'lu-cloud::plain', type: 'text', contextLength: 128_000, supportsTools: true },
  { name: 'lu-cloud::small', type: 'text', contextLength: 8_000, supportsTools: true, createInChat: true },
  { name: 'lu-cloud::stated', type: 'text', contextLength: 128_000, declaredContext: 6_000, supportsTools: true, createInChat: true },
  { name: 'lu-cloud::mute', type: 'text', contextLength: 128_000, supportsTools: false, createInChat: true },
  { name: 'local-model', type: 'text', contextLength: 128_000, supportsTools: true, createInChat: true },
]
const support = (model: string | null, live = true) =>
  createSupport(model, live, servedWindowOf(model, rows), createInChatOf(model, rows), rows)

describe('the account release', () => {
  it('is a no until the server says yes, and a no again after sign-out', () => {
    clearCreateChatRelease()
    expect(createChatReleasedHere()).toBe(false)
    noteCreateChatRelease({ id: 'u', features: { createChat: true } })
    expect(createChatReleasedHere()).toBe(true)
    clearCreateChatRelease()
    expect(createChatReleasedHere()).toBe(false)
  })

  it('reads an older server, a missing field and anything but true as a no', () => {
    for (const me of [null, {}, { features: {} }, { features: { createChat: 'true' } }, { features: { createChat: 1 } }, { features: { createChat: false } }]) {
      noteCreateChatRelease(me)
      expect(createChatReleasedHere(), JSON.stringify(me)).toBe(false)
    }
  })

  it('needs Cloud mode AND the release', () => {
    expect(createChatLive(true, true)).toBe(true)
    expect(createChatLive(false, true)).toBe(false)
    expect(createChatLive(true, false)).toBe(false)
  })
})

describe('the switch', () => {
  it('is not there at all outside Cloud mode or without the release', () => {
    expect(support(BIG, false)).toEqual({ shown: false, available: false, reason: '' })
  })

  it('is free for a model the server releases', () => {
    expect(support(BIG)).toEqual({ shown: true, available: true, reason: '' })
  })

  it('is greyed with a short English reason otherwise', () => {
    expect(support(null).reason).toBe('Pick a model first.')
    expect(support('lu-cloud::plain')).toEqual({ shown: true, available: false, reason: CREATE_MODEL_REASON })
    expect(support('lu-cloud::small').reason).toMatch(/too small a context window \(8k\) for Create/)
    expect(support('lu-cloud::mute').reason).toMatch(/cannot call tools/)
  })

  it('believes the window the server states over a table value', () => {
    expect(servedWindowOf('lu-cloud::stated', rows)).toBe(6_000)
    expect(support('lu-cloud::stated').available).toBe(false)
  })

  it('never takes a release from a model that is not the cloud\'s', () => {
    expect(createInChatOf('local-model', rows)).toBe(false)
    expect(support('local-model').available).toBe(false)
  })

  it('is on only when the customer switched it on and the model carries it', () => {
    const on = (model: string, enabled: boolean | undefined, live = true) =>
      createActive({ createEnabled: enabled }, model, live, servedWindowOf(model, rows), createInChatOf(model, rows))
    expect(on(BIG, true)).toBe(true)
    expect(on(BIG, undefined)).toBe(false)
    expect(on(BIG, false)).toBe(false)
    expect(on(BIG, true, false)).toBe(false)
  })
})

describe('the system prompt', () => {
  it('appends nothing when there is nothing to say', () => {
    expect(withCreateText('Base.', '')).toBe('Base.')
    expect(withCreateText('', CREATE_ON_PARAGRAPH)).toBe(CREATE_ON_PARAGRAPH)
    expect(withCreateText('Base.', CREATE_OFF_HINT)).toBe(`Base.\n\n${CREATE_OFF_HINT}`)
  })

  it('names no provider and no price per token in any of its texts', () => {
    for (const text of [CREATE_ON_PARAGRAPH, CREATE_UNAVAILABLE_SENTENCE, CREATE_OFF_HINT, CREATE_OFF_BLOCKED_HINT, CREATE_MODEL_REASON]) {
      expect(text).not.toMatch(/deepinfra|wavespeed|fal\b|replicate|tokens? per|per token/i)
      expect(text).not.toMatch(/[\u2013\u2014]/)
    }
  })
})

describe('the two tools in the registry', () => {
  it('are there only while the switch is on', () => {
    const registry = new ToolRegistry()
    const names = () => registry.getAll().map((t) => t.name).filter((n) => CREATE_TOOL_NAMES.includes(n as never))
    expect(names()).toEqual([])
    syncCreateTools(registry, true)
    expect(names().sort()).toEqual([...CREATE_TOOL_NAMES].sort())
    syncCreateTools(registry, true)
    expect(names()).toHaveLength(2)
    syncCreateTools(registry, false)
    expect(names()).toEqual([])
    // The names stay the app's own: a community server cannot take them.
    expect(registry.isBuiltinName('create_order')).toBe(true)
  })
})
