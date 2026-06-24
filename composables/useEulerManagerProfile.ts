import type { EulerEarn, EVault, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import type { EulerLabelProduct } from '~/entities/euler/labels'
import { getEntitiesByEarnVault, getEntitiesByVault } from '~/utils/eulerLabelsUtils'
import { getEulerLabelEntitySlug, isEulerLabelProductManagedBy } from '~/utils/manager-profile'

export type ManagerProductEntry = {
  key: string
  product: EulerLabelProduct
}

export const useEulerManagerProfile = (slug: Ref<string>) => {
  const { entities, products, isReady: labelsReady } = useEulerLabels()
  const {
    isEVaultUpdating,
    isEarnUpdating,
    isSecuritizeUpdating,
    isEscrowUpdating,
  } = useVaults()
  const {
    getVerifiedEVaults,
    getEarnVaults,
    getSecuritizeVaults,
  } = useVaultRegistry()
  const showAllLabelEntries = useShowAllLabelEntries()

  const entity = computed(() => entities[slug.value] ?? null)

  const productEntries = computed<ManagerProductEntry[]>(() =>
    Object.entries(products)
      .filter(([, product]) => isEulerLabelProductManagedBy(product, slug.value))
      .map(([key, product]) => ({ key, product }))
      .sort((a, b) => a.product.name.localeCompare(b.product.name)),
  )

  const managesEntity = (candidate: EVault | SecuritizeCollateralVault): boolean =>
    getEntitiesByVault(candidate as EVault).some(manager =>
      getEulerLabelEntitySlug(entities, manager) === slug.value,
    )

  const managesEarnEntity = (candidate: EulerEarn): boolean =>
    getEntitiesByEarnVault(candidate).some(manager =>
      getEulerLabelEntitySlug(entities, manager) === slug.value,
    )

  const evaults = computed(() =>
    getVerifiedEVaults(showAllLabelEntries.value)
      .filter(managesEntity)
      .sort((a, b) => a.asset.symbol.localeCompare(b.asset.symbol)),
  )

  const securitizeVaults = computed(() =>
    getSecuritizeVaults()
      .filter(managesEntity)
      .sort((a, b) => a.asset.symbol.localeCompare(b.asset.symbol)),
  )

  const earnVaults = computed(() =>
    getEarnVaults()
      .filter(managesEarnEntity)
      .sort((a, b) => a.asset.symbol.localeCompare(b.asset.symbol)),
  )

  const vaultCount = computed(() =>
    evaults.value.length + securitizeVaults.value.length + earnVaults.value.length,
  )

  const isLoading = computed(() =>
    !labelsReady.value
    || isEVaultUpdating.value
    || isEarnUpdating.value
    || isSecuritizeUpdating.value
    || isEscrowUpdating.value,
  )

  return {
    entity,
    productEntries,
    evaults,
    securitizeVaults,
    earnVaults,
    vaultCount,
    isLoading,
  }
}
