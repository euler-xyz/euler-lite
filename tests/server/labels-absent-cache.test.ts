import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchWithTimeout } from '~/server/utils/fetchWithTimeout'
import { getFreshAbsentLabelFile, refreshLabelFile } from '~/server/api/internal/labels/[file].get'
import pathHandler from '~/server/api/internal/labels/[chainId]/[file].get'

vi.mock('~/server/utils/fetchWithTimeout', () => ({ fetchWithTimeout: vi.fn() }))

vi.mock('~/server/utils/rate-limit', () => ({
  createRateLimiter: () => ({ consume: vi.fn() }),
}))

vi.mock('h3', () => ({
  createError: (error: unknown) => error,
  getQuery: () => ({}),
  getRouterParam: (event: { params: Record<string, string> }, name: string) => event.params[name],
  setResponseHeader: vi.fn(),
}))

const requestPath = (chainId: string, file: string) =>
  (pathHandler as unknown as (event: unknown) => Promise<unknown>)({ params: { chainId, file } })

describe('path-shape labels route with absent upstream files', () => {
  beforeEach(() => {
    vi.mocked(fetchWithTimeout).mockReset()
  })

  it('serves a confirmed-absent file from cache without another upstream miss', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValueOnce(new Response('', { status: 403 }))

    expect(await requestPath('9101', 'assets.json')).toEqual([])
    expect(getFreshAbsentLabelFile(9101, 'assets.json')).toEqual([])
    expect(await requestPath('9101', 'assets.json')).toEqual([])
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1)
  })

  it('keeps force-refreshing files that exist upstream', async () => {
    const data = [{ address: '0x00000000000000000000000000000000000000A1' }]
    vi.mocked(fetchWithTimeout).mockImplementation(async () => Response.json(data))

    expect(await requestPath('9102', 'assets.json')).toEqual(data)
    expect(await requestPath('9102', 'assets.json')).toEqual(data)
    expect(getFreshAbsentLabelFile(9102, 'assets.json')).toBeUndefined()
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2)
  })

  it('picks up a newly published file on the next warm refresh', async () => {
    const data = ['0x00000000000000000000000000000000000000B2']
    vi.mocked(fetchWithTimeout).mockResolvedValueOnce(new Response('', { status: 404 }))
    expect(await refreshLabelFile(9103, 'earn-vaults.json')).toEqual([])
    expect(getFreshAbsentLabelFile(9103, 'earn-vaults.json')).toEqual([])

    vi.mocked(fetchWithTimeout).mockResolvedValueOnce(Response.json(data))
    expect(await refreshLabelFile(9103, 'earn-vaults.json')).toEqual(data)
    expect(getFreshAbsentLabelFile(9103, 'earn-vaults.json')).toBeUndefined()

    vi.mocked(fetchWithTimeout).mockResolvedValueOnce(Response.json(data))
    expect(await requestPath('9103', 'earn-vaults.json')).toEqual(data)
    expect(fetchWithTimeout).toHaveBeenCalledTimes(3)
  })

  it('keeps serving a previously published payload when upstream starts returning 403', async () => {
    const data = { product: { name: 'Product' } }
    vi.mocked(fetchWithTimeout).mockResolvedValueOnce(Response.json(data))
    expect(await refreshLabelFile(9104, 'products.json')).toEqual(data)

    vi.mocked(fetchWithTimeout).mockResolvedValueOnce(new Response('', { status: 403 }))
    expect(await requestPath('9104', 'products.json')).toEqual(data)
    expect(getFreshAbsentLabelFile(9104, 'products.json')).toBeUndefined()
  })

  it('re-stamps a confirmed-absent entry on each warm probe', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchWithTimeout).mockImplementation(async () => new Response('', { status: 403 }))
      await refreshLabelFile(9105, 'points.json')

      vi.advanceTimersByTime(4 * 60_000)
      await refreshLabelFile(9105, 'points.json')
      vi.advanceTimersByTime(4 * 60_000)

      expect(getFreshAbsentLabelFile(9105, 'points.json')).toEqual([])
    }
    finally {
      vi.useRealTimers()
    }
  })
})
