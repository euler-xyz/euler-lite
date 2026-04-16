<script setup lang="ts">
import { decodeAbiParameters, formatUnits, zeroAddress, type Hex } from 'viem'
import { INTEREST_RATE_MODEL_TYPE, FIXED_CYCLICAL_BINARY_IRM_COMPONENTS, SECONDS_IN_YEAR } from '~/entities/constants'
import type { Vault, SecuritizeVault, CyclicalNoteInfo } from '~/entities/vault'
import { hasCollateralExposure } from '~/entities/vault'
import { useVaultRegistry } from '~/composables/useVaultRegistry'

const { vault } = defineProps<{ vault: Vault }>()

const { get: registryGet } = useVaultRegistry()

const isCyclicalIRM = computed(() => {
  return Number(vault.irmInfo?.interestRateModelInfo?.interestRateModelType)
    === INTEREST_RATE_MODEL_TYPE.FIXED_CYCLICAL_BINARY
})

const hasValidIRM = computed(() => {
  const hasExposure = hasCollateralExposure(
    vault,
    addr => registryGet(addr)?.vault as Vault | SecuritizeVault | undefined,
  )
  return hasExposure
    && isCyclicalIRM.value
    && vault.interestRateModelAddress
    && vault.interestRateModelAddress !== zeroAddress
})

const cyclicalInfo = computed((): CyclicalNoteInfo | null => {
  const params = vault.irmInfo?.interestRateModelInfo?.interestRateModelParams
  if (!params) return null
  try {
    const [decoded] = decodeAbiParameters(
      [{ type: 'tuple', components: FIXED_CYCLICAL_BINARY_IRM_COMPONENTS }],
      params as Hex,
    )
    return decoded as unknown as CyclicalNoteInfo
  }
  catch {
    return null
  }
})

const now = useNow({ interval: 60_000 })

const cycleLength = computed(() => {
  if (!cyclicalInfo.value) return 0n
  return cyclicalInfo.value.primaryDuration + cyclicalInfo.value.secondaryDuration
})

const currentCycleStart = computed(() => {
  const info = cyclicalInfo.value
  if (!info || cycleLength.value === 0n) return 0n
  const nowSec = BigInt(Math.floor(now.value.getTime() / 1000))
  const elapsed = nowSec - info.startTimestamp
  const cycleIndex = elapsed / cycleLength.value
  return info.startTimestamp + cycleIndex * cycleLength.value
})

const fixedRateStart = computed(() => currentCycleStart.value)
const fixedRateEnd = computed(() => {
  if (!cyclicalInfo.value) return 0n
  return currentCycleStart.value + cyclicalInfo.value.primaryDuration
})
const repaymentWindowStart = computed(() => fixedRateEnd.value)
const repaymentWindowEnd = computed(() => currentCycleStart.value + cycleLength.value)

const elapsedInCycle = computed(() => {
  const nowSec = BigInt(Math.floor(now.value.getTime() / 1000))
  const elapsed = nowSec - currentCycleStart.value
  return elapsed < 0n ? 0n : elapsed
})

const isInFixedRate = computed(() => {
  if (!cyclicalInfo.value) return true
  return elapsedInCycle.value < cyclicalInfo.value.primaryDuration
})

const cycleLengthDays = computed(() => {
  if (cycleLength.value === 0n) return 0
  return Number(cycleLength.value) / 86400
})

const primaryDurationDays = computed(() => {
  if (!cyclicalInfo.value) return 0
  return Number(cyclicalInfo.value.primaryDuration) / 86400
})

const secondaryDurationDays = computed(() => {
  if (!cyclicalInfo.value) return 0
  return Number(cyclicalInfo.value.secondaryDuration) / 86400
})

const percentComplete = computed(() => {
  if (cycleLength.value === 0n) return 0
  return (Number(elapsedInCycle.value) / Number(cycleLength.value)) * 100
})

const dayInCycle = computed(() => {
  return Number(elapsedInCycle.value) / 86400
})

const fixedRatePercent = computed(() => {
  if (cycleLength.value === 0n) return 0
  return (Number(cyclicalInfo.value!.primaryDuration) / Number(cycleLength.value)) * 100
})

const clampedPercent = computed(() => Math.min(Math.max(percentComplete.value, 0), 100))

const fixedFillPercent = computed(() => {
  return Math.min(clampedPercent.value, fixedRatePercent.value)
})

const repaymentFillPercent = computed(() => {
  if (isInFixedRate.value) return 0
  return clampedPercent.value - fixedRatePercent.value
})

// SPY (27 decimal, per-second) to APY percentage
const spyToApy = (spy: bigint): number => {
  const spyNumber = Number(formatUnits(spy, 27))
  return (Math.pow(1 + spyNumber, SECONDS_IN_YEAR) - 1) * 100
}

