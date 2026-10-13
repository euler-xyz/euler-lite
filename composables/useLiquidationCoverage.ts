import { shallowRef } from 'vue'
import { logWarn } from '~/utils/errorHandling'
import { createInFlightDedup } from '~/utils/in-flight'
import {
  hasBorrowSide,
  isCoveredByDefaultBot,
  type LiquidationCoverage,
} from '~/utils/liquidation-coverage'

const REFRESH_MS = 5 * 60_000
const RETRY_MS = 60_000
/** The server serves an answer for 30 minutes after the bot gave it; ask again before then. */
const ANSWER_VALID_MS = 30 * 60_000
const FETCH_TIMEOUT_MS = 15_000

const coverageByChain = shallowRef<Readonly<Record<number, LiquidationCoverage>>>({})
const nextLoadAt = new Map<number, number>()
const inFlight = createInFlightDedup<number, LiquidationCoverage | null>()

const nextLoadAfter = (coverage: LiquidationCoverage, now: number): number => {
  if (!coverage.enabled) return now + REFRESH_MS
  if (coverage.state === 'no-bot') return now + RETRY_MS
  return Math.max(now + RETRY_MS, Math.min(now + REFRESH_MS, coverage.fetchedAt + ANSWER_VALID_MS))
}

const load = (chainId: number): Promise<LiquidationCoverage | null> => inFlight.run(chainId, async () => {
  try {
    const coverage = await $fetch<LiquidationCoverage>('/api/internal/liquidation-coverage', {
      query: { chainId },
      timeout: FETCH_TIMEOUT_MS,
    })
    coverageByChain.value = { ...coverageByChain.value, [chainId]: coverage }
    nextLoadAt.set(chainId, nextLoadAfter(coverage, Date.now()))
    return coverage
  }
  catch (error) {
    nextLoadAt.set(chainId, Date.now() + RETRY_MS)
    logWarn('liquidation-coverage', error)
    return null
  }
})

const ensureLiquidationCoverage = (chainId: number): void => {
  if (Date.now() < (nextLoadAt.get(chainId) ?? 0)) return
  nextLoadAt.set(chainId, Number.POSITIVE_INFINITY)
  void load(chainId)
}

const refreshLiquidationCoverageIfStale = (): void => {
  for (const chainId of [...nextLoadAt.keys()]) ensureLiquidationCoverage(chainId)
}

/** Unknown coverage marks nothing: the badge only follows an answer the server has. */
const isNotCoveredByDefaultBot = (chainId: number, vault: { address: string } & object): boolean =>
  hasBorrowSide(vault) && isCoveredByDefaultBot(coverageByChain.value[chainId], vault.address) === false

export const useLiquidationCoverage = () => ({
  ensureLiquidationCoverage,
  refreshLiquidationCoverageIfStale,
  isNotCoveredByDefaultBot,
})
