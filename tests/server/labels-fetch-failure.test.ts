import { describe, expect, it, vi } from 'vitest'
import { fetchWithTimeout } from '~/server/utils/fetchWithTimeout'
import { refreshLabelFile } from '~/server/api/internal/labels/[file].get'

vi.mock('~/server/utils/fetchWithTimeout', () => ({ fetchWithTimeout: vi.fn() }))

describe('label proxy failure handling', () => {
  it('returns an error for a transient failure without a usable cache', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValueOnce(new Response('', { status: 503 }))
    await expect(refreshLabelFile(9001, 'earn-vaults.json')).rejects.toMatchObject({ statusCode: 503 })
  })

  it('serves cached labels during an upstream outage', async () => {
    const data = ['0x00000000000000000000000000000000000000A1']
    vi.mocked(fetchWithTimeout).mockResolvedValueOnce(Response.json(data))
    expect(await refreshLabelFile(9002, 'earn-vaults.json')).toEqual(data)
    vi.mocked(fetchWithTimeout).mockRejectedValueOnce(new Error('network error'))
    expect(await refreshLabelFile(9002, 'earn-vaults.json')).toEqual(data)
  })

  it('keeps genuinely absent files valid and empty', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValueOnce(new Response('', { status: 404 }))
    expect(await refreshLabelFile(9003, 'earn-vaults.json')).toEqual([])
  })
})