const fixedBorrowAPY = computed(() => {
  if (!cyclicalInfo.value) return 0
  return spyToApy(cyclicalInfo.value.primaryRate)
})

const repaymentBorrowAPY = computed(() => {
  if (!cyclicalInfo.value) return 0
  return spyToApy(cyclicalInfo.value.secondaryRate)
})

const formatCyclicalDate = (timestamp: bigint): string => {
  const date = new Date(Number(timestamp) * 1000)
  const day = date.getDate()
  const suffix = getDaySuffix(day)
  const month = date.toLocaleString('en-US', { month: 'short' })
  const year = date.getFullYear()
  const hour = date.getHours()
  const ampm = hour >= 12 ? 'pm' : 'am'
  const hour12 = hour % 12 || 12
  const min = date.getMinutes()
  const timeStr = min === 0 ? `${hour12}${ampm}` : `${hour12}:${String(min).padStart(2, '0')}${ampm}`
  return `${month} ${day}${suffix}, ${year} ${timeStr}`
}

const getDaySuffix = (day: number): string => {
  if (day >= 11 && day <= 13) return 'th'
  switch (day % 10) {
    case 1: return 'st'
    case 2: return 'nd'
    case 3: return 'rd'
    default: return 'th'
  }
}

// Omit year from end date when it matches the start date
const formatCyclicalDateShort = (startTimestamp: bigint, endTimestamp: bigint): string => {
  const startYear = new Date(Number(startTimestamp) * 1000).getFullYear()
  const endDate = new Date(Number(endTimestamp) * 1000)
  const day = endDate.getDate()
  const suffix = getDaySuffix(day)
  const month = endDate.toLocaleString('en-US', { month: 'short' })
  const hour = endDate.getHours()
  const ampm = hour >= 12 ? 'pm' : 'am'
  const hour12 = hour % 12 || 12
  const min = endDate.getMinutes()
  const timeStr = min === 0 ? `${hour12}${ampm}` : `${hour12}:${String(min).padStart(2, '0')}${ampm}`
  if (endDate.getFullYear() === startYear) {
    return `${month} ${day}${suffix} ${timeStr}`
  }
  return `${month} ${day}${suffix}, ${endDate.getFullYear()} ${timeStr}`
}

