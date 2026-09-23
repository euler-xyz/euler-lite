import type { H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  consume: vi.fn(),
  fetch: vi.fn(),
  resolveRpcUrl: vi.fn(),
  warn: vi.fn(),
  rateLimiterConfigs: [] as Array<{ max: number, windowMs: number, label: string }>,
}))

vi.mock('h3', () => ({
  createError: (error: unknown) => error,
  getMethod: (event: TestEvent) => event.method,
  readBody: (event: TestEvent) => event.body,
  setResponseHeader: (event: TestEvent, name: string, value: string) => {
    event.context.responseHeaders = {
      ...event.context.responseHeaders,
      [name]: value,
    }
  },
  setResponseStatus: (event: TestEvent, status: number) => {
    event.context.status = status
  },
}))

vi.mock('~/server/utils/logger', () => ({
  logger: { warn: mocks.warn },
}))

vi.mock('~/server/utils/rate-limit', () => ({
  createRateLimiter: (config: { max: number, windowMs: number, label: string }) => {
    mocks.rateLimiterConfigs.push(config)
    return { consume: mocks.consume }
  },
}))

vi.mock('~/server/utils/rpc', () => ({
  resolveRpcUrl: mocks.resolveRpcUrl,
}))

vi.mock('~/utils/errorHandling', () => ({
  isAbortError: () => false,
}))

type TestEvent = H3Event & {
  method: string
  body?: unknown
  context: {
    params?: { chainId?: string }
    responseHeaders?: Record<string, string>
    status?: number
  }
}

type RpcRequest = {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

const ADDRESS = '0x0000000000000000000000000000000000000001'
const OTHER_ADDRESS = '0x0000000000000000000000000000000000000002'
const TOPIC = `0x${'11'.repeat(32)}`
const BLOCK_HASH = `0x${'22'.repeat(32)}`

const handler = (await import('~/server/api/internal/rpc/[chainId]')).default

const rpcRequest = (method: string, params?: unknown, id = 1): RpcRequest => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params === undefined ? {} : { params }),
})

const quantity = (value: bigint | number) => `0x${BigInt(value).toString(16)}`

const makeEvent = (body?: unknown, overrides: { chainId?: string, method?: string } = {}): TestEvent => ({
  method: overrides.method ?? 'POST',
  body,
  context: { params: { chainId: overrides.chainId ?? '1' } },
  node: {
    req: {
      headers: { 'cf-connecting-ip': '127.0.0.1' },
      socket: {},
    },
    res: {},
  },
} as unknown as TestEvent)

const storage = (count: number) => Object.fromEntries(
  Array.from({ length: count }, (_, index) => [
    `0x${index.toString(16).padStart(64, '0')}`,
    `0x${(index + 1).toString(16).padStart(64, '0')}`,
  ]),
)

const compactStorage = (count: number) => Object.fromEntries(
  Array.from({ length: count }, (_, index) => [`slot-${index}`, '0x00']),
)

const accounts = (count: number) => Object.fromEntries(
  Array.from({ length: count }, (_, index) => [
    `0x${index.toString(16).padStart(40, '0')}`,
    {},
  ]),
)

