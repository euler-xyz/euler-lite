<script setup lang="ts">
import {
  isEVault,
  isSecuritizeCollateralVault,
  type EVault,
  type SecuritizeCollateralVault,
  type PortfolioBorrowPosition,
  type VaultEntity,
} from '@eulerxyz/euler-v2-sdk'
import type { AnyBorrowVaultPair } from '~/types/borrow-pair'
import { getPairBorrowVault, getPairCollateralVault } from '~/utils/borrow-pair'
import { getUniqueEntitiesByVaults } from '~/utils/eulerLabelsUtils'

const { pair } = defineProps<{ pair: AnyBorrowVaultPair | PortfolioBorrowPosition<VaultEntity> }>()
const { isVaultGovernorVerified, isSecuritizeGovernorVerified } = useVaults()
const entities = computed(() => {
  const trusted: Array<EVault | SecuritizeCollateralVault> = []
  const borrow = getPairBorrowVault(pair)
  const collateral = getPairCollateralVault(pair)
  if (isEVault(borrow) && isVaultGovernorVerified(borrow)) trusted.push(borrow)
  if (isSecuritizeCollateralVault(collateral)) {
    if (isSecuritizeGovernorVerified(collateral)) trusted.push(collateral)
  }
  else if (isEVault(collateral) && isVaultGovernorVerified(collateral)) trusted.push(collateral)
  return getUniqueEntitiesByVaults(trusted)
})
</script>

<template>
  <VaultEntityDisclosures
    :entities="entities"
    title="Curator details"
  />
</template>
