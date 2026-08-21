import { afterEach, describe, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'

const mocks = vi.hoisted(() => ({
  consume: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('h3', () => ({
  createError: (error: unknown) => error,
  readBody: (event: { context?: { body?: unknown } }) => event.context?.body,
}))

vi.mock('~/server/utils/rate-limit', () => ({
  createRateLimiter: () => ({ consume: mocks.consume }),
}))

vi.mock('~/server/utils/logger', () => ({
  logger: {
    warn: mocks.warn,
    info: vi.fn(),
  },
}))

const handler = (await import('~/server/api/internal/screen-address.post')).default

const USER = '0x0000000000000000000000000000000000000001'
const OTHER = '0x0000000000000000000000000000000000000002'
const SCREENING_URI = 'https://v3.example/v3/compliance/address-screening'
const SCREENING_API_KEY = 'test-restricted-key'

function makeEvent(body: unknown, headers: Record<string, string | string[] | undefined> = {}): H3Event {
  return {
    context: { body },
    node: {
      req: {
        headers: {
          'cf-connecting-ip': '127.0.0.1',
          ...headers,
        },
      },
      res: {},
    },
  } as unknown as H3Event
}

function stubScreeningEnv(uri: string = SCREENING_URI): void {
  process.env.ADDRESS_SCREENING_URI = uri
  process.env.ADDRESS_SCREENING_API_KEY = SCREENING_API_KEY
}

function cleanVerdict(address: string = USER): Response {
  return new Response(JSON.stringify({ data: { address, addressIsSuspicious: false } }), { status: 200 })
}

describe('POST /api/internal/screen-address', () => {
  afterEach(() => {
    delete process.env.ADDRESS_SCREENING_URI
    delete process.env.ADDRESS_SCREENING_API_KEY
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('allows only an explicit false verdict echoing the requested address', async () => {
    stubScreeningEnv()
    vi.stubGlobal('fetch', vi.fn(async () => cleanVerdict()))

    await expect(handler(makeEvent({ address: USER }))).resolves.toEqual({ addressIsSuspicious: false })
  })

  it('binds the verdict to the requested address case-insensitively', async () => {
    stubScreeningEnv()
    vi.stubGlobal('fetch', vi.fn(async () => cleanVerdict(USER.toUpperCase().replace('0X', '0x'))))

    await expect(handler(makeEvent({ address: USER }))).resolves.toEqual({ addressIsSuspicious: false })
  })

  it('fails closed when the verdict echoes a different or missing address', async () => {
    stubScreeningEnv()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(cleanVerdict(OTHER))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { addressIsSuspicious: false } }), { status: 200 }))

    vi.stubGlobal('fetch', fetchMock)

    await expect(handler(makeEvent({ address: USER }))).resolves.toEqual({ addressIsSuspicious: true })
    await expect(handler(makeEvent({ address: USER }))).resolves.toEqual({ addressIsSuspicious: true })
  })

  it('fails closed for malformed successful upstream verdicts', async () => {
    stubScreeningEnv()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { address: USER, addressIsSuspicious: null } }), { status: 200 }))
      // Legacy flat shape (pre-data-v3 lambda) must no longer pass.
      .mockResolvedValueOnce(new Response(JSON.stringify({ addressIsSuspicious: false }), { status: 200 }))

    vi.stubGlobal('fetch', fetchMock)

    for (let i = 0; i < 4; i++) {
      await expect(handler(makeEvent({ address: USER }))).resolves.toEqual({ addressIsSuspicious: true })
    }
  })

  it('disables screening when neither env var is configured (forks pass every address)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(handler(makeEvent({ address: USER }))).resolves.toEqual({ addressIsSuspicious: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails closed when only one of URI / API key is configured', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    process.env.ADDRESS_SCREENING_URI = SCREENING_URI
    await expect(handler(makeEvent({ address: USER }))).resolves.toEqual({ addressIsSuspicious: true })

    delete process.env.ADDRESS_SCREENING_URI
    process.env.ADDRESS_SCREENING_API_KEY = SCREENING_API_KEY
    await expect(handler(makeEvent({ address: USER }))).resolves.toEqual({ addressIsSuspicious: true })

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses to send the API key to a non-TLS endpoint', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    for (const uri of ['http://v3.example/screen', 'ftp://v3.example/screen', 'not a url']) {
      stubScreeningEnv(uri)
      await expect(handler(makeEvent({ address: USER }))).resolves.toEqual({ addressIsSuspicious: true })
    }
    expect(fetchMock).not.toHaveBeenCalled()

    // Loopback http stays allowed for local development.
    stubScreeningEnv('http://localhost:8787/screen')
    vi.stubGlobal('fetch', vi.fn(async () => cleanVerdict()))
    await expect(handler(makeEvent({ address: USER }))).resolves.toEqual({ addressIsSuspicious: false })
  })

  it('fails closed on upstream errors, non-ok statuses, and timeouts', async () => {
    stubScreeningEnv()
    const abortError = new DOMException('aborted', 'AbortError')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockRejectedValueOnce(abortError)
      .mockRejectedValueOnce(new Error('network down'))

    vi.stubGlobal('fetch', fetchMock)

    for (let i = 0; i < 5; i++) {
      await expect(handler(makeEvent({ address: USER }))).resolves.toEqual({ addressIsSuspicious: true })
    }
  })

  it('sends the API key, blocks redirects, and omits chain from the upstream body', async () => {
    stubScreeningEnv()
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => cleanVerdict())
    vi.stubGlobal('fetch', fetchMock)

    await handler(makeEvent({ address: USER }))

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(SCREENING_URI)
    expect((init?.headers as Record<string, string>)['X-API-Key']).toBe(SCREENING_API_KEY)
    expect(init?.redirect).toBe('error')
    expect(JSON.parse(String(init?.body))).toEqual({ address: USER, vpnIsUsed: null })
  })

  it('rejects invalid addresses without calling upstream', async () => {
    stubScreeningEnv()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(handler(makeEvent({ address: 'not-an-address' }))).rejects.toMatchObject({ statusCode: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('hashes suspicious addresses in logs', async () => {
    stubScreeningEnv()
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ data: { address: USER, addressIsSuspicious: true } }), { status: 200 }),
    ))

    await expect(handler(makeEvent({ address: USER }))).resolves.toEqual({ addressIsSuspicious: true })

    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        addressHash: expect.any(String),
      }),
      'flagged, malformed, or ambiguous screening response — failing closed',
    )
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(USER)
  })

  it('derives vpnIsUsed from trusted request headers, never the body, and reports null when unmeasured', async () => {
    stubScreeningEnv()
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => cleanVerdict())
    vi.stubGlobal('fetch', fetchMock)

    await handler(makeEvent(
      { address: USER, vpnIsUsed: false },
      { 'x-is-vpn': 'true' },
    ))
    await handler(makeEvent(
      { address: USER, vpnIsUsed: false },
      { 'x-is-proxy-or-vpn': 'true' },
    ))
    await handler(makeEvent(
      { address: USER, vpnIsUsed: false },
      { 'x-is-vpn': 'false, TRUE' },
    ))
    await handler(makeEvent(
      { address: USER, vpnIsUsed: false },
      { 'x-is-proxy-or-vpn': ['false', ' true '] },
    ))
    await handler(makeEvent(
      { address: USER, vpnIsUsed: false },
      { 'x-is-vpn': 'false' },
    ))
    // No edge headers at all: unknown, not false.
    await handler(makeEvent(
      { address: USER, vpnIsUsed: true },
      {},
    ))

    const bodies = fetchMock.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)) as { vpnIsUsed: boolean | null },
    )
    expect(bodies.map(body => body.vpnIsUsed)).toEqual([true, true, true, true, false, null])
  })
})