describe('/api/internal/rpc route', () => {
  beforeEach(() => {
    mocks.resolveRpcUrl.mockReturnValue('https://rpc.example')
    mocks.fetch.mockResolvedValue(new Response('{"jsonrpc":"2.0","id":1,"result":"0x1"}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', mocks.fetch)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('uses the shared 10,000-unit app-server budget', () => {
    expect(mocks.rateLimiterConfigs).toContainEqual({
      max: 10_000,
      windowMs: 60_000,
      label: 'rpc',
    })
  })

  it.each([
    ['cheap RPC method', rpcRequest('eth_blockNumber'), 1],
    ['small eth_call', rpcRequest('eth_call', [{ to: ADDRESS, data: '0x12345678' }, 'latest']), 2],
    ['eth_estimateGas', rpcRequest('eth_estimateGas', [{ to: ADDRESS, data: '0x12345678' }]), 10],
    ['eth_createAccessList', rpcRequest('eth_createAccessList', [{ to: ADDRESS, data: '0x12345678' }, 'latest']), 10],
    ['block headers only', rpcRequest('eth_getBlockByNumber', ['latest', false]), 1],
    ['full block response', rpcRequest('eth_getBlockByNumber', ['latest', true]), 5],
    [
      '10,000-block filtered log range',
      rpcRequest('eth_getLogs', [{ fromBlock: '0x1', toBlock: quantity(10_000), address: ADDRESS }]),
      14,
    ],
    ['128-block fee history', rpcRequest('eth_feeHistory', ['0x80', 'latest', [10, 50, 90]]), 9],
  ])('charges the exact cost for %s', async (_label, request, expectedCost) => {
    const event = makeEvent(request)

    await expect(handler(event)).resolves.toContain('"result":"0x1"')

    expect(mocks.consume).toHaveBeenCalledWith(event, expectedCost)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })

  it('adds calldata, gas, and state-override complexity to an SDK-shaped eth_call', async () => {
    const request = rpcRequest('eth_call', [
      {
        from: ADDRESS,
        to: OTHER_ADDRESS,
        data: `0x${'12'.repeat(16 * 1024 + 1)}`,
        gas: quantity(5_000_001),
      },
      'latest',
      {
        [ADDRESS]: {
          stateDiff: storage(17),
          code: `0x${'34'.repeat(16 * 1024 + 1)}`,
        },
        [OTHER_ADDRESS]: {},
      },
    ])
    const event = makeEvent(request)

    await handler(event)

    // base 2 + calldata 1 + gas 1 + override (5 + 2 accounts + 2 slot chunks + 2 code chunks)
    expect(mocks.consume).toHaveBeenCalledWith(event, 15)
  })

  it('charges every operation in a maximum-size batch', async () => {
    const batch = Array.from({ length: 100 }, (_, id) => rpcRequest('eth_blockNumber', undefined, id))
    const event = makeEvent(batch)

    await handler(event)

    expect(mocks.consume).toHaveBeenCalledOnce()
    expect(mocks.consume).toHaveBeenCalledWith(event, 100)
    expect(mocks.fetch).toHaveBeenCalledOnce()
  })

  it('accepts representative Viem log and fee-history request shapes', async () => {
    const event = makeEvent([
      rpcRequest('eth_getLogs', [{ blockHash: BLOCK_HASH, topics: [TOPIC, null] }], 1),
      rpcRequest('eth_getLogs', [{ fromBlock: '0x100', toBlock: '0x120', address: [ADDRESS, OTHER_ADDRESS], topics: [[TOPIC]] }], 2),
      rpcRequest('eth_feeHistory', ['0x10', 'latest', null], 3),
      rpcRequest('eth_getLogs', [{ fromBlock: 'latest', toBlock: 'latest', topics: [Array(20).fill(TOPIC), Array(20).fill(TOPIC)] }], 4),
    ])

    await handler(event)

    expect(mocks.consume).toHaveBeenCalledWith(event, 17)
    expect(mocks.fetch).toHaveBeenCalledOnce()
  })

  it.each([
    ['oversized params JSON', rpcRequest('eth_blockNumber', ['x'.repeat(256 * 1024 + 1)]), 413],
    ['oversized calldata', rpcRequest('eth_call', [{ data: `0x${'11'.repeat(256 * 1024 + 1)}` }, 'latest']), 413],
    ['excessive explicit gas', rpcRequest('eth_call', [{ gas: quantity(50_000_001) }, 'latest']), 400],
    ['too many override accounts', rpcRequest('eth_call', [{}, 'latest', accounts(129)]), 400],
    ['too many override slots', rpcRequest('eth_call', [{}, 'latest', { [ADDRESS]: { stateDiff: compactStorage(2_049) } }]), 400],
    ['too much override code', rpcRequest('eth_call', [{}, 'latest', { [ADDRESS]: { code: `0x${'11'.repeat(64 * 1024 + 1)}` } }]), 400],
    ['too many fee-history blocks', rpcRequest('eth_feeHistory', ['0x81', 'latest', []]), 400],
    ['too many fee-history percentiles', rpcRequest('eth_feeHistory', ['0x1', 'latest', Array.from({ length: 21 }, (_, index) => index)]), 400],
    ['unsorted fee-history percentiles', rpcRequest('eth_feeHistory', ['0x1', 'latest', [50, 10]]), 400],
    ['unbounded logs', rpcRequest('eth_getLogs', [{ address: ADDRESS }]), 400],
    ['oversized log range', rpcRequest('eth_getLogs', [{ fromBlock: '0x1', toBlock: quantity(10_001), address: ADDRESS }]), 400],
    ['mixed numeric/latest log range', rpcRequest('eth_getLogs', [{ fromBlock: '0x1', toBlock: 'latest', address: ADDRESS }]), 400],
    ['unfiltered logs', rpcRequest('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x2' }]), 400],
    ['too many log addresses', rpcRequest('eth_getLogs', [{ blockHash: BLOCK_HASH, address: Array.from({ length: 21 }, () => ADDRESS) }]), 400],
    ['too many topic positions', rpcRequest('eth_getLogs', [{ blockHash: BLOCK_HASH, topics: [TOPIC, TOPIC, TOPIC, TOPIC, TOPIC] }]), 400],
    ['too many topic alternatives', rpcRequest('eth_getLogs', [{ blockHash: BLOCK_HASH, topics: [Array.from({ length: 21 }, () => TOPIC)] }]), 400],
  ])('rejects %s before consuming budget or contacting upstream', async (_label, request, statusCode) => {
    await expect(handler(makeEvent(request))).rejects.toMatchObject({ statusCode })

    expect(mocks.consume).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('stops before the upstream fetch when the weighted limiter rejects a request', async () => {
    mocks.consume.mockImplementationOnce(() => {
      throw { statusCode: 429, statusMessage: 'Too Many Requests' }
    })

    await expect(handler(makeEvent(rpcRequest('eth_estimateGas', [{ to: ADDRESS }])))).rejects.toMatchObject({
      statusCode: 429,
      statusMessage: 'Too Many Requests',
    })

    expect(mocks.consume).toHaveBeenCalledWith(expect.anything(), 10)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['missing body', makeEvent(), 400],
    ['empty batch', makeEvent([]), 400],
    ['oversized batch', makeEvent(Array.from({ length: 101 }, (_, id) => rpcRequest('eth_blockNumber', undefined, id))), 400],
    ['invalid JSON-RPC request', makeEvent({ jsonrpc: '1.0', id: 1, method: 'eth_call' }), 403],
    ['disallowed method', makeEvent(rpcRequest('eth_sendRawTransaction', ['0x00'])), 403],
    ['invalid chain', makeEvent(rpcRequest('eth_blockNumber'), { chainId: 'invalid' }), 400],
    ['invalid HTTP method', makeEvent(rpcRequest('eth_blockNumber'), { method: 'GET' }), 405],
  ])('preserves %s validation before rate limiting', async (_label, event, statusCode) => {
    await expect(handler(event)).rejects.toMatchObject({ statusCode })

    expect(mocks.consume).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('preserves the validated request body and upstream response metadata', async () => {
    const request = rpcRequest('eth_getBalance', [ADDRESS, 'latest'])
    const event = makeEvent(request)

    await expect(handler(event)).resolves.toContain('"result":"0x1"')

    expect(mocks.fetch).toHaveBeenCalledWith('https://rpc.example', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(request),
      headers: { 'content-type': 'application/json' },
    }))
    expect(event.context.status).toBe(200)
    expect(event.context.responseHeaders?.['content-type']).toBe('application/json')
  })
})
