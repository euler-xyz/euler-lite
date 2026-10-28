<script setup lang="ts">
import {
  getLiquidationCoverageWarning,
  LIQUIDATION_COVERAGE_BADGE_LABEL,
  type LiquidationCoverageContext,
} from '~/utils/liquidation-coverage'

const { vault, context = 'lend' } = defineProps<{
  vault: { address: string } & object
  context?: LiquidationCoverageContext
}>()

const { chainId } = useEulerAddresses()
const { ensureLiquidationCoverage, isNotCoveredByDefaultBot } = useLiquidationCoverage()

watch(chainId, (id) => {
  if (id) ensureLiquidationCoverage(id)
}, { immediate: true })

const warning = computed(() => chainId.value && isNotCoveredByDefaultBot(chainId.value, vault)
  ? getLiquidationCoverageWarning(context)
  : null)
</script>

<template>
  <UiHoverPreviewTooltip
    v-if="warning"
    :title="warning.title"
    :text="warning.message"
    placement="top-start"
  >
    <span
      class="inline-flex shrink-0 items-center gap-4 whitespace-nowrap rounded-8 bg-warning-100 px-8 py-2 text-p5 text-warning-500"
      data-id="liquidation-coverage"
      :data-vault-address="vault.address.toLowerCase()"
    >
      <SvgIcon
        name="warning"
        class="!h-14 !w-14"
      />
      <span class="mobile:hidden">{{ LIQUIDATION_COVERAGE_BADGE_LABEL }}</span>
    </span>
  </UiHoverPreviewTooltip>
</template>
