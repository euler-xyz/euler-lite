<script setup lang="ts">
import { getVaultDeprecation } from '~/utils/eulerLabelsUtils'

const props = defineProps<{ addresses: string[] }>()
const { isReady, source, visibility } = useEulerLabels()
const deprecation = computed(() => {
  // The labels bundle is reactive even though the shared helper reads its
  // current snapshot synchronously.
  void isReady.value
  void source.value
  void visibility.value
  const reasons = props.addresses
    .map(address => getVaultDeprecation(address))
    .filter(result => result.deprecated)
    .map(result => result.reason)
  return { deprecated: reasons.length > 0, reason: [...new Set(reasons)].join(' ') }
})
</script>

<template>
  <UiHoverPreviewTooltip
    v-if="deprecation.deprecated"
    title="Deprecated"
    :text="deprecation.reason"
    placement="top-start"
  >
    <span class="inline-flex items-center gap-4 rounded-8 px-8 py-2 bg-warning-100 text-warning-500 text-p5">
      <SvgIcon
        name="warning"
        class="!w-14 !h-14"
      />
      Deprecated
    </span>
  </UiHoverPreviewTooltip>
</template>
