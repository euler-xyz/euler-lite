<script setup lang="ts">
// Each form supplies its operation-specific guards; shared alerts distinguish
// missing compliance context from a confirmed geographic restriction.
defineProps<{
  isGeoBlocked?: boolean
  vaultAddresses?: (string | undefined)[]
  assetRestricted?: boolean
  assetRestrictedDescription?: string
  swapRestricted?: boolean
  swapRestrictedDescription?: string
  estimatesError?: string
  simulationError?: string
}>()
</script>

<template>
  <GeoBlockAlert
    v-if="isGeoBlocked"
    :vault-addresses="vaultAddresses ?? []"
    description="This operation is not available in your region. You can still repay existing debt."
  />
  <GeoBlockAlert
    v-if="!isGeoBlocked && assetRestricted"
    :vault-addresses="vaultAddresses ?? []"
    title="Asset restricted"
    :description="assetRestrictedDescription"
  />
  <GeoBlockAlert
    v-if="!isGeoBlocked && swapRestricted"
    :vault-addresses="vaultAddresses ?? []"
    title="Swap restricted"
    :description="swapRestrictedDescription"
  />
  <UiAlert
    v-show="estimatesError"
    title="Error"
    variant="error"
    :description="estimatesError"
    size="compact"
  />
  <UiAlert
    v-if="simulationError"
    title="Error"
    variant="error"
    :description="simulationError"
    size="compact"
  />
</template>
