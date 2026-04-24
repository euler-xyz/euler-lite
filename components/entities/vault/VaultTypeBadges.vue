<script setup lang="ts">
import { zeroAddress } from 'viem'
import type { Vault, EarnVault } from '~/entities/vault'
import { isCyclicalNoteVault } from '~/entities/vault'
import { isVaultKeyring, getEntitiesByVault, getEntitiesByEarnVault } from '~/utils/eulerLabelsUtils'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'

const { vaultAddress } = defineProps<{
  vaultAddress: string
}>()

const { isVaultGovernorVerified, isEarnVaultOwnerVerified } = useVaults()
const { getVault, isEarnVault, isSecuritizeVault } = useVaultRegistry()

const addressRef = computed(() => vaultAddress)
const product = useEulerProductOfVault(addressRef)
const vault = computed(() => getVault(vaultAddress))

const isEarn = computed(() => isEarnVault(vaultAddress))
const isSecuritize = computed(() => isSecuritizeVault(vaultAddress))

const entities = computed(() => {
  if (!vault.value) return []
  if (isEarn.value) return getEntitiesByEarnVault(vault.value as EarnVault)
  return getEntitiesByVault(vault.value as Vault)
})

const isVerified = computed(() => {
  if (!vault.value) return false
  if (isEarn.value) return isEarnVaultOwnerVerified(vault.value as EarnVault)
  return isVaultGovernorVerified(vault.value as Vault)
})

const isGovernanceLimited = computed(() =>
  product.isGovernanceLimited && isVerified.value,
)

const governanceType = computed(() => {
  if (!vault.value) return 'unknown'

  if (isEarn.value) {
    return entities.value.length ? 'managed' : 'unknown'
  }

  const v = vault.value as Vault
  if (v.vaultCategory === 'escrow') return 'escrow'
  if (!v.governorAdmin) return 'unknown'
  if (v.governorAdmin === zeroAddress) return 'ungoverned'
  if (entities.value.length) {
    return 'governed'
  }
  return 'unknown'
})

const extraType = computed(() => {
  if (isSecuritize.value) return 'securitize'
  return undefined
})

const isKeyring = computed(() => isVaultKeyring(vaultAddress))

const isCyclicalNote = computed(() => {
  if (!vault.value || isEarn.value) return false
  return isCyclicalNoteVault(vault.value as Vault)
})
</script>

<template>
  <div
    v-if="vault"
    class="flex items-center gap-8 flex-wrap"
  >
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
