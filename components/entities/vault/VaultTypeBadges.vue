<script setup lang="ts">
import { zeroAddress } from 'viem'
import type { AnyVault } from '~/composables/useVaultRegistry'
import type { Vault, EarnVault, SecuritizeVault } from '~/entities/vault'
import { isCyclicalNoteVault } from '~/entities/vault'
import { isVaultKeyring, getEntitiesByVault, getEntitiesByEarnVault } from '~/utils/eulerLabelsUtils'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'

const { vault, layout = 'inline', size = 'small' } = defineProps<{
  vault: AnyVault
  layout?: 'inline' | 'stacked'
  size?: 'small' | 'large'
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

const isStacked = computed(() => layout === 'stacked')
const tagElement = computed(() => isStacked.value ? 'button' : 'span')
</script>

<template>
  <div
    class="flex gap-8"
    :class="isStacked ? 'flex-col items-stretch' : 'items-center flex-wrap'"
  >
    <VaultTypeChip
      :vault="vault"
      :type="governanceType"
      :size="size"
      :block="isStacked"
      :as="tagElement"
    />
    <VaultTypeChip
      v-if="extraType && isVerified"
      :vault="vault"
      :type="extraType"
      :size="size"
      :block="isStacked"
      :as="tagElement"
    />
    <KeyringBadge
      v-if="isKeyring && isVerified"
      :size="size"
      :block="isStacked"
      :as="tagElement"
    />
    <GovernanceLimitedBadge
      v-if="isGovernanceLimited"
      :size="size"
      :block="isStacked"
      :as="tagElement"
    />
    <CyclicalNoteBadge
      v-if="isCyclicalNote && isVerified"
      :size="size"
      :block="isStacked"
      :as="tagElement"
    />
  </div>
</template>
