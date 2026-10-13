import { VaultType } from '@eulerxyz/euler-v2-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiquidationCoverage } from '~/utils/liquidation-coverage'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  logWarn: vi.fn(),
}))

vi.mock('~/utils/errorHandling', () => ({ logWarn: mocks.logWarn }))

const LISTED = '0x692b9F0C2701699b7a352C9331DFAE6A6a163294'
const OTHER = '0x0120c2748545a4D9C875CDdFB439f786d6f1B460'
const MINUTE = 60_000

const borrowable = (address: string) => ({ type: VaultType.EVault, address, isBorrowable: true, totalBorrowed: 0n })
const collateralOnly = (address: string) => ({ type: VaultType.EVault, address, isBorrowable: false, totalBorrowed: 0n })

const blacklist = (chainId: number, fetchedAt = Date.now()): LiquidationCoverage => ({
  enabled: true,
  chainId,
  state: 'answered',
  mode: 'blacklist',
  vaults: [LISTED.toLowerCase()],
  fetchedAt,
})

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

const load = async () => {
  const { useLiquidationCoverage } = await import('~/composables/useLiquidationCoverage')
  return useLiquidationCoverage()
}

describe('useLiquidationCoverage', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-13T12:00:00Z'))
    mocks.fetch.mockReset().mockImplementation(async (_url: string, options: { query: { chainId: number } }) =>
      blacklist(options.query.chainId))
    mocks.logWarn.mockReset()
    vi.stubGlobal('$fetch', mocks.fetch)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('knows nothing, and marks nothing, before the chain has loaded', async () => {
    const coverage = await load()

    expect(coverage.isNotCoveredByDefaultBot(8453, borrowable(LISTED))).toBe(false)
  })

  it('marks a borrowable vault the chain\'s bot leaves out', async () => {
    const coverage = await load()
    coverage.ensureLiquidationCoverage(8453)
    await flush()

    expect(mocks.fetch).toHaveBeenCalledWith('/api/internal/liquidation-coverage', expect.objectContaining({
      query: { chainId: 8453 },
    }))
    expect(coverage.isNotCoveredByDefaultBot(8453, borrowable(LISTED))).toBe(true)
    expect(coverage.isNotCoveredByDefaultBot(8453, borrowable(OTHER))).toBe(false)
    expect(coverage.isNotCoveredByDefaultBot(1, borrowable(LISTED))).toBe(false)
  })

  it('never marks a vault nobody can borrow from', async () => {
    const coverage = await load()
    coverage.ensureLiquidationCoverage(8453)
    await flush()

    expect(coverage.isNotCoveredByDefaultBot(8453, collateralOnly(LISTED))).toBe(false)
  })

  it('marks every borrowable vault on a chain whose bot does not answer', async () => {
    mocks.fetch.mockResolvedValue({ enabled: true, chainId: 239, state: 'no-bot' })
    const coverage = await load()
    coverage.ensureLiquidationCoverage(239)
    await flush()

    expect(coverage.isNotCoveredByDefaultBot(239, borrowable(OTHER))).toBe(true)
    expect(coverage.isNotCoveredByDefaultBot(239, collateralOnly(OTHER))).toBe(false)
  })

  it('marks nothing when the deployment has the feature off', async () => {
    mocks.fetch.mockResolvedValue({ enabled: false })
    const coverage = await load()
    coverage.ensureLiquidationCoverage(8453)
    await flush()

    expect(coverage.isNotCoveredByDefaultBot(8453, borrowable(LISTED))).toBe(false)
  })

  it('loads a chain once for many rows and again only after five minutes', async () => {
    const coverage = await load()
    coverage.ensureLiquidationCoverage(8453)
    coverage.ensureLiquidationCoverage(8453)
    await flush()
    coverage.ensureLiquidationCoverage(8453)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)

    vi.setSystemTime(Date.now() + 5 * MINUTE)
    coverage.refreshLiquidationCoverageIfStale()
    await flush()
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
  })

  it('retries a chain whose first load failed from the poll, a minute later', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('offline'))
    const coverage = await load()
    coverage.ensureLiquidationCoverage(8453)
    await flush()

    vi.setSystemTime(Date.now() + MINUTE)
    coverage.refreshLiquidationCoverageIfStale()
    await flush()

    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    expect(coverage.isNotCoveredByDefaultBot(8453, borrowable(LISTED))).toBe(true)
  })

  it('asks again a minute after hearing that a chain has no bot', async () => {
    mocks.fetch.mockResolvedValue({ enabled: true, chainId: 239, state: 'no-bot' })
    const coverage = await load()
    coverage.ensureLiquidationCoverage(239)
    await flush()

    vi.setSystemTime(Date.now() + MINUTE)
    coverage.refreshLiquidationCoverageIfStale()

    expect(mocks.fetch).toHaveBeenCalledTimes(2)
  })

  it('asks again before an answer outlives the 30 minutes it is valid for', async () => {
    mocks.fetch.mockImplementation(async () => blacklist(8453, Date.now() - 28 * MINUTE))
    const coverage = await load()
    coverage.ensureLiquidationCoverage(8453)
    await flush()

    vi.setSystemTime(Date.now() + 2 * MINUTE)
    coverage.refreshLiquidationCoverageIfStale()

    expect(mocks.fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps the last answer through a failed refresh and retries a minute later', async () => {
    const coverage = await load()
    coverage.ensureLiquidationCoverage(8453)
    await flush()
    mocks.fetch.mockRejectedValue(new Error('offline'))

    vi.setSystemTime(Date.now() + 5 * MINUTE)
    coverage.ensureLiquidationCoverage(8453)
    await flush()
    expect(coverage.isNotCoveredByDefaultBot(8453, borrowable(LISTED))).toBe(true)
    expect(mocks.logWarn).toHaveBeenCalledTimes(1)

    coverage.ensureLiquidationCoverage(8453)
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    vi.setSystemTime(Date.now() + MINUTE)
    coverage.ensureLiquidationCoverage(8453)
    expect(mocks.fetch).toHaveBeenCalledTimes(3)
  })
})
