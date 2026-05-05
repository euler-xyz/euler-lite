import { QueryClient } from '@tanstack/query-core'
import type { BuildQueryFn, EulerSDKQueryName } from '@eulerxyz/euler-v2-sdk'

const SECOND = 1_000
const MINUTE = 60 * SECOND

const sdkQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
})

const STALE_TIMES: Partial<Record<EulerSDKQueryName, number>> = {
  queryDeployments: Infinity,
  queryABI: Infinity,
  queryTokenList: Infinity,

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

const serializeArg = (arg: unknown): unknown => {
  if (typeof arg === 'bigint') return `bigint:${arg.toString()}`
  if (typeof arg === 'function') return '[function]'
  if (arg && typeof arg === 'object') {
    const candidate = arg as { chain?: { id?: unknown } }
    if (candidate.chain?.id !== undefined) {
      return { clientChainId: candidate.chain.id }
    }
  }
  return arg
}

export const sdkBuildQuery: BuildQueryFn = <T extends (...args: any[]) => Promise<any>>(
  queryName: string,
  fn: T,
  _target: object,
): T => {
  const wrapped = (async (...args: Parameters<T>) => {
    const result = await sdkQueryClient.fetchQuery({
      queryKey: ['sdk', queryName, ...args.map(serializeArg)],
      queryFn: async () => {
        const value = await fn(...args)
        return value === undefined ? null : value
      },
      staleTime: STALE_TIMES[queryName as EulerSDKQueryName] ?? 5 * SECOND,
    })

    return result === null ? undefined : result
  }) as T

  return wrapped
}
