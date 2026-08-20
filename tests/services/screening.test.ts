import { afterEach, describe, expect, it, vi } from 'vitest'
import { WALLET_SCREENING_TIMEOUT_MS } from '~/entities/tuning-constants'
import { screenAddress } from '~/services/screening'

const USER = '0x0000000000000000000000000000000000000001'

describe('screenAddress', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('allows only an explicit false suspicious verdict', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ addressIsSuspicious: false }), { status: 200 })))

    await expect(screenAddress(USER, false)).resolves.toBe(false)
  })

  it('fails closed for non-ok responses and malformed success bodies', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('nope', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))

    vi.stubGlobal('fetch', fetchMock)

    await expect(screenAddress(USER, false)).resolves.toBe(true)
    await expect(screenAddress(USER, false)).resolves.toBe(true)
  })

  it('fails closed when the screening request stalls', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }),
    ))

    const promise = screenAddress(USER, false)

    await vi.advanceTimersByTimeAsync(WALLET_SCREENING_TIMEOUT_MS)

    await expect(promise).resolves.toBe(true)
  })
})
