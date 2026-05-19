import { afterEach, describe, expect, it, vi } from 'vitest'
import { WALLET_SCREENING_TIMEOUT_MS } from '~/entities/tuning-constants'
import { detectVpn, resetVpnCache } from '~/services/vpn'

describe('detectVpn', () => {
  afterEach(() => {
    resetVpnCache()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('reads the VPN edge header', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:3000' } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
      headers: { 'x-is-vpn': 'true' },
      status: 200,
    })))

    await expect(detectVpn()).resolves.toBe(true)
  })

  it('returns false when VPN detection stalls', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { location: { origin: 'http://localhost:3000' } })
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }),
    ))

    const promise = detectVpn()

    await vi.advanceTimersByTimeAsync(WALLET_SCREENING_TIMEOUT_MS)

    await expect(promise).resolves.toBe(false)
  })
})
