/**
 * Rate-limit accounting for the JSON-RPC proxy.
 *
 * docs/architecture.md documents the RPC proxy budget as "10,000 units (batch
 * of N costs N)". A batch is one HTTP request but N upstream calls, so charging
 * a flat 1 unit would let a client drive MAX_BATCH_SIZE (100) times the
 * intended volume against the paid provider. These tests pin the cost to the
 * fan-out.
 */
import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  consume: vi.fn(),
  warn: vi.fn(),
  resolveRpcUrl: vi.fn(() => 'https://rpc.example.com/secret-key'),
}))

vi.mock('h3', () => ({
  createError: (error: unknown) => error,
  getMethod: (event: TestEvent) => event.method,
  readBody: (event: TestEvent) => event.body,
  setResponseHeader: () => {},
  setResponseStatus: () => {},
}))

vi.mock('~/server/utils/rate-limit', () => ({
  createRateLimiter: () => ({ consume: mocks.consume }),
}))

vi.mock('~/server/utils/logger', () => ({ logger: { warn: mocks.warn } }))
vi.mock('~/server/utils/rpc', () => ({ resolveRpcUrl: mocks.resolveRpcUrl }))

type TestEvent = H3Event & {
  method: string
  body?: unknown
  context: { params?: Record<string, string> }
}

const handler = (await import('~/server/api/internal/rpc/[chainId]')).default

const rpcCall = (id: number) => ({ jsonrpc: '2.0', id, method: 'eth_call', params: [] })

const makeEvent = (body: unknown): TestEvent => ({
  method: 'POST',
  body,
  context: { params: { chainId: '1' } },
} as unknown as TestEvent)

beforeEach(() => {
  mocks.consume.mockReset()
  mocks.warn.mockReset()
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })))
})

describe('rpc proxy rate-limit cost', () => {
  it('charges 1 unit for a single (non-batch) request', async () => {
    await handler(makeEvent(rpcCall(1)))
    expect(mocks.consume).toHaveBeenCalledWith(expect.anything(), 1)
  })

  it('charges N units for a batch of N calls', async () => {
    const batch = Array.from({ length: 25 }, (_, i) => rpcCall(i))
    await handler(makeEvent(batch))
    expect(mocks.consume).toHaveBeenCalledWith(expect.anything(), 25)
  })

  it('charges the full MAX_BATCH_SIZE for a maximal batch', async () => {
    const batch = Array.from({ length: 100 }, (_, i) => rpcCall(i))
    await handler(makeEvent(batch))
    expect(mocks.consume).toHaveBeenCalledWith(expect.anything(), 100)
  })

  it('rejects an oversize batch before consuming any budget', async () => {
    const batch = Array.from({ length: 101 }, (_, i) => rpcCall(i))
    await expect(handler(makeEvent(batch))).rejects.toMatchObject({ statusCode: 400 })
    expect(mocks.consume).not.toHaveBeenCalled()
  })

  it('rejects a disallowed method before consuming any budget', async () => {
    const body = { jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [] }
    await expect(handler(makeEvent(body))).rejects.toMatchObject({ statusCode: 403 })
    expect(mocks.consume).not.toHaveBeenCalled()
  })
})
