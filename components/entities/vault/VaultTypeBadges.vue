<script setup lang="ts">
import type { AnyVault } from '~/composables/useVaultRegistry'
import type { VaultTypeBadge } from '~/composables/useVaultTypeBadges'

const { vault, layout = 'inline', size = 'small', nudge = false, summaryOnly = false } = defineProps<{
  vault: AnyVault
  layout?: 'inline' | 'stacked'
  size?: 'small' | 'large'
  nudge?: boolean
  summaryOnly?: boolean
}>()

const vaultRef = computed(() => vault)
const { badges, governanceType, summaryBadges } = useVaultTypeBadges(vaultRef)

const isStacked = computed(() => layout === 'stacked')
const tagElement = computed(() => isStacked.value ? 'button' : 'span')
const visibleBadges = computed(() => summaryOnly ? summaryBadges.value : badges.value)
const hasVisibleBadge = (badge: VaultTypeBadge): boolean => visibleBadges.value.includes(badge)
const showGovernanceType = computed(() => hasVisibleBadge(governanceType.value))
</script>

<template>
  <div
    class="flex gap-8"
    :class="isStacked ? 'flex-col items-stretch' : 'items-center flex-wrap'"
  >
    <VaultTypeChip
      v-if="showGovernanceType"
      :vault="vault"
      :type="governanceType"
      :size="size"
      :block="isStacked"
      :as="tagElement"
      :nudge="nudge"
    />
    <VaultTypeChip
      v-if="hasVisibleBadge('securitize')"
      :vault="vault"
      type="securitize"
      :size="size"
      :block="isStacked"
      :as="tagElement"
      :nudge="nudge"
    />
    <KeyringBadge
      v-if="hasVisibleBadge('private')"
      :size="size"
      :block="isStacked"
      :as="tagElement"
      :nudge="nudge"
    />
    <GovernanceLimitedBadge
      v-if="hasVisibleBadge('governanceLimited')"
      :size="size"
      :block="isStacked"
      :as="tagElement"
      :nudge="nudge"
    />
    <CyclicalNoteBadge
      v-if="hasVisibleBadge('cyclicalNote')"
      :size="size"
      :block="isStacked"
      :as="tagElement"
      :nudge="nudge"
    />
  </div>
</template>
