<script setup lang="ts">
// Activity log with filters (spec §10.9).
import type { ActivityFilter, ActivityType } from '~/types/zipcode'

definePageMeta({ layout: 'zipcode' })
useHead({ title: 'Activity · Zip Code Finance' })

const { activity } = useZipDemo()
const filter = ref<ActivityFilter>('all')

const groups: Record<Exclude<ActivityFilter, 'all'>, ActivityType[]> = {
  deposits: ['deposit-usdc', 'mint-zipusd'],
  redemptions: ['redemption-request', 'redemption-settlement'],
  claims: ['claim-usdc', 'fast-exit'],
}

const filtered = computed(() => {
  if (filter.value === 'all') return activity.value
  const types = groups[filter.value]
  return activity.value.filter(item => types.includes(item.type))
})
</script>

<template>
  <div class="flex flex-col gap-20">
    <header>
      <h1 class="zip-display text-[34px]">
        Activity
      </h1>
      <p
        class="mt-12 text-[16px] max-w-[640px]"
        style="color: var(--zip-text-muted)"
      >
        Deposits, zipUSD receipts, redemption requests, settlements, and claims across your lender journey.
      </p>
    </header>

    <ZipActivityFilters v-model="filter" />
    <ZipActivityList :items="filtered" />
  </div>
</template>
