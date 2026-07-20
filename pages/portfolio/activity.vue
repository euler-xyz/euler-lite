<script setup lang="ts">
import type { Address } from 'viem'
import { getAddress, isAddress } from 'viem'
import type { ActivityFeedScope } from '~/composables/useActivityFeed'
import { getAccountActivityFilterOptions } from '~/utils/activity-display'

defineOptions({
  name: 'PortfolioActivityPage',
})

const route = useRoute()
const { chainId } = useEulerAddresses()
const { effectiveAddress } = useEffectiveAddress()
const owner = computed<Address | undefined>(() => {
  const value = effectiveAddress.value
  return value && isAddress(value) ? getAddress(value) : undefined
})
const availability = useActivityAvailability({ kind: 'account' }, chainId)
const runtimeSupport = usePortfolioActivityRuntimeSupport(owner, chainId)
const categoryOptions = getAccountActivityFilterOptions()
const isActive = computed(() => route.name === 'portfolio-activity')
const feedScope = computed<ActivityFeedScope | undefined>(() => owner.value
  ? {
      kind: 'account',
      owner: owner.value,
      chainId: Number(chainId.value),
    }
  : undefined,
)

watch([owner, () => Number(chainId.value)], () => {
  runtimeSupport.setRuntimeUnsupported(false)
})
</script>

<template>
  <section class="mx-16 flex flex-col gap-16">
    <div
      v-if="!owner"
      class="flex flex-col items-center gap-8 rounded-12 border border-line-subtle bg-surface p-24 text-center"
    >
      <div class="text-p3 text-content-primary">
        Connect a wallet to view position activity.
      </div>
      <div class="text-p4 text-content-secondary">
        You can also open a portfolio in spy mode to inspect its history.
      </div>
    </div>

    <div
      v-else-if="availability.isChecking.value"
      class="flex flex-col gap-8"
      aria-label="Checking activity availability"
    >
      <div
        v-for="index in 3"
        :key="index"
        class="h-72 animate-pulse rounded-12 bg-surface"
      />
    </div>

    <div
      v-else-if="availability.reason.value === 'capability-check-failed'"
      class="flex flex-col items-center gap-12 rounded-12 border border-line-subtle bg-surface p-24 text-center"
      role="alert"
    >
      <div class="text-p3 text-content-primary">
        Activity availability could not be checked right now.
      </div>
      <button
        type="button"
        class="ui-button ui-button--medium ui-button--secondary"
        :disabled="availability.isChecking.value"
        @click="availability.refreshAvailability"
      >
        {{ availability.isChecking.value ? 'Retrying…' : 'Retry' }}
      </button>
    </div>

    <ActivityFeed
      v-else-if="feedScope && availability.isSupported.value"
      :scope="feedScope"
      :enabled="isActive"
      :category-options="categoryOptions"
      subject="account"
      @update:unsupported="runtimeSupport.setRuntimeUnsupported"
    />

    <div
      v-else
      class="rounded-12 border border-line-subtle bg-surface p-16 text-p3 text-content-secondary"
    >
      Activity is not available on this network.
    </div>
  </section>
</template>