const formatAPY = (apy: number): string => {
  return apy.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const formatDuration = (days: number): string => {
  if (days >= 1) {
    const rounded = Math.round(days)
    return `${rounded} day${rounded !== 1 ? 's' : ''}`
  }
  const hours = Math.round(days * 24)
  return `${hours} hour${hours !== 1 ? 's' : ''}`
}

// Progress bar tick marks at 0%, 33%, 66%, 100%
const progressTicks = computed(() => {
  const totalDays = cycleLengthDays.value
  return [
    { label: `Day 0`, pct: '0%', position: '0%' },
    { label: `Day ${Math.round(totalDays / 3)}`, pct: '33%', position: '33.33%' },
    { label: `Day ${Math.round((totalDays * 2) / 3)}`, pct: '66%', position: '66.66%' },
    { label: `Day ${Math.round(totalDays)}`, pct: '100%', position: '100%' },
  ]
})

const phaseLabel = computed(() => {
  return isInFixedRate.value ? 'Fixed rate period' : 'Repayment window'
})
</script>

<template>
  <div
    v-if="hasValidIRM && cyclicalInfo"
    class="bg-surface-secondary rounded-xl flex flex-col gap-16 p-24 shadow-card"
  >
    <!-- Header -->
    <div class="flex items-center gap-8">
      <p class="text-h3 text-content-primary">
        Interest rate model
      </p>
      <div class="cyclical-chip inline-flex items-center py-4 px-8 rounded-8 text-[13px] font-medium">
        Cyclical note
      </div>
    </div>

    <!-- Current cycle -->
    <div class="flex flex-col gap-12">
      <p class="text-p3 text-content-tertiary font-medium uppercase tracking-wide text-[11px]">
        Current cycle
      </p>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-16">
        <VaultOverviewLabelValue label="Fixed rate start">
          <span class="text-p3 text-content-primary">
            {{ formatCyclicalDate(fixedRateStart) }}
          </span>
        </VaultOverviewLabelValue>
        <VaultOverviewLabelValue label="Fixed rate end">
          <span class="text-p3 text-content-primary">
            {{ formatCyclicalDate(fixedRateEnd) }}
          </span>
        </VaultOverviewLabelValue>
        <VaultOverviewLabelValue label="Repayment window">
          <span class="text-p3 text-content-primary">
            {{ formatCyclicalDate(repaymentWindowStart) }}<br>– {{ formatCyclicalDateShort(repaymentWindowStart, repaymentWindowEnd) }}
          </span>
        </VaultOverviewLabelValue>
      </div>
    </div>

    <!-- Parameters -->
    <div class="flex flex-col gap-12">
      <p class="text-p3 text-content-tertiary font-medium uppercase tracking-wide text-[11px]">
        Parameters
      </p>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-16">
        <VaultOverviewLabelValue label="Cycle length">
          <span class="text-p3 text-content-primary">
            {{ formatDuration(primaryDurationDays) }} / {{ formatDuration(secondaryDurationDays) }}
          </span>
        </VaultOverviewLabelValue>
        <VaultOverviewLabelValue label="Fixed APY">
          <span class="text-p3 text-content-primary">
            {{ formatAPY(fixedBorrowAPY) }}%
          </span>
        </VaultOverviewLabelValue>
        <VaultOverviewLabelValue label="Repayment APY">
          <span class="text-p3 text-content-primary">
            {{ formatAPY(repaymentBorrowAPY) }}%
          </span>
        </VaultOverviewLabelValue>
      </div>
    </div>

    <!-- Progress -->
    <div class="flex flex-col gap-12 mt-12">
      <p class="text-p3 text-content-tertiary font-medium uppercase tracking-wide text-[11px]">
        Progress
      </p>
      <!-- Legend -->
      <div class="flex items-center gap-16 text-[12px] text-content-secondary">
        <span class="flex items-center gap-4">
          <span class="inline-block w-8 h-8 rounded-full bg-accent-500" />
          Fixed rate period
        </span>
        <span class="flex items-center gap-4">
          <span class="inline-block w-8 h-8 rounded-full cyclical-repayment-dot" />
          Repayment window
        </span>
      </div>

      <!-- Tick labels -->
      <div class="relative h-16 text-[11px] text-content-tertiary whitespace-nowrap">
        <span
          v-for="tick in progressTicks"
          :key="tick.pct"
          class="absolute -translate-x-1/2 select-none"
          :class="{ '!translate-x-0': tick.position === '0%', '!-translate-x-full': tick.position === '100%' }"
          :style="{ left: tick.position }"
        >
          {{ tick.label }} ({{ tick.pct }})
        </span>
      </div>

      <!-- Bar -->
      <div class="cyclical-progress">
        <div class="cyclical-progress__track">
          <div
            class="cyclical-progress__fixed"
            :style="{ width: `${fixedFillPercent}%` }"
          />
          <div
            v-if="!isInFixedRate"
            class="cyclical-progress__repayment"
            :style="{ left: `${fixedRatePercent}%`, width: `${repaymentFillPercent}%` }"
          />
          <div
            class="cyclical-progress__divider"
            :style="{ left: `${fixedRatePercent}%` }"
          />
        </div>
        <div
          class="cyclical-progress__cursor"
          :style="{ left: `${clampedPercent}%` }"
        />
      </div>

      <!-- Status text -->
      <div class="flex justify-between text-[12px]">
        <span class="text-content-secondary">
          <span :class="isInFixedRate ? 'text-accent-700' : 'cyclical-repayment-text'">{{ phaseLabel }}</span>
          day {{ Math.floor(dayInCycle) }} of {{ Math.round(cycleLengthDays) }}
        </span>
        <span class="text-content-tertiary">
          {{ formatAPY(percentComplete) }}% complete
        </span>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.cyclical-chip {
  background-color: rgba(var(--accent-rgb), 0.15);
  color: var(--accent-600);

  [data-theme="dark"] & {
    background-color: rgba(var(--accent-rgb), 0.2);
    color: var(--accent-500);
  }
}

.cyclical-repayment-dot {
  background-color: var(--warning-500);
}

.cyclical-repayment-text {
  color: var(--warning-500);
}

.cyclical-progress {
  position: relative;
  height: 10px;

  &__track {
    position: relative;
    height: 100%;
    border-radius: 100px;
    background-color: var(--ui-progress-background-color);
    overflow: hidden;
  }

  &__fixed {
    height: 100%;
    background-color: var(--accent-500);
  }

  &__repayment {
    position: absolute;
    top: 0;
    height: 100%;
    background-color: var(--warning-500);
  }

  &__divider {
    position: absolute;
    top: 0;
    width: 2px;
    height: 100%;
    background-color: var(--text-primary);
    opacity: 0.3;
    transform: translateX(-50%);
  }

  &__cursor {
    position: absolute;
    top: -2px;
    width: 3px;
    height: 14px;
    background-color: var(--text-primary);
    border-radius: 2px;
    transform: translateX(-50%);
  }
}
</style>
