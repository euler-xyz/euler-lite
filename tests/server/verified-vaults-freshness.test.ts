import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAddress } from 'viem'
import { buildLabelsView } from '~/server/utils/labels-view'

vi.mock('~/server/utils/labels-view', () => ({ buildLabelsView: vi.fn() }))

const VAULT = getAddress('0x00000000000000000000000000000000000000a1')
const DAY_MS = 24 * 60 * 60_000

const viewAt = (sourceFetchedAt: number) => ({
  labelsSource: 'v3',
  sourceFetchedAt,
  escrowAddresses: new Set(),
  publishedVerifiedAddresses: new Set([VAULT]),
}) as never

afterEach(() => {
  vi.useRealTimers()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('public verified set freshness', () => {
  it('serves a V3 verdict for a day after its read and refuses it afterwards', async () => {
    vi.useFakeTimers()
    const fetchedAt = new Date('2026-09-30T12:00:00Z').getTime()
    vi.setSystemTime(fetchedAt)
    vi.mocked(buildLabelsView).mockResolvedValue(viewAt(fetchedAt))
    const { refreshVerifiedAddressSet, getVerifiedAddressSet, getVerifiedAddressSnapshot, getVerifiedAddressCacheControl, VerificationUnavailableError } = await import('~/server/utils/verified-vaults')

    expect((await refreshVerifiedAddressSet(1)).has(VAULT)).toBe(true)
    vi.setSystemTime(fetchedAt + DAY_MS - 60_000)
    expect((await refreshVerifiedAddressSet(1)).has(VAULT)).toBe(true)
    expect(getVerifiedAddressCacheControl(await getVerifiedAddressSnapshot(1), fetchedAt + 23 * 60 * 60_000)).toBe('public, max-age=30, stale-while-revalidate=30')
    expect(getVerifiedAddressCacheControl(await getVerifiedAddressSnapshot(1), fetchedAt + DAY_MS - 40_000)).toBe('public, max-age=30, stale-while-revalidate=9')
    expect(getVerifiedAddressCacheControl(await getVerifiedAddressSnapshot(1), fetchedAt + DAY_MS - 20_000)).toBe('public, max-age=19, stale-while-revalidate=0')
    vi.setSystemTime(fetchedAt + DAY_MS)
    await expect(getVerifiedAddressSet(1)).rejects.toBeInstanceOf(VerificationUnavailableError)

    vi.mocked(buildLabelsView).mockResolvedValue(viewAt(Date.now()))
    expect((await getVerifiedAddressSet(1)).has(VAULT)).toBe(true)
  })

  it('keeps serving the last good set while rebuilds fail, within the day', async () => {
    vi.useFakeTimers()
    const fetchedAt = new Date('2026-09-30T12:00:00Z').getTime()
    vi.setSystemTime(fetchedAt)
    vi.mocked(buildLabelsView).mockResolvedValue(viewAt(fetchedAt))
    const { refreshVerifiedAddressSet, getVerifiedAddressSet, VerificationUnavailableError } = await import('~/server/utils/verified-vaults')
    expect((await refreshVerifiedAddressSet(1)).has(VAULT)).toBe(true)

    vi.mocked(buildLabelsView).mockRejectedValue(new Error('upstream down'))
    vi.setSystemTime(fetchedAt + 6 * 60 * 60_000)
    expect((await getVerifiedAddressSet(1)).has(VAULT)).toBe(true)
    vi.setSystemTime(fetchedAt + DAY_MS + 1)
    await expect(getVerifiedAddressSet(1)).rejects.toBeInstanceOf(VerificationUnavailableError)
  })

  it('reports an upstream error, not unavailability, when nothing was ever read', async () => {
    vi.mocked(buildLabelsView).mockRejectedValue(new Error('upstream down'))
    const { getVerifiedAddressSet, VerificationUnavailableError } = await import('~/server/utils/verified-vaults')
    const failure = await getVerifiedAddressSet(1).catch(err => err)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(VerificationUnavailableError)
  })
})
