import { QueryClient } from '@tanstack/vue-query'
import { serializeQueryArgs, type BuildQueryFn, type EulerSDKQueryName } from '@eulerxyz/euler-v2-sdk'

const SECOND = 1_000
const MINUTE = 60 * SECOND

/**
 * Stale-time policy split by data class:
 *
 * - **Static catalogue / metadata** (deployments, ABIs, labels, oracle adapter
 *   lists, verified-vault arrays): 5 min — these almost never change.
 *
 * - **Plan-critical state** (vault info, account info, vault account info,
 *   vault factory/type lookups): **5 min** — these only change when the user
 *   or someone else transacts. Refreshed at page-mount via the fresh SDK
 *   (which seeds the shared cache) and again post-tx via
 *   `invalidateSdkQueries(PLAN_CRITICAL_QUERIES)`. Bumping these is the main
 *   lever that lets the Pyth plugin's `populateCollaterals` and simulate's
 *   `fetchVaultTypes` hit cache on Review clicks.
 *
 * - **Pricing / APY** (assetPriceInfo, rewards, intrinsicApy): 1 min — fresh
 *   enough for display, cheap to fetch.
 *
 * - **Time-sensitive** (Pyth update data + fee, simulate batch results,
 *   balances, allowances): short. Pyth update payloads have a real on-chain
 *   validity window (~60s); caching longer would make tx revert at execute.
 *   Balances/allowances stay short so an external wallet change is picked up
 *   within ~5s without forcing a manual invalidation.
 */
const STALE_TIMES: Partial<Record<EulerSDKQueryName, number>> = {
  queryDeployments: 5 * MINUTE,
  queryABI: Infinity,
  queryTokenList: Infinity,
  queryEulerLabelsEntities: 5 * MINUTE,
  queryEulerLabelsProducts: 5 * MINUTE,
  queryEulerLabelsPoints: 5 * MINUTE,
  queryEulerLabelsEarnVaults: 5 * MINUTE,
  queryEulerLabelsAssets: 5 * MINUTE,
  queryOracleAdapters: 5 * MINUTE,

  queryEVaultVerifiedArray: 5 * MINUTE,
  queryEulerEarnVerifiedArray: 5 * MINUTE,
  queryV3VaultResolve: 5 * MINUTE,
  queryVaultFactories: 5 * MINUTE,

  // Plan-critical: cached for the form session, refreshed at mount (fresh SDK
  // writes through) and post-tx (invalidateSdkQueries).
  queryEVaultInfoFull: 5 * MINUTE,
  queryEulerEarnVaultInfoFull: 5 * MINUTE,
  queryV3EVaultDetail: 5 * MINUTE,
  queryV3EulerEarnDetail: 5 * MINUTE,
  queryEVCAccountInfo: 5 * MINUTE,
  queryVaultAccountInfo: 5 * MINUTE,

  queryAssetPriceInfo: MINUTE,
  queryV3RewardsBreakdown: MINUTE,
  queryV3IntrinsicApy: MINUTE,

  queryBatchSimulation: 10 * SECOND,
  queryPythUpdateData: 10 * SECOND,
  queryPythUpdateFee: 10 * SECOND,

  queryNativeBalance: 5 * SECOND,
  queryTokenBalances: 5 * SECOND,
  queryBalanceOf: 5 * SECOND,
  queryAllowance: 5 * SECOND,
  queryPermit2Allowance: 5 * SECOND,
}

/**
 * Plan-critical query names that should be invalidated:
 *   - at form mount, to start each session against fresh chain state, and
 *   - after every sent tx, so the next Review-click reflects the new state.
 *
 * Time-sensitive queries (balances, allowances, Pyth update data) are left
 * out — their short stale time handles re-reading without explicit invalidation.
 */
export const PLAN_CRITICAL_QUERIES = [
  'queryEVCAccountInfo',
  'queryVaultAccountInfo',
  'queryEVaultInfoFull',
  'queryEulerEarnVaultInfoFull',
  'queryV3EVaultDetail',
  'queryV3EulerEarnDetail',
  'queryVaultFactories',
] as const satisfies readonly EulerSDKQueryName[]

export const sdkQueryClient = new QueryClient()

const buildSdkQuery = (overrides: Partial<Record<EulerSDKQueryName, number>>): BuildQueryFn => {
  return ((queryName: string, fn, _target: object, context) => {
    const wrapped = (async (...args: Parameters<typeof fn>) => {
      const serializedArgs = context?.getCacheKey(args) ?? serializeQueryArgs(args)
      if (serializedArgs === null) {
        throw new TypeError(`SDK query arguments for ${queryName} are not serializable`)
      }

      const result = await sdkQueryClient.fetchQuery({
        queryKey: ['sdk', queryName, serializedArgs],
        queryFn: async () => {
          const value = await fn(...args)
          return value === undefined ? null : value
        },
        staleTime: overrides[queryName as EulerSDKQueryName]
          ?? STALE_TIMES[queryName as EulerSDKQueryName]
          ?? 5 * SECOND,
      })

      return result === null ? undefined : result
    }) as typeof fn

    return wrapped
  }) as BuildQueryFn
}

/** Default cache policy — used by the "fast" SDK instance (UI browsing). */
export const sdkBuildQuery = buildSdkQuery({})

/** Plan-critical override map. Every query name listed here is forced to a
 *  zero stale-time on the fresh instance, so plan construction, simulation,
 *  and execute-time approval resolution always read live chain state.
 *  Non-listed queries fall through to STALE_TIMES — so labels, ABIs, prices,
 *  rewards breakdowns etc. still hit the shared QueryClient cache. */
const FRESH_OVERRIDES: Partial<Record<EulerSDKQueryName, number>> = {
  queryEVCAccountInfo: 0,
  queryVaultAccountInfo: 0,
  queryEVaultInfoFull: 0,
  queryEulerEarnVaultInfoFull: 0,
  queryBatchSimulation: 0,
  queryBalanceOf: 0,
  queryNativeBalance: 0,
  queryAllowance: 0,
  queryPermit2Allowance: 0,
  queryPythUpdateData: 0,
  queryPythUpdateFee: 0,
}

/** Plan-time cache policy — used by the "fresh"/slow SDK instance.
 *  Shares the same QueryClient as the fast instance, so a forced refetch here
 *  also primes the fast cache; non-plan-critical reads stay cached. */
export const sdkFreshBuildQuery = buildSdkQuery(FRESH_OVERRIDES)

export const invalidateSdkQueries = (queryNames: EulerSDKQueryName[]) => {
  const names = new Set<string>(queryNames)
  return sdkQueryClient.invalidateQueries({
    predicate: query =>
      query.queryKey[0] === 'sdk'
      && typeof query.queryKey[1] === 'string'
      && names.has(query.queryKey[1]),
  })
}
