import type { EulerEarn } from '@eulerxyz/euler-v2-sdk'
import type { MarketGroup } from '~/entities/lend-discovery'
import type { EulerLabelProduct } from '~/entities/euler/labels'
import { getEntitiesByEarnVault } from '~/utils/eulerLabelsUtils'
import { getEulerLabelEntitySlug, isEulerLabelProductManagedBy } from '~/utils/manager-profile'

export type ManagerProductEntry = {
  key: string
  product: EulerLabelProduct
}

export const useEulerManagerProfile = (slug: Ref<string>) => {
  const { entities, products, isReady: labelsReady } = useEulerLabels()
  const { isEarnUpdating } = useVaults()
  const { getEarnVaults } = useVaultRegistry()
  const {
    marketGroups,
    isReady: marketGroupsReady,
    isResolvingTVL,
  } = useMarketGroups()

  const entity = computed(() => entities[slug.value] ?? null)

  const productEntries = computed<ManagerProductEntry[]>(() =>
    Object.entries(products)
      .filter(([, product]) => isEulerLabelProductManagedBy(product, slug.value))
      .map(([key, product]) => ({ key, product }))
      .sort((a, b) => a.product.name.localeCompare(b.product.name)),
  )

  const managedProductKeys = computed(() => new Set(productEntries.value.map(entry => entry.key)))

  const managedMarkets = computed<MarketGroup[]>(() =>
    marketGroups.value
      .filter(group => group.source === 'product' && managedProductKeys.value.has(group.id))
      .sort((a, b) => b.metrics.totalTVL - a.metrics.totalTVL || a.name.localeCompare(b.name)),
  )

  const managesEarnEntity = (candidate: EulerEarn): boolean =>
    getEntitiesByEarnVault(candidate).some(manager =>
      getEulerLabelEntitySlug(entities, manager) === slug.value,
    )

  const earnVaults = computed(() =>
    getEarnVaults()
      .filter(managesEarnEntity)
      .sort((a, b) => a.asset.symbol.localeCompare(b.asset.symbol)),
  )

  const isLoading = computed(() =>
    !labelsReady.value
    || !marketGroupsReady.value
    || isResolvingTVL.value
    || isEarnUpdating.value,
  )

  return {
    entity,
    productEntries,
    managedMarkets,
    earnVaults,
    isLoading,
  }
}
