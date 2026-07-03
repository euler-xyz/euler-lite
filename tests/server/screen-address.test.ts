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
  },
}))

const handler = (await import('~/server/api/screen-address.post')).default

const USER = '0x0000000000000000000000000000000000000001'
const SCREENING_URI = 'https://trm.example/screen'

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

describe('POST /api/screen-address', () => {
  afterEach(() => {
    delete process.env.WALLET_SCREENING_URI
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('allows only an explicit false upstream verdict', async () => {
    process.env.WALLET_SCREENING_URI = SCREENING_URI
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ addressIsSuspicious: false }), { status: 200 }),
    ))

    await expect(handler(makeEvent({ address: USER }))).resolves.toEqual({ addressIsSuspicious: false })
  })

  it('fails closed for malformed successful upstream verdicts', async () => {
    process.env.WALLET_SCREENING_URI = SCREENING_URI
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ addressIsSuspicious: null }), { status: 200 }))

    vi.stubGlobal('fetch', fetchMock)

    await expect(handler(makeEvent({ address: USER }))).resolves.toEqual({ addressIsSuspicious: true })
    await expect(handler(makeEvent({ address: USER }))).resolves.toEqual({ addressIsSuspicious: true })
  })

  it('hashes suspicious addresses in logs', async () => {
    process.env.WALLET_SCREENING_URI = SCREENING_URI
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ addressIsSuspicious: true }), { status: 200 }),
    ))

    await expect(handler(makeEvent({ address: USER }))).resolves.toEqual({ addressIsSuspicious: true })

    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: 'screen-address',
        addressHash: expect.any(String),
      }),
      'flagged, malformed, or ambiguous TRM response — failing closed',
    )
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(USER)
  })

  it('derives vpnIsUsed from trusted request headers', async () => {
    process.env.WALLET_SCREENING_URI = SCREENING_URI
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ addressIsSuspicious: false }), { status: 200 }),
    )
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
      { address: USER, vpnIsUsed: true },
      {},
    ))

    const bodies = fetchMock.mock.calls.map((call) => {
      const init = call[1]
      return JSON.parse(String(init?.body)) as { vpnIsUsed: string }
    })
    expect(bodies.map(body => body.vpnIsUsed)).toEqual(['true', 'true', 'true', 'true', 'false'])
  })
})
