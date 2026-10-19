import type { H3Event } from 'h3'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  consume: vi.fn(),
  forwardProxied: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('h3', () => ({
  createError: (error: unknown) => error,
  getMethod: (event: TestEvent) => event.method,
  getRouterParam: (event: TestEvent, name: string) => event.params[name],
  readRawBody: (event: TestEvent) => event.body,
  setResponseHeaders: (event: TestEvent, headers: Record<string, string>) => {
    event.context.responseHeaders = {
      ...event.context.responseHeaders,
      ...headers,
    }
  },
  setResponseStatus: (event: TestEvent, status: number, statusText?: string) => {
    event.context.status = status
    event.context.statusText = statusText
  },
}))

vi.mock('~/server/utils/rate-limit', () => ({
  createRateLimiter: () => ({ consume: mocks.consume }),
}))

vi.mock('~/server/utils/logger', () => ({
  logger: { warn: mocks.warn },
}))

vi.mock('~/server/utils/external-proxy', () => ({
  createProxyCache: () => ({}),
  createProxyInFlight: () => ({}),
  forwardProxied: mocks.forwardProxied,
}))

type TestEvent = H3Event & {
  method: string
  params: Record<string, string>
  body?: string
  context: {
    responseHeaders?: Record<string, string>
    status?: number
    statusText?: string
  }
}

const handler = (await import('~/server/api/internal/proxy/subgraph/[chainId].post')).default

const makeEvent = (chainId: string, body = '{"query":"{ vaults { id } }"}'): TestEvent => ({
  method: 'POST',
  params: { chainId },
  body,
  context: {},
  node: {
    req: {
      headers: {
        'cf-connecting-ip': '127.0.0.1',
      },
      socket: {},
    },
    res: {},
  },
} as unknown as TestEvent)

describe('/api/internal/proxy/subgraph route', () => {
  afterEach(() => {
    delete process.env.SUBGRAPH_URL_1
    delete process.env.NUXT_PUBLIC_SUBGRAPH_URI_1
    delete process.env.SUBGRAPH_CATALOG_URL
    delete process.env.SUBGRAPH_DISABLED_1
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('returns a sanitized 502 when the configured upstream URL is malformed', async () => {
    process.env.SUBGRAPH_URL_1 = 'not a url'
    mocks.forwardProxied.mockRejectedValueOnce(new TypeError('Failed to parse URL from not a url'))

    await expect(handler(makeEvent('1'))).rejects.toMatchObject({
      statusCode: 502,
      statusMessage: 'Subgraph upstream unavailable',
    })

    expect(mocks.forwardProxied).toHaveBeenCalledWith(expect.objectContaining({
      target: 'not a url',
    }))
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: 'subgraph-proxy',
        chainId: 1,
        searchKeys: [],
        err: {
          name: 'TypeError',
        },
      }),
      'upstream failed',
    )
    expect(JSON.stringify(mocks.warn.mock.calls[0][0])).not.toContain('not a url')
  })
  it('resolves catalog metadata, rejects identity drift, and keeps data no-store', async () => {
    process.env.SUBGRAPH_CATALOG_URL = 'https://fixture.example/catalog'
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ schemaVersion: 1, revision: 'r1', publishedAt: '2026-10-19T00:00:00Z', deployments: [
      { chainId: 1, family: 'euler-simple', channel: 'stable', status: 'active', version: '1.0.0', endpoint: 'https://index.example/query', deploymentId: 'cid-1', sourceCommit: 'a'.repeat(40), startBlock: 0, capabilities: ['account-vault-discovery', 'vault-factory-lookup'] },
      { chainId: 2, family: 'euler-simple', channel: 'stable', status: 'retired' },
    ] })))
    mocks.forwardProxied.mockResolvedValue({ status: 200, statusText: 'OK', contentType: 'application/json', body: JSON.stringify({ data: { _meta: { deployment: 'cid-1' } } }), cacheState: 'bypass' })
    const event = makeEvent('1')
    await handler(event)
    expect(mocks.forwardProxied).toHaveBeenCalledWith(expect.objectContaining({ target: 'https://index.example/query', bypassCache: true, redirect: 'error' }))
    expect(event.context.responseHeaders).toMatchObject({ 'cache-control': 'no-store' })
    expect(event.context.responseHeaders?.['x-subgraph-source']).toMatch(/^[a-f0-9]{64}$/)
    mocks.forwardProxied.mockResolvedValue({ status: 200, body: JSON.stringify({ data: { _meta: { deployment: 'another-cid' } } }) })
    await expect(handler(makeEvent('1'))).rejects.toMatchObject({ statusCode: 502 })
    await expect(handler(makeEvent('2'))).rejects.toMatchObject({ statusCode: 503, statusMessage: 'Subgraph unavailable: retired' })
  })

  it('never forwards a disabled chain even with a configured private upstream', async () => {
    process.env.SUBGRAPH_DISABLED_1 = 'true'
    process.env.SUBGRAPH_URL_1 = 'http://private/query?secret=abc'
    await expect(handler(makeEvent('1'))).rejects.toMatchObject({ statusCode: 503, statusMessage: 'Subgraph unavailable: disabled' })
    expect(mocks.forwardProxied).not.toHaveBeenCalled()
  })
})
