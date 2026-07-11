import type { H3Event } from 'h3'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  consume: vi.fn(),
  fetchWithTimeout: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('h3', () => ({
  createError: (error: unknown) => error,
  getMethod: (event: TestEvent) => event.method,
  getRequestURL: (event: TestEvent) => new URL(event.url),
  setResponseHeaders: vi.fn(),
  setResponseStatus: vi.fn(),
}))

vi.mock('~/server/utils/fetchWithTimeout', () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}))

vi.mock('~/server/utils/rate-limit', () => ({
  createRateLimiter: () => ({ consume: mocks.consume }),
}))

vi.mock('~/server/utils/logger', () => ({
  logger: { info: mocks.info, warn: mocks.warn },
}))

type TestEvent = H3Event & {
  method: string
  url: string
}

const handler = (await import('~/server/api/internal/proxy/merkl/[...path]')).default

const makeEvent = (url: string): TestEvent => ({
  method: 'GET',
  url,
  context: {},
  node: {
    req: {
      headers: { 'cf-connecting-ip': '127.0.0.1' },
      socket: {},
    },
    res: {},
  },
} as unknown as TestEvent)

describe('/api/internal/proxy/merkl route', () => {
  afterEach(() => vi.clearAllMocks())

  it('records aborts as soft upstream timeouts without forwarding error text', async () => {
    mocks.fetchWithTimeout.mockRejectedValueOnce(new DOMException('attacker-controlled text', 'AbortError'))
    const event = makeEvent('https://app.example/api/internal/proxy/merkl/opportunities?chainId=1&type=EULER&campaigns=true')

    await expect(handler(event)).rejects.toMatchObject({
      statusCode: 504,
      statusMessage: 'Merkl upstream timed out',
    })

    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: 'merkl-proxy',
        pathTemplate: '/v4/opportunities',
        reason: 'upstream-timeout',
      }),
      'upstream timed out',
    )
    expect(mocks.warn).not.toHaveBeenCalled()
    const [fields] = mocks.info.mock.calls[0]
    expect(fields).not.toHaveProperty('err')
    expect(JSON.stringify(fields)).not.toContain('attacker-controlled text')
  })
})
