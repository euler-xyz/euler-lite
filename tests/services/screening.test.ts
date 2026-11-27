import { afterEach, describe, expect, it, vi } from 'vitest'
import { WALLET_SCREENING_TIMEOUT_MS } from '~/entities/tuning-constants'
import { screenAddress } from '~/services/screening'

const USER = '0x0000000000000000000000000000000000000001'

const respond = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }))

describe('screenAddress', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it.each([true, false, null])('forwards VPN audit evidence (%s) and allows an explicit clean verdict', async (vpnIsUsed) => {
    const fetchMock = respond({ addressIsSuspicious: false, exitOnly: false })
    vi.stubGlobal('fetch', fetchMock)

    await expect(screenAddress(USER, vpnIsUsed)).resolves.toBe('clear')
    expect(fetchMock).toHaveBeenCalledWith('/api/internal/screen-address', expect.objectContaining({
      body: JSON.stringify({ address: USER, vpnIsUsed }),
    }))
  })

  it('reads a body without the field exactly as before', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ addressIsSuspicious: false }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ addressIsSuspicious: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(screenAddress(USER, false)).resolves.toBe('clear')
    await expect(screenAddress(USER, false)).resolves.toBe('blocked')
  })

  it('returns exit-only only for addressIsSuspicious true with a strict exitOnly true', async () => {
    vi.stubGlobal('fetch', respond({ addressIsSuspicious: true, exitOnly: true }))

    await expect(screenAddress(USER, false)).resolves.toBe('exit-only')
  })

  it.each([
    ['a flagged answer with exitOnly false', { addressIsSuspicious: true, exitOnly: false }],
    ['a stringly exitOnly', { addressIsSuspicious: true, exitOnly: 'true' }],
    ['a truthy addressIsSuspicious', { addressIsSuspicious: 'true', exitOnly: true }],
    ['a contradictory clean answer', { addressIsSuspicious: false, exitOnly: true }],
    ['exitOnly alone', { exitOnly: true }],
    ['an empty object', {}],
    ['null', null],
    ['a bare string', 'clear'],
  ])('fails to blocked for %s', async (_case, body) => {
    vi.stubGlobal('fetch', respond(body))

    await expect(screenAddress(USER, false)).resolves.toBe('blocked')
  })

  it('fails to blocked for non-ok responses, even with an exit-only body', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('nope', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ addressIsSuspicious: true, exitOnly: true }), { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(screenAddress(USER, false)).resolves.toBe('blocked')
    await expect(screenAddress(USER, false)).resolves.toBe('blocked')
  })

  it('fails to blocked on network errors and unparseable bodies', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(new Response('not json', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(screenAddress(USER, false)).resolves.toBe('blocked')
    await expect(screenAddress(USER, false)).resolves.toBe('blocked')
  })

  it('fails to blocked when the screening request stalls', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }),
    ))

    const promise = screenAddress(USER, false)

    await vi.advanceTimersByTimeAsync(WALLET_SCREENING_TIMEOUT_MS)

    await expect(promise).resolves.toBe('blocked')
  })
})
