<script setup lang="ts">
import type { EVaultCollateral } from '@eulerxyz/euler-v2-sdk'
import { DateTime } from 'luxon'
import { formatNumber } from '~/utils/string-utils'

const emits = defineEmits(['close'])
const { liquidationLTV, ramping } = defineProps<EVaultCollateral>()

const rampEndTime = computed(() => DateTime.fromSeconds(ramping?.targetTimestamp ?? 0))

const handleClose = () => {
  emits('close')
}
</script>

<template>
  <BaseModalWrapper
    title="Liquidation LTV ramping"
    @close="handleClose"
  >
    <div class="mb-24">
      <div class="flex justify-between items-center pb-16 border-b border-line-default">
        <div>
          <p class="mb-4">
            Liquidation LTV after ramp
          </p>
        </div>
        <div class="text-h5">
          {{ `${formatNumber(ltvToPercent(liquidationLTV), 2)}%` }}
        </div>
      </div>
      <div class="flex justify-between items-center mt-16">
        <div>
          <p class="mb-4">
            Ramp ends
          </p>
        </div>
        <div class="text-h5">
          {{ rampEndTime.toRelative({ base: DateTime.now(), style: 'short' }) }}
        </div>
      </div>
    </div>
  </BaseModalWrapper>
</template>
