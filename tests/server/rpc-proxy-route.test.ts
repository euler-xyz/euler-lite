import type { H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type TestEvent = H3Event & {
  body: unknown
  context: {
    params: { chainId: string }
    responseHeaders: Record<string, string>
    status?: number
  }
}

vi.mock('h3', () => ({
  createError: (error: unknown) => error,
  getMethod: () => 'POST',
  readBody: (event: TestEvent) => event.body,
  setResponseHeader: (event: TestEvent, name: string, value: string) => {
    event.context.responseHeaders[name] = value
  },
  setResponseStatus: (event: TestEvent, status: number) => {
    event.context.status = status
  },
}))

vi.mock('~/server/utils/logger', () => ({ logger: { warn: vi.fn() } }))

// Keep the real rate limiter and edge identity handling; only the HTTP and
// upstream network boundaries are stubbed.
const handler = (await import('~/server/api/internal/rpc/[chainId]')).default
const fetchMock = vi.fn()
const request = (method = 'eth_chainId', id: number | string | null = 1, params: unknown = []) => ({
  jsonrpc: '2.0', method, id, params,
})
const batch = (size = 100) => Array.from({ length: size }, (_, id) => request('eth_call', id, [{ to: '0x0000000000000000000000000000000000000001', data: '0x' }, 'latest']))

let client = 0
const makeEvent = (body: unknown, ip = `203.0.113.${client}`, chainId = '1'): TestEvent => ({
  body,
  context: { params: { chainId }, responseHeaders: {} },
  node: { req: { headers: { 'cf-connecting-ip': ip }, socket: {} }, res: {} },
} as unknown as TestEvent)

const consumeCalls = async (count: number) => {
  for (let i = 0; i < count; i++) await handler(makeEvent(batch()))
}

beforeEach(() => {
  client++
  vi.stubEnv('EDGE_PROVIDER', 'cloudflare')
  vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
  vi.stubEnv('EDGE_ORIGIN_SECRET', '')
  vi.stubEnv('DISABLE_RATE_LIMIT', '')
  vi.stubEnv('RPC_URL_1', 'https://rpc.example.test/one')
  vi.stubEnv('RPC_URL_2', 'https://rpc.example.test/two')
  vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
  fetchMock.mockReset().mockImplementation(async () => new Response('{"jsonrpc":"2.0","id":1,"result":"0x1"}', {
    headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('/api/internal/rpc batch budget', () => {
  it('allows 10,000 calls in 100-call batches, then rejects before forwarding', async () => {
    await consumeCalls(100)
    await expect(handler(makeEvent(batch()))).rejects.toMatchObject({ statusCode: 429, statusMessage: 'Too Many Requests' })
    expect(fetchMock).toHaveBeenCalledTimes(100)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(batch())
  })

  it('rejects an unaffordable batch atomically and admits the remaining calls', async () => {
    await consumeCalls(99)
    await handler(makeEvent(request()))
    await expect(handler(makeEvent(batch()))).rejects.toMatchObject({ statusCode: 429 })
    expect(fetchMock).toHaveBeenCalledTimes(100)
    await handler(makeEvent(batch(99)))
    await expect(handler(makeEvent(request()))).rejects.toMatchObject({ statusCode: 429 })
    expect(fetchMock).toHaveBeenCalledTimes(101)
  })

  it('shares the per-client budget across chains and isolates other clients', async () => {
    await consumeCalls(100)
    await expect(handler(makeEvent(request(), undefined, '2'))).rejects.toMatchObject({ statusCode: 429 })
    await expect(handler(makeEvent(batch(), '198.51.100.1', '2'))).resolves.toBeDefined()
    expect(fetchMock).toHaveBeenCalledTimes(101)
  })

  it('resets the budget at the window boundary', async () => {
    await consumeCalls(100)
    vi.mocked(Date.now).mockReturnValue(1_059_999)
    await expect(handler(makeEvent(request()))).rejects.toMatchObject({ statusCode: 429 })
    vi.mocked(Date.now).mockReturnValue(1_060_000)
    await handler(makeEvent(batch()))
    expect(fetchMock).toHaveBeenCalledTimes(101)
  })

  it('admits only one concurrent batch when one batch worth of budget remains', async () => {
    await consumeCalls(99)
    const results = await Promise.allSettled([handler(makeEvent(batch())), handler(makeEvent(batch()))])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { statusCode: 429 } })
    expect(fetchMock).toHaveBeenCalledTimes(100)
  })

  it('rejects invalid batches before consuming budget or forwarding any entry', async () => {
    const invalidBodies = [
      { body: [], status: 400 },
      { body: batch(101), status: 400 },
      { body: [request(), request('eth_sendRawTransaction')], status: 403 },
      { body: [request(), { jsonrpc: '2.0', method: 'eth_call' }], status: 403 },
      { body: [request(), [request()]], status: 403 },
      { body: [request(), null], status: 403 },
    ]
    for (const { body, status } of invalidBodies) {
      await expect(handler(makeEvent(body))).rejects.toMatchObject({ statusCode: status })
    }
    expect(fetchMock).not.toHaveBeenCalled()
    await consumeCalls(100)
    await expect(handler(makeEvent(request()))).rejects.toMatchObject({ statusCode: 429 })
    expect(fetchMock).toHaveBeenCalledTimes(100)
  })

  it('preserves singles, one-element batches, multicall calldata and read methods', async () => {
    const multicall = request('eth_call', 'multicall', [{ to: '0x0000000000000000000000000000000000000001', data: '0xabcdef' }, 'latest'])
    const bodies = [request(), [request('net_version', null)], [multicall, request('eth_getLogs'), request('eth_createAccessList')]]
    for (const body of bodies) {
      const event = makeEvent(body)
      await expect(handler(event)).resolves.toBe('{"jsonrpc":"2.0","id":1,"result":"0x1"}')
      expect(event.context.status).toBe(200)
      expect(event.context.responseHeaders['content-type']).toBe('application/json')
      expect(fetchMock).toHaveBeenLastCalledWith('https://rpc.example.test/one', expect.objectContaining({ body: JSON.stringify(body) }))
    }
    // The five admitted calls leave 9,995 units: 99 full batches and 95 calls.
    await consumeCalls(99)
    await handler(makeEvent(batch(95)))
    await expect(handler(makeEvent(request()))).rejects.toMatchObject({ statusCode: 429 })
  })
})
