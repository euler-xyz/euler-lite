<script setup lang="ts">
import { formatNumber } from '~/utils/string-utils'
import { PROVIDER_LABELS, PROVIDER_LOGOS } from '~/entities/reward-campaign'
import type { ProjectedYieldDetails, ProjectedYieldRateLine } from '~/utils/projected-yield'

const emit = defineEmits<{ close: [] }>()
const {
  details,
  inline = false,
  close = true,
} = defineProps<{
  details: ProjectedYieldDetails
  inline?: boolean
  close?: boolean
}>()

const title = computed(() => {
  if (details.metric === 'roe') return 'Projected ROE'
  if (details.metric === 'supply-apy') return 'Projected Supply APY'
  return 'Projected Net APY'
})

const description = computed(() => details.metric === 'roe'
  ? 'ROE is annualized return relative to your equity after lending yield, borrowing costs, intrinsic yield, and rewards.'
  : details.metric === 'supply-apy'
    ? 'Supply APY is the projected annualized yield for this deposit after utilization changes, intrinsic yield, and rewards.'
    : 'Net APY is annualized return relative to supplied collateral after lending yield, borrowing costs, intrinsic yield, and rewards.')

const breakdownRows = [
  { key: 'lending' as const, label: 'Lending yield' },
  { key: 'borrowing' as const, label: 'Borrowing cost' },
  { key: 'intrinsicApy' as const, label: 'Intrinsic yield' },
  { key: 'rewards' as const, label: 'Rewards' },
]

const actionLabels: Record<string, string> = {
  LEND: 'Lending reward',
  BORROW: 'Borrow reward',
  BORROW_COLLATERAL: 'Collateral-qualified borrow reward',
  LOOPING: 'Looping reward',
}

const displayPercent = (value: number | null | undefined) =>
  value == null ? '-' : `${formatNumber(value)}%`

const showTransition = (before: number | null | undefined, after: number | null | undefined) =>
  before != null && after != null && displayPercent(before) !== displayPercent(after)

