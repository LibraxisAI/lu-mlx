import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIProvider } from '../../api/providers/openai-provider'
import { cloudModelRow } from '../cloud-model-row'
import { LIMITED_CAPACITY_LABEL, LIMITED_CAPACITY_TITLE, pickerRows } from '../model-picker'

// The quiet "Limited capacity" note of the picker, on the way a real listing
// takes: the answer of GET /api/inference/v1/models, through the provider
// adapter and the store's row, into the row the picker draws. The field is
// the server's (`limited_capacity`, derived from the model's request limit
// group); the client never guesses it from a name.

vi.mock('../../api/backend', () => ({
  localFetch: vi.fn(async () => new Response('{}', { status: 404 })),
  localFetchStream: vi.fn(), isPrivateOrLanHost: () => false,
  isDirectFetchAllowed: () => true, hostnameOf: (url: string) => new URL(url).hostname,
  ensureProxyAllowsHost: vi.fn(), backendCall: vi.fn(), isTauri: () => false,
}))
afterEach(() => vi.unstubAllGlobals())

const provider = () => new OpenAIProvider({
  id: 'openai', name: 'LU Cloud', enabled: true, isLocal: false, apiKey: '', baseUrl: 'https://lu-labs.ai/api/inference/v1',
})
const rowsOf = async (data: Array<Record<string, unknown>>) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ object: 'list', data }))))
  return pickerRows((await provider().listModels()).map(cloudModelRow), true)
}

describe('the limited capacity note', () => {
  it('reaches the picker row from the listing, for the model that carries it and no other', async () => {
    const rows = await rowsOf([
      { id: 'direct/aion-3.5', name: 'Aion 3.5', unrestricted: true, limited_capacity: true },
      { id: 'direct/v-1.2', name: 'Instruct 1.2', unrestricted: true },
      { id: 'Qwen/Qwen3.6-27B', name: 'Qwen 3.6 27B' },
    ])
    expect(rows.map((r) => [r.label, r.limitedCapacity])).toEqual([['Aion 3.5', true], ['Instruct 1.2', false], ['Qwen 3.6 27B', false]])
  })

  it('takes nothing but a plain true for it', async () => {
    const rows = await rowsOf([
      { id: 'a', limited_capacity: 'true' }, { id: 'b', limited_capacity: 1 }, { id: 'c', limited_capacity: false }, { id: 'd' },
    ])
    expect(rows.some((r) => r.limitedCapacity)).toBe(false)
  })

  it('is two plain words and one sentence, with no figure and no name of an upstream', () => {
    expect(LIMITED_CAPACITY_LABEL).toBe('Limited capacity')
    expect(LIMITED_CAPACITY_TITLE).not.toMatch(/\d|venice|upstream|provider/i)
  })
})
