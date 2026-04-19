/**
 * Tests for server/utils/rewards-cache.ts.
 *
 * These exercise the behaviours that the proxy handlers and the
 * warm-cache plugin rely on: cache isolation between providers / types,
 * in-flight dedup, partial-pagination non-caching, and the page cap.
 *
 * The rewards-cache module holds module-scoped state (cache + inflight
 * maps) so each test uses distinct chainIds / types to avoid cross-test
 * interference instead of reloading the module.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readBrevis,
  readFuul,
  readMerklTokens,
  readMerklType,
  refreshBrevisCampaigns,
  refreshFuulProtocol,
  refreshMerklTokens,
  refreshMerklType,
} from '~/server/utils/rewards-cache'

type FetchMock = ReturnType<typeof vi.fn>

const jsonResponse = (body: unknown, status = 200): Response => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
} as unknown as Response)

const installFetch = (impl: (url: string, init?: RequestInit) => Promise<Response>): FetchMock => {
  const mock = vi.fn(impl)
  globalThis.fetch = mock as unknown as typeof globalThis.fetch
  return mock as FetchMock
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('refreshMerklType', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('paginates until upstream returns a short page and caches the concat', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: `p1-${i}` }))
    const shortPage = [{ id: 'p2-0' }]

    const fetchMock = installFetch(async (url) => {
      if (String(url).includes('page=0')) return jsonResponse(fullPage)
      if (String(url).includes('page=1')) return jsonResponse(shortPage)
      return jsonResponse([])
    })

    const data = await refreshMerklType(1, 'EULER')
    expect(data).toHaveLength(101)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const cached = readMerklType(1, 'EULER')
    expect(cached?.isStale).toBe(false)
    expect(cached?.data).toHaveLength(101)
  })

  it('dedupes concurrent refreshers onto a single upstream fetch', async () => {
    const fetchMock = installFetch(async () => {
      await new Promise(r => setTimeout(r, 20))
      return jsonResponse([{ id: 'only-one' }])
    })

    const results = await Promise.all(Array.from({ length: 10 }, () => refreshMerklType(2, 'MULTILENDBORROW')))
    // 10 concurrent callers → 1 upstream fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(results.every(r => r.length === 1)).toBe(true)
  })

  it('does not cache when pagination fails mid-flight', async () => {
    installFetch(async (url) => {
      if (String(url).includes('page=0')) return jsonResponse(Array.from({ length: 100 }, () => ({})))
      return jsonResponse(null, 500)
    })

    await expect(refreshMerklType(3, 'ERC20LOGPROCESSOR')).rejects.toThrow()
    // No entry stored, not even stale.
    expect(readMerklType(3, 'ERC20LOGPROCESSOR')).toBeUndefined()
  })

  it('refuses to cache when the page cap is exhausted without a short page', async () => {
    // All pages are full — upstream never signals end-of-data within the cap.
    installFetch(async () => jsonResponse(Array.from({ length: 100 }, () => ({ full: true }))))

    await expect(refreshMerklType(4, 'EULER')).rejects.toThrow(/cap/)
    expect(readMerklType(4, 'EULER')).toBeUndefined()
  })

  it('isolates caches per chain and per type', async () => {
    installFetch(async (url) => {
      if (String(url).includes('chainId=5')) return jsonResponse([{ id: 'chain5' }])
      if (String(url).includes('chainId=6')) return jsonResponse([{ id: 'chain6' }])
      return jsonResponse([])
    })

    await refreshMerklType(5, 'EULER')
    await refreshMerklType(6, 'EULER')

    expect(readMerklType(5, 'EULER')?.data).toEqual([{ id: 'chain5' }])
    expect(readMerklType(6, 'EULER')?.data).toEqual([{ id: 'chain6' }])
    // Distinct type key — not polluted by the EULER cache.
    expect(readMerklType(5, 'MULTILENDBORROW')).toBeUndefined()
  })
})

describe('refreshMerklTokens', () => {
  it('caches the global tokens payload and dedupes concurrent callers', async () => {
    const fetchMock = installFetch(async () => {
      await new Promise(r => setTimeout(r, 15))
      return jsonResponse({ 1: [{ symbol: 'TKN' }] })
    })

    const [a, b] = await Promise.all([refreshMerklTokens(), refreshMerklTokens()])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(a).toEqual({ 1: [{ symbol: 'TKN' }] })
    expect(b).toEqual(a)
    expect(readMerklTokens()?.isStale).toBe(false)
  })

  it('surfaces upstream errors (no cache write)', async () => {
    installFetch(async () => jsonResponse(null, 503))
    await expect(refreshMerklTokens()).rejects.toThrow(/503/)
  })
})

describe('refreshBrevisCampaigns', () => {
  it('sends the hardcoded POST body and caches the raw response', async () => {
    const fetchMock = installFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      expect(body).toEqual({ chain_id: [10], action: [2001, 2002], status: [3] })
      expect(init?.method).toBe('POST')
      return jsonResponse({ campaigns: [{ id: 'a' }] })
    })

    const res = await refreshBrevisCampaigns(10) as { campaigns: Array<{ id: string }> }
    expect(res.campaigns).toEqual([{ id: 'a' }])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(readBrevis(10)?.data).toEqual(res)
  })

  it('isolates by chainId', async () => {
    installFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      return jsonResponse({ campaigns: [{ chain: body.chain_id[0] }] })
    })

    await refreshBrevisCampaigns(11)
    await refreshBrevisCampaigns(12)

    const eleven = readBrevis(11)?.data as { campaigns: Array<{ chain: number }> }
    const twelve = readBrevis(12)?.data as { campaigns: Array<{ chain: number }> }
    expect(eleven.campaigns[0].chain).toBe(11)
    expect(twelve.campaigns[0].chain).toBe(12)
  })
})

describe('refreshFuulProtocol', () => {
  it('isolates caches per protocol', async () => {
    installFetch(async (url) => {
      if (String(url).includes('protocol=euler-looping')) return jsonResponse([{ proto: 'looping' }])
      if (String(url).includes('protocol=euler')) return jsonResponse([{ proto: 'euler' }])
      return jsonResponse([])
    })

    await refreshFuulProtocol(20, 'euler')
    await refreshFuulProtocol(20, 'euler-looping')

    expect(readFuul(20, 'euler')?.data).toEqual([{ proto: 'euler' }])
    expect(readFuul(20, 'euler-looping')?.data).toEqual([{ proto: 'looping' }])
  })

  it('dedupes concurrent refreshers per protocol key', async () => {
    const fetchMock = installFetch(async () => {
      await new Promise(r => setTimeout(r, 15))
      return jsonResponse([])
    })

    await Promise.all([
      refreshFuulProtocol(21, 'euler'),
      refreshFuulProtocol(21, 'euler'),
      refreshFuulProtocol(21, 'euler'),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
