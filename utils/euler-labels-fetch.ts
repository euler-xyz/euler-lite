import { EulerLabelsService, type IEulerLabelsService } from '@eulerxyz/euler-v2-sdk'

/** Load verification inputs successfully before asking the SDK to normalize them. */
export const fetchEulerLabelsDataStrict = async (service: IEulerLabelsService, chainId: number) => {
  const [entities, products, earnVaults, points, assets] = await Promise.all([
    service.fetchEulerLabelsEntities(chainId),
    service.fetchEulerLabelsProducts(chainId),
    service.fetchEulerLabelsEarnVaults(chainId),
    service.fetchEulerLabelsPoints(chainId).catch(() => []),
    service.fetchEulerLabelsAssets(chainId),
  ])

  return new EulerLabelsService({
    fetchEulerLabelsEntities: async () => entities,
    fetchEulerLabelsProducts: async () => products,
    fetchEulerLabelsEarnVaults: async () => earnVaults,
    fetchEulerLabelsPoints: async () => points,
    fetchEulerLabelsAssets: async () => assets,
  }).fetchEulerLabelsData(chainId)
}
