<script setup lang="ts">
import { isEVault, type EulerEarn, type EVault, type SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { isCyclicalNoteVault } from '~/utils/vault/classification'
import { isVaultKeyring, getEntitiesByVault, getEntitiesByEarnVault } from '~/utils/eulerLabelsUtils'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'
import { zeroAddress } from 'viem'

const { vault } = defineProps<{
  vault: EVault | EulerEarn | SecuritizeCollateralVault
}>()

const { isVaultGovernorVerified, isEarnVaultOwnerVerified } = useVaults()
const { getVaultCategory, isVerifiedVault } = useVaultRegistry()

const addressRef = computed(() => vault.address)
const product = useEulerProductOfVault(addressRef)

const isEarn = computed(() => vault.type === 'EulerEarn')
const isSecuritize = computed(() => vault.type === 'SecuritizeCollateral')

const entities = computed(() => {
  if (isEarn.value) return getEntitiesByEarnVault(vault as EulerEarn)
  return getEntitiesByVault(vault as EVault | SecuritizeCollateralVault)
})

const isVerified = computed(() => {
  if (isEarn.value) return isEarnVaultOwnerVerified(vault as EulerEarn)
  if (isSecuritize.value) return isVerifiedVault(vault.address)
  return isVaultGovernorVerified(vault as EVault)
})

const isGovernanceLimited = computed(() =>
  product.isGovernanceLimited && isVerified.value,
)

const governanceType = computed(() => {
  if (isEarn.value) {
    return entities.value.length ? 'managed' : 'unknown'
  }

  if (isEVault(vault) && getVaultCategory(vault.address) === 'escrow') return 'escrow'
  const governor = isSecuritize.value
    ? (vault as SecuritizeCollateralVault).governor
    : (vault as EVault).governorAdmin
  if (!governor) return 'unknown'
  if (governor === zeroAddress) return 'ungoverned'
  if (entities.value.length) {
    return 'governed'
  }
  return 'unknown'
})

const extraType = computed(() => {
  if (isSecuritize.value) return 'securitize'
  return undefined
})

const isKeyring = computed(() => isVaultKeyring(vault.address))

const isCyclicalNote = computed(() => {
  if (!isEVault(vault)) return false
  return isCyclicalNoteVault(vault)
})
</script>

<template>
  <div class="flex items-center gap-8 flex-wrap">
    <VaultTypeChip
      :vault="vault"
      :type="governanceType"
    />
    <VaultTypeChip
      v-if="extraType && isVerified"
      :vault="vault"
      :type="extraType"
    />
    <KeyringBadge
      v-if="isKeyring && isVerified"
      size="large"
    />
    <GovernanceLimitedBadge
      v-if="isGovernanceLimited"
      size="large"
    />
    <CyclicalNoteBadge
      v-if="isCyclicalNote"
      size="large"
    />
  </div>
</template>
