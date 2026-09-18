import type { H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const API_KEY = 'sk_live_turtle_secret_do_not_leak'
const WALLET = '0x0000000000000000000000000000000000000001'
const PROOFS_URL = `https://app.example/api/internal/proxy/turtle/streams/merkle_proofs?wallet=${WALLET}&streamIds=stream-1,stream-2`

const mocks = vi.hoisted(() => ({
  consume: vi.fn(),
  fetchWithTimeout: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  setResponseHeaders: vi.fn(),
  setResponseStatus: vi.fn(),
}))

vi.mock('h3', () => ({
  createError: (error: unknown) => error,
  getMethod: (event: TestEvent) => event.method,
  getRequestURL: (event: TestEvent) => new URL(event.url),
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

type TestEvent = H3Event & {
  method: string
  url: string
}

const handler = (await import('~/server/api/internal/proxy/turtle/[...path]')).default

const makeEvent = (url: string, headers: Record<string, string> = {}): TestEvent => ({
  method: 'GET',
  url,
  context: {},
  node: {
    req: {
      headers: { 'cf-connecting-ip': '127.0.0.1', ...headers },
      socket: {},
    },
    res: {},
  },
} as unknown as TestEvent)

const upstreamResponse = (status: number, body: string) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  text: async () => body,
})

const everythingLogged = () => JSON.stringify([...mocks.warn.mock.calls, ...mocks.info.mock.calls])

describe('/api/internal/proxy/turtle route', () => {
  beforeEach(() => {
    vi.stubEnv('TURTLE_EARN_API_KEY', API_KEY)
    vi.stubEnv('TURTLE_EARN_API_URL', '')
    vi.stubEnv('NUXT_PUBLIC_TURTLE_EARN_API_URL', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it('forwards an allowed reward-proof request with the configured X-API-Key', async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(upstreamResponse(200, '[{"streamId":"stream-1"}]'))

    const body = await handler(makeEvent(PROOFS_URL))

    expect(body).toBe('[{"streamId":"stream-1"}]')
    expect(mocks.consume).toHaveBeenCalledTimes(1)
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1)
    const [target, , init] = mocks.fetchWithTimeout.mock.calls[0]
    expect(target).toBe(`https://earn.turtle.xyz/v1/streams/merkle_proofs?wallet=${WALLET}&streamIds=stream-1,stream-2`)
    expect(init.method).toBe('GET')
    expect(init.headers).toEqual({ 'accept': 'application/json', 'X-API-Key': API_KEY })
    expect(mocks.setResponseHeaders).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      'cache-control': 'no-store',
      'x-cache': 'bypass',
    }))
  })

  it('does not follow upstream redirects, so the key never reaches a redirect target', async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce({
      ...upstreamResponse(302, ''),
      headers: new Headers({ location: 'https://evil.example/capture' }),
    })

    await expect(handler(makeEvent(PROOFS_URL))).rejects.toMatchObject({
      statusCode: 502,
      statusMessage: 'Turtle upstream unavailable',
    })

    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1)
    const [, , init] = mocks.fetchWithTimeout.mock.calls[0]
    expect(init.redirect).toBe('manual')
    expect(everythingLogged()).not.toContain(API_KEY)
    expect(everythingLogged()).not.toContain('evil.example')
  })

  it('ignores a caller-supplied API key header', async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(upstreamResponse(200, '[]'))

    await handler(makeEvent(PROOFS_URL, {
      'x-api-key': 'pk_live_attacker',
      'authorization': 'Bearer attacker',
    }))

    const [, , init] = mocks.fetchWithTimeout.mock.calls[0]
    expect(init.headers).toEqual({ 'accept': 'application/json', 'X-API-Key': API_KEY })
    expect(JSON.stringify(init.headers)).not.toContain('attacker')
  })

  it.each(['', '   '])('fails closed without an upstream request when the key is %j', async (key) => {
    vi.stubEnv('TURTLE_EARN_API_KEY', key)

    await expect(handler(makeEvent(PROOFS_URL))).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: 'Turtle API key not configured',
    })

    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled()
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ctx: 'turtle-proxy', reason: 'missing-api-key' }),
      'request rejected',
    )
  })

  it('does not treat a public runtime variable as the API key', async () => {
    vi.stubEnv('TURTLE_EARN_API_KEY', '')
    vi.stubEnv('NUXT_PUBLIC_TURTLE_EARN_API_KEY', 'pk_live_public')

    await expect(handler(makeEvent(PROOFS_URL))).rejects.toMatchObject({ statusCode: 503 })
    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled()
  })

  it('refuses to send the key to an untrusted upstream override', async () => {
    vi.stubEnv('TURTLE_EARN_API_URL', 'https://evil.example/v1')

    await expect(handler(makeEvent(PROOFS_URL))).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: 'Turtle upstream not configured',
    })

    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled()
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ctx: 'turtle-proxy', reason: 'untrusted-host' }),
      'request rejected',
    )
    expect(everythingLogged()).not.toContain(API_KEY)
  })

  it('refuses a plain-http upstream override for a non-loopback host', async () => {
    vi.stubEnv('TURTLE_EARN_API_URL', 'http://earn.turtle.xyz/v1')

    await expect(handler(makeEvent(PROOFS_URL))).rejects.toMatchObject({ statusCode: 503 })
    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled()
  })

  it.each([
    ['other path', `https://app.example/api/internal/proxy/turtle/streams?chainId=1`],
    ['extra query key', `${PROOFS_URL}&debug=true`],
    ['invalid wallet', 'https://app.example/api/internal/proxy/turtle/streams/merkle_proofs?wallet=nope&streamIds=stream-1'],
    ['path traversal', `https://app.example/api/internal/proxy/turtle/../v3/streams/merkle_proofs?wallet=${WALLET}&streamIds=stream-1`],
  ])('keeps blocking disallowed requests (%s) before any upstream call', async (_label, url) => {
    await expect(handler(makeEvent(url))).rejects.toMatchObject({ statusCode: 404 })
    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled()
  })

  it('rejects non-GET methods', async () => {
    const event = makeEvent(PROOFS_URL)
    event.method = 'POST'

    await expect(handler(event)).rejects.toMatchObject({ statusCode: 405 })
    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled()
  })

  it('maps an upstream 401 to a sanitized 502 without leaking the key', async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(
      upstreamResponse(401, `{"error":"invalid key ${API_KEY}"}`),
    )

    const failure = await handler(makeEvent(PROOFS_URL)).catch((err: unknown) => err)

    expect(failure).toMatchObject({ statusCode: 502, statusMessage: 'Turtle upstream unavailable' })
    expect(JSON.stringify(failure)).not.toContain(API_KEY)
    expect(JSON.stringify(failure)).not.toContain('invalid key')
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: 'turtle-proxy',
        upstreamHost: 'earn.turtle.xyz',
        err: expect.objectContaining({ status: 401 }),
      }),
      'upstream failed',
    )
    expect(everythingLogged()).not.toContain(API_KEY)
    expect(everythingLogged()).not.toContain(WALLET)
  })

  it('maps network failures to a sanitized 502', async () => {
    mocks.fetchWithTimeout.mockRejectedValueOnce(new TypeError(`fetch failed for ${API_KEY}`))

    await expect(handler(makeEvent(PROOFS_URL))).rejects.toMatchObject({ statusCode: 502 })
    expect(everythingLogged()).not.toContain(API_KEY)
  })
})