const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`
const rateIdentity = (rate: ProjectedYieldRateLine) => `${rate.label}:${rate.symbol ?? ''}`
const duplicateRateIdentities = computed(() => {
  const counts = new Map<string, number>()
  details.rateLines.forEach((rate) => {
    const key = rateIdentity(rate)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  })
  return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key))
})
const showRateVaultAddress = (rate: ProjectedYieldRateLine) =>
  Boolean(rate.vaultAddress && duplicateRateIdentities.value.has(rateIdentity(rate)))
</script>

<template>
  <BaseModalWrapper
    :title="title"
    :inline="inline"
    :close="close"
    @close="emit('close')"
  >
    <p class="text-content-primary text-p3 mb-20">
      {{ description }}
    </p>

    <div class="pb-16 mb-16 border-b border-line-default">
      <div class="flex items-center justify-between gap-16">
        <p class="text-content-primary font-medium">
          {{ details.metric === 'roe' ? 'ROE' : details.metric === 'supply-apy' ? 'Supply APY' : 'Net APY' }}
        </p>
        <p class="text-h5 whitespace-nowrap">
          <template v-if="showTransition(details.before?.total, details.after.total)">
            <span class="text-content-tertiary">{{ displayPercent(details.before?.total) }}</span>
            &rarr; {{ displayPercent(details.after.total) }}
          </template>
          <template v-else>
            {{ displayPercent(details.after.total) }}
          </template>
        </p>
      </div>
    </div>

    <div
      v-if="details.rateLines.length"
      class="pb-16 mb-16 border-b border-line-default"
    >
      <p class="text-content-primary font-medium mb-12">
        Projected market rates
      </p>
      <div
        v-for="rate in details.rateLines"
        :key="rate.id"
        class="flex items-center justify-between gap-16 mt-8"
      >
        <p>
          {{ rate.label }}<span v-if="rate.symbol"> · {{ rate.symbol }}</span><span v-if="showRateVaultAddress(rate)">
            · {{ shortAddress(rate.vaultAddress) }}
          </span>
        </p>
        <p class="text-p2 whitespace-nowrap">
          <template v-if="showTransition(rate.before, rate.after)">
            <span class="text-content-tertiary">{{ displayPercent(rate.before) }}</span>
            &rarr; {{ displayPercent(rate.after) }}
          </template>
          <template v-else>
            {{ displayPercent(rate.after ?? rate.before) }}
          </template>
        </p>
      </div>
    </div>

    <div class="pb-16 mb-16 border-b border-line-default">
      <p class="text-content-primary font-medium mb-12">
        Contribution breakdown
      </p>
      <div
        v-for="row in breakdownRows"
        :key="row.key"
        class="flex items-center justify-between gap-16 mt-8"
      >
        <p class="inline-flex items-center gap-4">
          <SvgIcon
            v-if="row.key === 'rewards' && (Math.abs(details.before?.breakdown.rewards ?? 0) > 0 || Math.abs(details.after.breakdown.rewards) > 0)"
            class="!w-16 !h-16 text-accent-500"
            name="sparks"
          />
          {{ row.label }}
        </p>
        <p class="text-p2 whitespace-nowrap">
          <template v-if="showTransition(details.before?.breakdown[row.key], details.after.breakdown[row.key])">
            <span class="text-content-tertiary">{{ displayPercent(details.before?.breakdown[row.key]) }}</span>
            &rarr; {{ displayPercent(details.after.breakdown[row.key]) }}
          </template>
          <template v-else>
            {{ displayPercent(details.after.breakdown[row.key]) }}
          </template>
        </p>
      </div>
    </div>

    <div v-if="details.rewards.length">
      <p class="text-content-primary font-medium mb-12 inline-flex items-center gap-4">
        <SvgIcon
          class="!w-16 !h-16 text-accent-500"
          name="sparks"
        />
        Reward campaign APR
      </p>
      <div
        v-for="reward in details.rewards"
        :key="reward.id"
        class="flex items-center justify-between gap-16 mt-12"
      >
        <div class="flex items-center min-w-0">
          <img
            v-if="reward.rewardToken.icon"
            :src="reward.rewardToken.icon"
            class="w-20 h-20 rounded-full shrink-0"
            alt="Reward token logo"
          >
          <div :class="reward.rewardToken.icon ? 'ml-8' : ''">
            <p class="text-content-primary">
              {{ reward.rewardToken.symbol }}
            </p>
            <p class="text-p3 text-content-tertiary">
              {{ actionLabels[reward.action] || reward.action }} ·
              <a
                v-if="reward.sourceUrl"
                :href="reward.sourceUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="underline"
                @click.stop
              ><img
                v-if="PROVIDER_LOGOS[reward.source]"
                :src="PROVIDER_LOGOS[reward.source]"
                class="w-12 h-12 inline-block align-middle mr-2 bg-white rounded-sm p-1"
                :alt="PROVIDER_LABELS[reward.source]"
              >{{ PROVIDER_LABELS[reward.source] || reward.source }}</a><template v-else>
                {{ PROVIDER_LABELS[reward.source] || reward.source }}
              </template><template v-if="reward.vaultAddress">
                · {{ reward.action === 'LEND' ? 'Supply vault' : 'Debt vault' }} {{ shortAddress(reward.vaultAddress) }}
              </template><template v-if="reward.collateralAddress">
                · Collateral {{ shortAddress(reward.collateralAddress) }}
              </template>
            </p>
          </div>
        </div>
        <p class="text-p2 whitespace-nowrap">
          <template v-if="showTransition(reward.beforeApr, reward.afterApr) || reward.beforeApr == null || reward.afterApr == null">
            <span class="text-content-tertiary">{{ displayPercent(reward.beforeApr) }}</span>
            &rarr; {{ displayPercent(reward.afterApr) }}
          </template>
          <template v-else>
            {{ displayPercent(reward.afterApr) }}
          </template>
        </p>
      </div>
      <p class="text-p3 text-content-tertiary mt-12">
        Campaign APR is shown per eligible vault and reward token. The Rewards contribution above is weighted for this position.
      </p>
    </div>
  </BaseModalWrapper>
</template>
