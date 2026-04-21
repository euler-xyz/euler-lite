<script setup lang="ts">
import type { REULLock } from '~/entities/reul'
import { formatNumber } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'

const { getTokenByAddress } = useTokenList()
const { reulTokenContractAddress } = useREULLocks()

const { item } = defineProps<{
  item: REULLock
  onConfirm: () => void
}>()
defineEmits(['close'])

// rEUL address from contract config; metadata from the unified token list.
const reulToken = computed(() => getTokenByAddress(reulTokenContractAddress.value))

const unlockableAmount = computed(() => {
  return nanoToValue(item.unlockableAmount, reulToken.value?.decimals)
})

const amountToBeBurned = computed(() => {
  return nanoToValue(item.amountToBeBurned, reulToken.value?.decimals)
})
</script>

<template>
  <div
    class="flex flex-col absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 p-16 min-w-[375px] max-w-[600px] overflow-auto styled-scrollbar max-h-[85dvh] rounded-16 mobile:top-auto mobile:left-0 mobile:bottom-0 mobile:w-full mobile:min-w-full mobile:max-h-[95dvh] mobile:translate-x-0 mobile:translate-y-0 mobile:rounded-t-16 mobile:rounded-b-0 bg-card"
  >
    <div
      class="flex justify-between mb-12 items-center text-h3 h-36"
    >
      Are you sure?
    </div>
    <div class="text-p2 text-content-primary mb-24">
      This action will unlock <span class="text-accent-500">{{ formatNumber(unlockableAmount, 6) }} EUL</span>,
      and <span class="text-accent-500">{{ formatNumber(amountToBeBurned, 6) }} EUL will be permanently burned.</span>
      To fully redeem your EUL rewards, you must wait for the <span class="text-accent-500">6-month</span> vesting period to complete.
    </div>
    <div class="flex justify-between gap-8">
      <UiButton
        variant="primary-stroke"
        size="large"
        rounded
        @click="$emit('close')"
      >
        Cancel
      </UiButton>
      <UiButton
        size="large"
        rounded
        @click="onConfirm(); $emit('close')"
      >
        Confirm
      </UiButton>
    </div>
  </div>
</template>
