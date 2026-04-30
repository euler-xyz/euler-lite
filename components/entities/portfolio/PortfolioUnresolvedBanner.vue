<script setup lang="ts">
const { unresolvedBorrowCount, unresolvedDepositCount } = useEulerAccount()

const dismissed = ref(false)

const totalCount = computed(() => unresolvedBorrowCount.value + unresolvedDepositCount.value)

// Re-show whenever a new failure arrives (count grows) so a dismissal doesn't
// swallow a fresh problem. `clearUnresolvedPositions` in `useEulerAccount` runs
// at the start of every refresh, so the trajectory during a failing refresh is
// N -> 0 -> M: the increment from 0 to any positive value un-dismisses.
watch(totalCount, (count, prev) => {
  if (count > prev) dismissed.value = false
})

const isVisible = computed(() => totalCount.value > 0 && !dismissed.value)

const positionsText = computed(() =>
  `${unresolvedBorrowCount.value} position${unresolvedBorrowCount.value === 1 ? '' : 's'}`,
)
const depositsText = computed(() =>
  `${unresolvedDepositCount.value} deposit${unresolvedDepositCount.value === 1 ? '' : 's'}`,
)

const message = computed(() => {
  const b = unresolvedBorrowCount.value
  const d = unresolvedDepositCount.value
  if (b > 0 && d > 0) return `${positionsText.value} and ${depositsText.value} couldn't be loaded.`
  if (b > 0) return `${positionsText.value} couldn't be loaded.`
  return `${depositsText.value} couldn't be loaded.`
})
</script>

<template>
  <Transition name="hint">
    <div
      v-if="isVisible"
      class="flex items-center gap-8 bg-warning-100 rounded-12 p-12 mx-16"
    >
      <SvgIcon
        name="info-circle"
        class="!w-20 !h-20 text-warning-500 shrink-0"
      />
      <span class="text-warning-500 text-p4 flex-1">
        {{ message }}
        This is usually temporary — your funds are safe on-chain. If it persists, please reach out to the team.
      </span>
      <button
        type="button"
        class="shrink-0 w-20 h-20 flex items-center justify-center self-start text-warning-500 hover:text-warning-500/70 transition-colors"
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
