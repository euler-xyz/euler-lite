import { QueryClient } from '@tanstack/vue-query'
import { serializeQueryArgs, type BuildQueryFn, type EulerSDKQueryName } from '@eulerxyz/euler-v2-sdk'

const SECOND = 1_000
const MINUTE = 60 * SECOND

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

  queryEVaultInfoFull: 20 * SECOND,
  queryEulerEarnVaultInfoFull: 20 * SECOND,
  queryV3EVaultDetail: 20 * SECOND,
  queryV3EulerEarnDetail: 20 * SECOND,

  queryAssetPriceInfo: MINUTE,
  queryV3RewardsBreakdown: MINUTE,
  queryV3IntrinsicApy: MINUTE,

  queryBatchSimulation: 10 * SECOND,
  queryPythUpdateData: 10 * SECOND,
  queryPythUpdateFee: 10 * SECOND,
}

export const sdkQueryClient = new QueryClient()

export const sdkBuildQuery: BuildQueryFn = (
  queryName: string,
  fn,
  _target: object,
) => {
  const wrapped = (async (...args: Parameters<typeof fn>) => {
    const serializedArgs = serializeQueryArgs(args)
    if (serializedArgs === null) {
      return fn(...args)
    }

    const result = await sdkQueryClient.fetchQuery({
      queryKey: ['sdk', queryName, serializedArgs],
      queryFn: async () => {
        const value = await fn(...args)
        return value === undefined ? null : value
      },
      staleTime: STALE_TIMES[queryName as EulerSDKQueryName] ?? 5 * SECOND,
    })

    return result === null ? undefined : result
  }) as typeof fn

  return wrapped
}

export const invalidateSdkQueries = (queryNames: EulerSDKQueryName[]) => {
  const names = new Set<string>(queryNames)
  return sdkQueryClient.invalidateQueries({
    predicate: query =>
      query.queryKey[0] === 'sdk'
      && typeof query.queryKey[1] === 'string'
      && names.has(query.queryKey[1]),
  })
}
