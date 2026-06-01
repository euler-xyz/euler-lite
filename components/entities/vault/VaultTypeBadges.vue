<script setup lang="ts">
import type { EulerEarn, EVault, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import type { VaultTypeBadge } from '~/composables/useVaultTypeBadges'

const { vault, layout = 'inline', size = 'small', nudge = false, summaryOnly = false } = defineProps<{
  vault: EVault | EulerEarn | SecuritizeCollateralVault
  layout?: 'inline' | 'stacked'
  size?: 'small' | 'large'
  nudge?: boolean
  summaryOnly?: boolean
}>()

const vaultRef = computed(() => vault)
const { badges, governanceType, summaryBadges, summaryGovernanceType } = useVaultTypeBadges(vaultRef)

const isStacked = computed(() => layout === 'stacked')
const tagElement = computed(() => isStacked.value ? 'button' : 'span')
const visibleBadges = computed(() => summaryOnly ? summaryBadges.value : badges.value)
const visibleGovernanceType = computed(() => summaryOnly ? summaryGovernanceType.value : governanceType.value)
const hasVisibleBadge = (badge: VaultTypeBadge): boolean => visibleBadges.value.includes(badge)
const showGovernanceType = computed(() => hasVisibleBadge(visibleGovernanceType.value))
const hasAnyBadge = computed(() => visibleBadges.value.length > 0)
</script>

<template>
  <div
    v-if="hasAnyBadge"
    class="flex gap-8"
    :class="isStacked ? 'flex-col items-stretch' : 'items-center flex-wrap'"
  >
    <VaultTypeChip
      v-if="showGovernanceType"
      :vault="vault"
      :type="visibleGovernanceType"
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
    <AccessControlBadge
      v-if="hasVisibleBadge('accessControl')"
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
