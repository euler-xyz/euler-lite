<script setup lang="ts">
import { getPositionRampStatus } from '~/entities/account'

const { borrowPositions } = useEulerAccount()

const dismissed = ref(false)

const statuses = computed(() =>
  borrowPositions.value.map(p => getPositionRampStatus(p)),
)
const rampingCount = computed(() => statuses.value.filter(s => s.isRamping).length)
const dangerCount = computed(() => statuses.value.filter(s => s.willBeLiquidated).length)

// Re-show whenever the danger count grows or new ramping positions appear, so a
// dismissal can't swallow a freshly-detected situation on the next refresh.
watch([rampingCount, dangerCount], ([nextRamping, nextDanger], [prevRamping, prevDanger]) => {
  if (nextDanger > prevDanger || nextRamping > prevRamping) dismissed.value = false
})

const isDanger = computed(() => dangerCount.value > 0)
const isVisible = computed(() => rampingCount.value > 0 && !dismissed.value)

const message = computed(() => {
  if (isDanger.value) {
    const noun = dangerCount.value === 1 ? 'position is' : 'positions are'
    return `${dangerCount.value} ${noun} in a vault pair with a ramping Liquidation LTV and projected to become liquidatable before the ramp ends.`
  }
  const noun = rampingCount.value === 1 ? 'position is' : 'positions are'
  return `${rampingCount.value} ${noun} in a vault pair with a Liquidation LTV ramping down. Your positions are currently safe at the post-ramp threshold.`
})
</script>

<template>
  <Transition name="hint">
    <div
      v-if="isVisible"
      class="flex items-center gap-8 rounded-12 p-12 mx-16"
      :class="isDanger ? 'bg-error-100' : 'bg-warning-100'"
    >
      <SvgIcon
        :name="isDanger ? 'warning' : 'info-circle'"
        class="!w-20 !h-20 shrink-0"
        :class="isDanger ? 'text-error-500' : 'text-warning-500'"
      />
      <span
        class="text-p4 flex-1"
        :class="isDanger ? 'text-error-500' : 'text-warning-500'"
      >
        {{ message }}
      </span>
      <button
        type="button"
        class="shrink-0 w-20 h-20 flex items-center justify-center self-start transition-colors"
        :class="isDanger
          ? 'text-error-500 hover:text-error-500/70'
          : 'text-warning-500 hover:text-warning-500/70'"
        @click="dismissed = true"
      >
        &#x2715;
      </button>
    </div>
  </Transition>
</template>

<style scoped>
.hint-enter-active,
.hint-leave-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}

.hint-enter-from,
.hint-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
