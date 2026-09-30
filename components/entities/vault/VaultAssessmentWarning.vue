<script setup lang="ts">
const { address, hideDeprecated = false, badgeLabel } = defineProps<{
  address: string
  hideDeprecated?: boolean
  badgeLabel?: string
}>()

const { isReady, source, visibility } = useEulerLabels()
const verdict = computed(() => isReady.value && source.value === 'v3'
  ? visibility.value?.[address.toLowerCase()]
  : undefined)
const warning = computed(() => {
  if (verdict.value?.status !== 'warning' && verdict.value?.status !== 'hidden') return null
  if (hideDeprecated && verdict.value.decidedBy === 'deprecated') return null

  if (verdict.value.decidedBy === 'deprecated') {
    return {
      title: 'Deprecated vault',
      description: verdict.value.reason || 'This vault has been deprecated.',
    }
  }
  if (verdict.value.decidedBy === 'unassessable') {
    return {
      title: 'Vault assessment incomplete',
      description: verdict.value.reason || 'Some checks could not be completed for this vault.',
    }
  }
  return {
    title: verdict.value.status === 'hidden' ? 'Vault not listed' : 'Vault checks',
    description: verdict.value.reason || (verdict.value.status === 'hidden'
      ? 'This vault is not listed.'
      : 'One or more vault checks need review.'),
  }
})
</script>

<template>
  <UiHoverPreviewTooltip
    v-if="warning"
    :title="warning.title"
    :text="warning.description"
    placement="top-start"
  >
    <span
      class="inline-flex items-center gap-4 rounded-8 bg-warning-100 px-8 py-2 text-p5 text-warning-500"
      :title="warning.description"
      data-id="vault-assessment-warning"
      :data-vault-address="address.toLowerCase()"
      :data-warning-reason="verdict?.decidedBy"
    >
      <SvgIcon
        name="warning"
        class="!h-14 !w-14"
      />
      {{ badgeLabel || (verdict?.decidedBy === 'deprecated' ? 'Deprecated' : verdict?.status === 'hidden' ? 'Not listed' : 'Vault checks') }}
    </span>
  </UiHoverPreviewTooltip>
</template>
