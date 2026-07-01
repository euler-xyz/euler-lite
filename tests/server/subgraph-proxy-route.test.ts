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

const handler = (await import('~/server/api/proxy/subgraph/[chainId].post')).default

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

describe('/api/proxy/subgraph route', () => {
  afterEach(() => {
    delete process.env.SUBGRAPH_URL_1
    delete process.env.NUXT_PUBLIC_SUBGRAPH_URI_1
    vi.clearAllMocks()
  })

  it('returns a sanitized 502 when the configured upstream URL is malformed', async () => {
    process.env.SUBGRAPH_URL_1 = 'not a url'
    mocks.forwardProxied.mockRejectedValueOnce(new TypeError('Invalid URL'))

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
      }),
      'upstream failed',
    )
    expect(JSON.stringify(mocks.warn.mock.calls[0][0])).not.toContain('not a url')
  })
})
