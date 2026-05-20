<script setup lang="ts">
import { zeroAddress } from 'viem'
import type { AnyVault } from '~/composables/useVaultRegistry'
import type { Vault, EarnVault, SecuritizeVault } from '~/entities/vault'
import { isCyclicalNoteVault } from '~/entities/vault'
import { isVaultKeyring, getEntitiesByVault, getEntitiesByEarnVault } from '~/utils/eulerLabelsUtils'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'

const { vault } = defineProps<{
  vault: AnyVault
}>()

const { isVaultGovernorVerified, isEarnVaultOwnerVerified } = useVaults()

const addressRef = computed(() => vault.address)
const product = useEulerProductOfVault(addressRef)

const isEarn = computed(() => 'type' in vault && vault.type === 'earn')
const isSecuritize = computed(() => 'type' in vault && vault.type === 'securitize')

const entities = computed(() => {
  if (isEarn.value) return getEntitiesByEarnVault(vault as EarnVault)
  return getEntitiesByVault(vault as Vault | SecuritizeVault)
})

const isVerified = computed(() => {
  if (isEarn.value) return isEarnVaultOwnerVerified(vault as EarnVault)
  return isVaultGovernorVerified(vault as Vault)
})

const isGovernanceLimited = computed(() =>
  product.isGovernanceLimited && isVerified.value,
)

const governanceType = computed(() => {
  if (isEarn.value) {
    return entities.value.length ? 'managed' : 'unknown'
  }

  const v = vault as Vault | SecuritizeVault
  if ('vaultCategory' in v && v.vaultCategory === 'escrow') return 'escrow'
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

const isKeyring = computed(() => isVaultKeyring(vault.address))

const isCyclicalNote = computed(() => {
  if (isEarn.value || isSecuritize.value) return false
  return isCyclicalNoteVault(vault as Vault)
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
      v-if="isCyclicalNote && isVerified"
      size="large"
    />
  </div>
</template>
