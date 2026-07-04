<script setup lang="ts">
// Shared warning stack for the collateral supply/withdraw forms: region /
// asset / swap restriction alerts followed by the estimate and simulation
// error alerts. The restriction alerts differ only in their (already
// composed) visibility condition and their copy, so those are passed as
// props to keep the rendered DOM byte-identical per page.
defineProps<{
  isGeoBlocked?: boolean
  assetRestricted?: boolean
  assetRestrictedDescription?: string
  swapRestricted?: boolean
  swapRestrictedDescription?: string
  estimatesError?: string
  simulationError?: string
}>()
</script>

<template>
  <UiAlert
    v-if="isGeoBlocked"
    title="Region restricted"
    description="This operation is not available in your region. You can still repay existing debt."
    variant="warning"
    size="compact"
  />
  <UiAlert
    v-if="assetRestricted"
    title="Asset restricted"
    :description="assetRestrictedDescription"
    variant="warning"
    size="compact"
  />
  <UiAlert
    v-if="swapRestricted"
    title="Swap restricted"
    :description="swapRestrictedDescription"
    variant="warning"
    size="compact"
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
