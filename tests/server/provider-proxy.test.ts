import type { H3Event } from 'h3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProviderProxy, upstreamFromEnv } from '~/server/utils/provider-proxy'

const mocks = vi.hoisted(() => ({
  consume: vi.fn(),
  fetchWithTimeout: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  readRawBody: vi.fn(),
  setResponseHeaders: vi.fn(),
  setResponseStatus: vi.fn(),
}))

vi.mock('h3', () => ({
  createError: (error: unknown) => error,
  getMethod: (event: TestEvent) => event.method,
  getRequestURL: (event: TestEvent) => new URL(event.url),
  readRawBody: mocks.readRawBody,
  setResponseHeaders: mocks.setResponseHeaders,
  setResponseStatus: mocks.setResponseStatus,
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

type TestEvent = H3Event & { method: string, url: string }

const makeEvent = (url: string, method = 'GET'): TestEvent => ({
  method,
  url,
  context: {},
  node: { req: { headers: {}, socket: {} }, res: {} },
} as unknown as TestEvent)

const upstreamResponse = (status: number, body: string) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  text: async () => body,
})

const PREFIX = '/api/internal/proxy/acme/'
const OK_URL = `https://app.example${PREFIX}things?chainId=1`

const baseConfig = {
  name: 'Acme',
  ctx: 'acme-proxy',
  prefix: PREFIX,
  upstream: 'https://api.acme.example/v1',
  methods: ['GET', 'HEAD'] as const,
  allow: (_method: string, path: string) => path === 'things',
  rateLimit: { max: 10, windowMs: 60_000 },
  cache: { ttlMs: 60_000, browser: 'public, max-age=30' },
}

const everythingLogged = () => JSON.stringify([...mocks.warn.mock.calls, ...mocks.info.mock.calls])

describe('createProviderProxy', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it('forwards an allowed request and reports cache state to the browser', async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(upstreamResponse(200, '{"ok":true}'))
    const handler = createProviderProxy(baseConfig)

    const body = await handler(makeEvent(OK_URL))

    expect(body).toBe('{"ok":true}')
    expect(mocks.consume).toHaveBeenCalledTimes(1)
    const [target, , init] = mocks.fetchWithTimeout.mock.calls[0]
    expect(target).toBe('https://api.acme.example/v1/things?chainId=1')
    expect(init).toMatchObject({ method: 'GET', headers: { accept: 'application/json' } })
    expect(init.redirect).toBeUndefined()
    expect(mocks.setResponseStatus).toHaveBeenCalledWith(expect.anything(), 200, 'OK')
    expect(mocks.setResponseHeaders).toHaveBeenCalledWith(expect.anything(), {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=30',
      'x-cache': 'miss',
    })
  })

  it('serves a second identical request from the server cache', async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(upstreamResponse(200, '[1]'))
    const handler = createProviderProxy(baseConfig)

    await handler(makeEvent(OK_URL))
    const body = await handler(makeEvent(OK_URL))

    expect(body).toBe('[1]')
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1)
    expect(mocks.setResponseHeaders).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ 'x-cache': 'hit' }))
  })

  it('bypasses the server cache when configured, still forwarding every request', async () => {
    mocks.fetchWithTimeout.mockResolvedValue(upstreamResponse(200, '[]'))
    const handler = createProviderProxy({ ...baseConfig, cache: { ttlMs: 0, bypass: true, browser: 'no-store' } })

    await handler(makeEvent(OK_URL))
    await handler(makeEvent(OK_URL))

    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(2)
    expect(mocks.setResponseHeaders).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      'cache-control': 'no-store',
      'x-cache': 'bypass',
    }))
  })

  it('rejects methods outside the allowlist with 405 before touching the rate limiter', async () => {
    const handler = createProviderProxy(baseConfig)

    await expect(handler(makeEvent(OK_URL, 'POST'))).rejects.toMatchObject({ statusCode: 405 })

    expect(mocks.consume).not.toHaveBeenCalled()
    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled()
    expect(mocks.warn).toHaveBeenCalledWith(expect.objectContaining({ ctx: 'acme-proxy', reason: 'invalid-method' }), 'request rejected')
  })

  it('rejects requests outside the prefix and outside the allowlist with 404', async () => {
    const handler = createProviderProxy(baseConfig)

    await expect(handler(makeEvent('https://app.example/api/internal/proxy/other/things'))).rejects.toMatchObject({
      statusCode: 404,
      statusMessage: 'Not a acme proxy path',
    })
    await expect(handler(makeEvent(`https://app.example${PREFIX}secrets?user=0xabc`))).rejects.toMatchObject({
      statusCode: 404,
      statusMessage: 'Acme path not allowed',
    })

    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled()
    expect(mocks.warn).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: 'path-not-allowed', pathTemplate: '/secrets', searchKeys: ['user'] }),
      'request rejected',
    )
    expect(everythingLogged()).not.toContain('0xabc')
  })

  it('fails closed with 503 when a required credential is missing', async () => {
    const handler = createProviderProxy({ ...baseConfig, headers: () => undefined })

    await expect(handler(makeEvent(OK_URL))).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: 'Acme API key not configured',
    })

    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled()
    expect(mocks.warn).toHaveBeenCalledWith(expect.objectContaining({ ctx: 'acme-proxy', reason: 'missing-api-key' }), 'request rejected')
  })

  it('sends configured headers and redirect policy, never caller headers', async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(upstreamResponse(200, '[]'))
    const handler = createProviderProxy({
      ...baseConfig,
      headers: () => ({ 'accept': 'application/json', 'X-API-Key': 'secret' }),
      redirect: 'manual',
    })
    const event = makeEvent(OK_URL)
    event.node.req.headers = { 'x-api-key': 'attacker', 'authorization': 'Bearer attacker' }

    await handler(event)

    const [, , init] = mocks.fetchWithTimeout.mock.calls[0]
    expect(init.headers).toEqual({ 'accept': 'application/json', 'X-API-Key': 'secret' })
    expect(init.redirect).toBe('manual')
  })

  it('forwards the raw body with a JSON content type for POST proxies', async () => {
    mocks.readRawBody.mockResolvedValueOnce('{"q":1}')
    mocks.fetchWithTimeout.mockResolvedValueOnce(upstreamResponse(200, '{}'))
    const handler = createProviderProxy({ ...baseConfig, methods: ['POST'], forwardBody: true })

    await handler(makeEvent(OK_URL, 'POST'))

    const [, , init] = mocks.fetchWithTimeout.mock.calls[0]
    expect(init).toMatchObject({
      method: 'POST',
      body: '{"q":1}',
      headers: { 'accept': 'application/json', 'content-type': 'application/json' },
    })
  })

  it('applies rewriteTarget to the upstream URL', async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(upstreamResponse(200, '[]'))
    const handler = createProviderProxy({
      ...baseConfig,
      rewriteTarget: (target) => {
        if (!target.searchParams.has('type')) target.searchParams.set('type', 'TOKEN')
      },
    })

    await handler(makeEvent(OK_URL))

    expect(mocks.fetchWithTimeout.mock.calls[0][0]).toBe('https://api.acme.example/v1/things?chainId=1&type=TOKEN')
  })

  it('re-reads an env-driven upstream per request', async () => {
    mocks.fetchWithTimeout.mockResolvedValue(upstreamResponse(200, '[]'))
    const handler = createProviderProxy({
      ...baseConfig,
      cache: { ...baseConfig.cache, bypass: true },
      upstream: upstreamFromEnv(['ACME_API_URL', 'NUXT_PUBLIC_ACME_API_URL'], 'https://api.acme.example/v1'),
    })

    await handler(makeEvent(OK_URL))
    vi.stubEnv('NUXT_PUBLIC_ACME_API_URL', 'https://staging.acme.example/v2/')
    await handler(makeEvent(OK_URL))

    expect(mocks.fetchWithTimeout.mock.calls[0][0]).toBe('https://api.acme.example/v1/things?chainId=1')
    expect(mocks.fetchWithTimeout.mock.calls[1][0]).toBe('https://staging.acme.example/v2/things?chainId=1')
  })

  it('maps upstream timeouts to a 504 logged at info without error text', async () => {
    mocks.fetchWithTimeout.mockRejectedValueOnce(new DOMException('attacker-controlled text', 'AbortError'))
    const handler = createProviderProxy(baseConfig)

    await expect(handler(makeEvent(OK_URL))).rejects.toMatchObject({
      statusCode: 504,
      statusMessage: 'Acme upstream timed out',
    })

    expect(mocks.warn).not.toHaveBeenCalled()
    const [fields] = mocks.info.mock.calls[0]
    expect(fields).toMatchObject({
      ctx: 'acme-proxy',
      upstreamHost: 'api.acme.example',
      pathTemplate: '/v1/things',
      reason: 'upstream-timeout',
    })
    expect(fields).not.toHaveProperty('err')
    expect(everythingLogged()).not.toContain('attacker-controlled text')
  })

  it('maps upstream non-2xx responses to a sanitized 502', async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(upstreamResponse(401, '{"error":"invalid key secret"}'))
    const handler = createProviderProxy(baseConfig)

    const failure = await handler(makeEvent(OK_URL)).catch((err: unknown) => err)

    expect(failure).toMatchObject({ statusCode: 502, statusMessage: 'Acme upstream unavailable' })
    expect(JSON.stringify(failure)).not.toContain('invalid key')
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: 'acme-proxy',
        upstreamHost: 'api.acme.example',
        pathTemplate: '/v1/things',
        err: expect.objectContaining({ status: 401 }),
      }),
      'upstream failed',
    )
    expect(everythingLogged()).not.toContain('invalid key')
  })

  it('serves stale cache on upstream failure once a response has been cached', async () => {
    mocks.fetchWithTimeout
      .mockResolvedValueOnce(upstreamResponse(200, '[1]'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
    const handler = createProviderProxy({ ...baseConfig, cache: { ttlMs: 60_000, browser: 'no-cache' } })
    vi.useFakeTimers()

    try {
      await handler(makeEvent(OK_URL))
      vi.advanceTimersByTime(90_000) // past the TTL, inside the stale window
      const body = await handler(makeEvent(OK_URL))

      expect(body).toBe('[1]')
      expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(2)
      expect(mocks.setResponseHeaders).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ 'x-cache': 'stale-fallback' }))
    }
    finally {
      vi.useRealTimers()
    }
  })
})
