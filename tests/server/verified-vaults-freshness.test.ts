import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAddress } from 'viem'
import { buildLabelsView } from '~/server/utils/labels-view'

vi.mock('~/server/utils/labels-view', () => ({ buildLabelsView: vi.fn() }))

const VAULT = getAddress('0x00000000000000000000000000000000000000a1')

afterEach(() => {
  vi.useRealTimers()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('public verified set freshness', () => {
  it('does not renew a stale V3 verdict by rebuilding the derived cache', async () => {
    vi.useFakeTimers()
    const fetchedAt = new Date('2026-09-30T12:00:00Z').getTime()
    vi.setSystemTime(fetchedAt)
    vi.mocked(buildLabelsView).mockResolvedValue({
      labelsSource: 'v3',
      sourceFetchedAt: fetchedAt,
      escrowAddresses: new Set(),
      publishedVerifiedAddresses: new Set([VAULT]),
    } as never)
    const { refreshVerifiedAddressSet, getVerifiedAddressSet, getVerifiedAddressSnapshot, getVerifiedAddressCacheControl } = await import('~/server/utils/verified-vaults')

    expect((await refreshVerifiedAddressSet(1)).has(VAULT)).toBe(true)
    vi.setSystemTime(fetchedAt + 14 * 60_000)
    expect((await refreshVerifiedAddressSet(1)).has(VAULT)).toBe(true)
    expect(getVerifiedAddressCacheControl(await getVerifiedAddressSnapshot(1), fetchedAt + 14 * 60_000)).toBe('public, max-age=30, stale-while-revalidate=29')
    expect(getVerifiedAddressCacheControl(await getVerifiedAddressSnapshot(1), fetchedAt + 14 * 60_000 + 40_000)).toBe('public, max-age=19, stale-while-revalidate=0')
    vi.setSystemTime(fetchedAt + 15 * 60_000)
    await expect(getVerifiedAddressSet(1)).rejects.toThrow('Vault verification snapshot is too old')

    vi.mocked(buildLabelsView).mockResolvedValue({
      labelsSource: 'v3',
      sourceFetchedAt: Date.now(),
      escrowAddresses: new Set(),
      publishedVerifiedAddresses: new Set([VAULT]),
    } as never)
    expect((await getVerifiedAddressSet(1)).has(VAULT)).toBe(true)
  })
})
