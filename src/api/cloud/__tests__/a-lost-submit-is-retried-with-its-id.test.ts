/**
 * Bug hunt 01.10.2026 (K8). A submit that timed out or lost its connection
 * may have booked the job anyway: it ran, it was charged, and the desktop
 * never saw it. The same body, same request id, now goes out again, and the
 * server replays the booking it already made.
 */
import { it, expect, vi, beforeEach, afterEach } from 'vitest'

const cloudFetch = vi.hoisted(() => vi.fn())
vi.mock('../client', async (orig) => ({ ...(await orig<typeof import('../client')>()), cloudFetch }))

import { submitCloudJob } from '../jobs'
import { CloudJobError } from '../client'

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const submit = { kind: 'image' as const, model: 'flux-schnell', prompt: 'p', params: { op: 'generate' as const } }

beforeEach(() => { cloudFetch.mockReset(); vi.useFakeTimers() })
afterEach(() => vi.useRealTimers())

it('a timed-out submit goes out again with the same request id, and the replay is the answer', async () => {
  cloudFetch
    .mockRejectedValueOnce(new CloudJobError('the cloud did not answer in time', 408))
    .mockResolvedValueOnce(ok({ id: 'job-1', status: 'queued', quota: { cost: 300 }, replayed: true }))
  const done = submitCloudJob(submit)
  await vi.runAllTimersAsync()
  await expect(done).resolves.toMatchObject({ id: 'job-1', replayed: true })
  expect(cloudFetch).toHaveBeenCalledTimes(2)
  const ids = cloudFetch.mock.calls.map((c) => JSON.parse(c[1].body).params.client_request_id)
  expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/)
  expect(ids[1]).toBe(ids[0])
})

it('a lost connection and a gateway error are retried too, a real refusal is not', async () => {
  cloudFetch
    .mockRejectedValueOnce(new CloudJobError('Could not reach the LU Cloud server.', 0))
    .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
    .mockResolvedValueOnce(ok({ id: 'job-2', quota: { cost: 300 } }))
  const done = submitCloudJob({ ...submit, params: { op: 'generate', client_request_id: '11111111-2222-4333-8444-555555555555' } })
  await vi.runAllTimersAsync()
  await expect(done).resolves.toMatchObject({ id: 'job-2' })
  expect(cloudFetch.mock.calls.every((c) => JSON.parse(c[1].body).params.client_request_id === '11111111-2222-4333-8444-555555555555')).toBe(true)

  cloudFetch.mockReset()
  cloudFetch.mockResolvedValue(new Response(JSON.stringify({ error: 'credits exhausted', code: 'credits_exhausted' }), { status: 429 }))
  const refused = submitCloudJob(submit)
  const settled = expect(refused).rejects.toMatchObject({ status: 429 })
  await vi.runAllTimersAsync()
  await settled
  expect(cloudFetch).toHaveBeenCalledTimes(1)
})

it('gives up after three tries and says so', async () => {
  cloudFetch.mockRejectedValue(new CloudJobError('the cloud did not answer in time', 408))
  const done = submitCloudJob(submit)
  const settled = expect(done).rejects.toMatchObject({ status: 408 })
  await vi.runAllTimersAsync()
  await settled
  expect(cloudFetch).toHaveBeenCalledTimes(3)
})
