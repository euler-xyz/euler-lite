import { afterEach, describe, expect, it, vi } from 'vitest'
import { WALLET_SCREENING_TIMEOUT_MS } from '~/entities/tuning-constants'
import { detectVpn, resetVpnCache } from '~/services/vpn'

// The probe only runs when the deployment's edge provider measures VPN
// usage, which server/plugins/app-config.ts advertises via __APP_CONFIG__.
const stubWindow = (vpnDetection: boolean | undefined) => {
  vi.stubGlobal('window', {
    location: { origin: 'http://localhost:3000' },
    __APP_CONFIG__: vpnDetection === undefined ? undefined : { vpnDetection },
  })
}

describe('detectVpn', () => {
  afterEach(() => {
    resetVpnCache()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('reads the VPN edge header', async () => {
    stubWindow(true)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
      headers: { 'x-is-vpn': 'true' },
      status: 200,
    })))

    await expect(detectVpn()).resolves.toBe(true)
  })

  it('fails closed when VPN detection stalls', async () => {
    vi.useFakeTimers()
    stubWindow(true)
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }),
    ))

    const promise = detectVpn()

    await vi.advanceTimersByTimeAsync(WALLET_SCREENING_TIMEOUT_MS)

    await expect(promise).resolves.toBe(true)
  })

  it('skips the probe entirely when the edge provides no VPN evidence', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    for (const vpnDetection of [false, undefined] as const) {
      stubWindow(vpnDetection)
      await expect(detectVpn()).resolves.toBe(false)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
