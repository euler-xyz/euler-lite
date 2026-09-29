import type { EulerEarn } from '@eulerxyz/euler-v2-sdk'
import type { MarketGroup } from '~/entities/lend-discovery'
import type { EulerLabelProduct } from '~/entities/euler/labels'
import { getEntitiesByEarnVault, isEarnVaultNotExplorable, isVaultSelectedByTag } from '~/utils/eulerLabelsUtils'
import { getEulerLabelsSourceData } from '~/composables/useEulerLabels'
import { getEulerLabelEntityId, isEulerLabelProductManagedBy } from '~/utils/manager-profile'

export type ManagerProductEntry = {
  key: string
  product: EulerLabelProduct
}

export const useEulerManagerProfile = (entityId: Ref<string>) => {
  const { entities, products, isReady: labelsReady, loadError: labelsError, retryLabels } = useEulerLabels()
  const { isEarnUpdating, isEarnVaultOwnerVerified } = useVaults()
  const { getEarnVaults, isVerifiedVault } = useVaultRegistry()
  const showAllLabelEntries = useShowAllLabelEntries()
  const {
    marketGroups,
    isReady: marketGroupsReady,
    isResolvingTVL,
  } = useMarketGroups()

  const entity = computed(() => entities[entityId.value] ?? null)

  const productEntries = computed<ManagerProductEntry[]>(() =>
    Object.entries(products)
      .filter(([, product]) => isEulerLabelProductManagedBy(product, entityId.value))
      .map(([key, product]) => ({ key, product }))
      .sort((a, b) => a.product.name.localeCompare(b.product.name)),
  )

  const managedProductKeys = computed(() => new Set(productEntries.value.map(entry => entry.key)))

  const managedMarkets = computed<MarketGroup[]>(() =>
    marketGroups.value
      .filter(group => group.source === 'product' && managedProductKeys.value.has(group.id))
      .sort((a, b) => b.metrics.totalTVL - a.metrics.totalTVL || a.name.localeCompare(b.name)),
  )

  const managesEarnEntity = (candidate: EulerEarn): boolean => {
    const labels = getEulerLabelsSourceData()
    if (labels.source === 'v3' || labels.source === 'v3-metadata') {
      return labels.managingEntityByVault?.[candidate.address.toLowerCase()] === entityId.value
    }
    return getEntitiesByEarnVault(candidate).some(manager =>
      getEulerLabelEntityId(entities, manager) === entityId.value,
    )
  }

  const earnVaults = computed(() =>
    getEarnVaults()
      .filter(candidate =>
        managesEarnEntity(candidate)
        && isVerifiedVault(candidate.address)
        && isEarnVaultOwnerVerified(candidate)
        && isVaultSelectedByTag(candidate.address)
        && (showAllLabelEntries.value || !isEarnVaultNotExplorable(candidate.address)),
      )
      .sort((a, b) => a.asset.symbol.localeCompare(b.asset.symbol)),
  )

  const isUnavailable = computed(() => !labelsReady.value && Boolean(labelsError.value))
  const isLoading = computed(() =>
    !isUnavailable.value && (!labelsReady.value
      || !marketGroupsReady.value
      || isResolvingTVL.value
      || isEarnUpdating.value),
  )

  return {
    entity,
    productEntries,
    managedMarkets,
    earnVaults,
    isUnavailable,
    isLoading,
    retryLabels,
  }
}
