<script setup lang="ts">
import { getLiquidationCoverageWarning, type LiquidationCoverageContext } from '~/utils/liquidation-coverage'

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
  <div
    v-if="warning"
    class="w-full rounded-12 p-16 bg-warning-100 text-warning-500"
    data-id="liquidation-coverage-notice"
  >
    <div class="flex items-center gap-8">
      <SvgIcon
        name="warning"
        class="!w-20 !h-20 flex-shrink-0"
      />
      <p class="text-p3 text-warning-500">
        {{ warning.message }}
      </p>
    </div>
  </div>
</template>
