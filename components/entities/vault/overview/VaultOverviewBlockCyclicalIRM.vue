<script setup lang="ts">
import { decodeAbiParameters, formatUnits, zeroAddress, type Hex } from 'viem'
import {
  FIXED_CYCLICAL_BINARY_IRM_COMPONENTS,
  FIXED_CYCLICAL_BINARY_MONTHLY_IRM_COMPONENTS,
  INTEREST_RATE_MODEL_TYPE,
  SECONDS_IN_YEAR,
} from '~/entities/constants'
import type { Vault, SecuritizeVault, CyclicalNoteInfo, CyclicalNoteMonthlyInfo } from '~/entities/vault'
import { hasCollateralExposure } from '~/entities/vault'
import { useVaultRegistry } from '~/composables/useVaultRegistry'

const { vault } = defineProps<{ vault: Vault }>()

const { get: registryGet } = useVaultRegistry()

// Parent already gates rendering to cyclical IRM vaults via v-if,
// so this component only checks collateral exposure and IRM address.
const hasValidIRM = computed(() => {
  const hasExposure = hasCollateralExposure(
    vault,
    addr => registryGet(addr)?.vault as Vault | SecuritizeVault | undefined,
  )
  return hasExposure
    && vault.interestRateModelAddress
    && vault.interestRateModelAddress !== zeroAddress
})

const irmType = computed(() => vault.irmInfo?.interestRateModelInfo?.interestRateModelType)
const isMonthly = computed(() =>
  irmType.value === INTEREST_RATE_MODEL_TYPE.FIXED_CYCLICAL_BINARY_MONTHLY,
)

const cyclicalInfo = computed((): CyclicalNoteInfo | null => {
  if (isMonthly.value) return null
  const params = vault.irmInfo?.interestRateModelInfo?.interestRateModelParams
  if (!params) return null
  try {
    const [decoded] = decodeAbiParameters(
      [{ type: 'tuple', components: FIXED_CYCLICAL_BINARY_IRM_COMPONENTS }],
      params as Hex,
    )
    return decoded as CyclicalNoteInfo
  }
  catch {
    return null
  }
})

const monthlyInfo = computed((): CyclicalNoteMonthlyInfo | null => {
  if (!isMonthly.value) return null
  const params = vault.irmInfo?.interestRateModelInfo?.interestRateModelParams
  if (!params) return null
  try {
    const [decoded] = decodeAbiParameters(
      [{ type: 'tuple', components: FIXED_CYCLICAL_BINARY_MONTHLY_IRM_COMPONENTS }],
      params as Hex,
    )
    return decoded as CyclicalNoteMonthlyInfo
  }
  catch {
    return null
  }
})

const now = useNow({ interval: 1_000 })

type CurrentCycle = {
  primaryRate: bigint
  secondaryRate: bigint
  startSec: bigint
  primaryDurationSec: bigint
  secondaryDurationSec: bigint
  hasStarted: boolean
  preStartTimestamp: bigint | null
}

const MIN_MONTHLY_CYCLE_START_DAY = 1n
const MAX_MONTHLY_CYCLE_START_DAY = 31n

// Both cyclical IRM variants are normalised into the same shape so the
// progress/phase/tick logic below is variant-agnostic. The Monthly variant
// derives the current cycle from calendar dates (UTC), matching the contract.
const currentCycle = computed((): CurrentCycle | null => {
  if (isMonthly.value) {
    const m = monthlyInfo.value
    if (!m) return null
    if (
      m.cycleStartDay < MIN_MONTHLY_CYCLE_START_DAY
      || m.cycleStartDay > MAX_MONTHLY_CYCLE_START_DAY
    ) {
      return null
    }
    const d = new Date(now.value.getTime())
    const y = d.getUTCFullYear()
    const mo = d.getUTCMonth()
    const day = d.getUTCDate()
    const startDay = Number(m.cycleStartDay)
    const cycleStartMs = day >= startDay
      ? Date.UTC(y, mo, startDay)
      : Date.UTC(y, mo - 1, startDay)
    const cycleEndMs = day >= startDay
      ? Date.UTC(y, mo + 1, startDay)
      : Date.UTC(y, mo, startDay)
    if (!Number.isFinite(cycleStartMs) || !Number.isFinite(cycleEndMs)) return null
    const startSec = BigInt(Math.floor(cycleStartMs / 1000))
    const endSec = BigInt(Math.floor(cycleEndMs / 1000))
    const secondaryDurationSec = m.secondaryDays * 86_400n
    const cycleLengthSec = endSec - startSec
    const primaryDurationSec = cycleLengthSec > secondaryDurationSec
      ? cycleLengthSec - secondaryDurationSec
      : 0n
    return {
      primaryRate: m.primaryRate,
      secondaryRate: m.secondaryRate,
      startSec,
      primaryDurationSec,
      secondaryDurationSec,
      hasStarted: true,
      preStartTimestamp: null,
    }
  }
  const info = cyclicalInfo.value
  if (!info) return null
  const cycleLen = info.primaryDuration + info.secondaryDuration
  const nowSec = BigInt(Math.floor(now.value.getTime() / 1000))
  const hasStarted = nowSec >= info.startTimestamp
  const startSec = hasStarted && cycleLen > 0n
    ? info.startTimestamp + ((nowSec - info.startTimestamp) / cycleLen) * cycleLen
    : info.startTimestamp
  return {
    primaryRate: info.primaryRate,
    secondaryRate: info.secondaryRate,
    startSec,
    primaryDurationSec: info.primaryDuration,
    secondaryDurationSec: info.secondaryDuration,
    hasStarted,
    preStartTimestamp: hasStarted ? null : info.startTimestamp,
  }
})

const cycleLength = computed(() => {
  const c = currentCycle.value
  if (!c) return 0n
  return c.primaryDurationSec + c.secondaryDurationSec
})

const hasStarted = computed(() => currentCycle.value?.hasStarted ?? false)

const currentCycleStart = computed(() => {
  const c = currentCycle.value
  if (!c || !c.hasStarted) return 0n
  return c.startSec
})

const fixedRateStart = computed(() => currentCycleStart.value)
const fixedRateEnd = computed(() => {
  const c = currentCycle.value
  if (!c) return 0n
  return currentCycleStart.value + c.primaryDurationSec
})
const repaymentWindowStart = computed(() => fixedRateEnd.value)
const repaymentWindowEnd = computed(() => currentCycleStart.value + cycleLength.value)

const elapsedInCycle = computed(() => {
  const nowSec = BigInt(Math.floor(now.value.getTime() / 1000))
  const elapsed = nowSec - currentCycleStart.value
  return elapsed < 0n ? 0n : elapsed
})

const isInFixedRate = computed(() => {
  const c = currentCycle.value
  if (!c) return true
  return elapsedInCycle.value < c.primaryDurationSec
})

const currentPhaseDurationSec = computed(() => {
  const c = currentCycle.value
  if (!c) return 0n
  return isInFixedRate.value ? c.primaryDurationSec : c.secondaryDurationSec
})

const elapsedInPhase = computed(() => {
  const c = currentCycle.value
  if (!c) return 0n
  if (isInFixedRate.value) return elapsedInCycle.value
  const elapsed = elapsedInCycle.value - c.primaryDurationSec
  return elapsed < 0n ? 0n : elapsed
})

// Bar represents the full cycle proportionally. The 100% tick sits at the
// phase boundary, so fixedRatePercent is the position (in % of bar width)
// of both the boundary and the end-of-fixed-rate tick.
const fixedRatePercent = computed(() => {
  const c = currentCycle.value
  if (!c || cycleLength.value === 0n) return 0
  return (Number(c.primaryDurationSec) / Number(cycleLength.value)) * 100
})

const cyclePositionPercent = computed(() => {
  if (cycleLength.value === 0n) return 0
  const pct = (Number(elapsedInCycle.value) / Number(cycleLength.value)) * 100
  return Math.min(Math.max(pct, 0), 100)
})

const fixedFillPercent = computed(() =>
  Math.min(cyclePositionPercent.value, fixedRatePercent.value),
)

const repaymentFillPercent = computed(() => {
  if (isInFixedRate.value) return 0
  return cyclePositionPercent.value - fixedRatePercent.value
})

// SPY (27 decimal, per-second) to APY percentage
const spyToApy = (spy: bigint): number => {
  const spyNumber = Number(formatUnits(spy, 27))
  return (Math.pow(1 + spyNumber, SECONDS_IN_YEAR) - 1) * 100
}

const fixedBorrowAPY = computed(() => {
  const c = currentCycle.value
  if (!c) return 0
  return spyToApy(c.primaryRate)
})

const repaymentBorrowAPY = computed(() => {
  const c = currentCycle.value
  if (!c) return 0
  return spyToApy(c.secondaryRate)
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

const formatPercent = (value: number): string => {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

type DurationUnit = {
  label: string
  seconds: bigint
}

const DURATION_UNITS: DurationUnit[] = [
  { label: 'day', seconds: 86_400n },
  { label: 'hour', seconds: 3_600n },
  { label: 'minute', seconds: 60n },
  { label: 'second', seconds: 1n },
]

const pluralize = (value: number, unit: string): string => {
  return `${value} ${unit}${value !== 1 ? 's' : ''}`
}

const selectDurationUnit = (seconds: bigint, minimumWholeUnits = 1n): DurationUnit => {
  return DURATION_UNITS.find(unit => seconds >= unit.seconds * minimumWholeUnits)
    ?? DURATION_UNITS[DURATION_UNITS.length - 1]
}

const roundToUnit = (seconds: bigint, unit: DurationUnit): number => {
  return Math.round(Number(seconds) / Number(unit.seconds))
}

const ceilToUnit = (seconds: bigint, unit: DurationUnit): number => {
  return Number((seconds + unit.seconds - 1n) / unit.seconds)
}

const formatDuration = (seconds: bigint): string => {
  if (seconds <= 0n) return '0 seconds'
  const unit = selectDurationUnit(seconds)
  return pluralize(Math.max(1, roundToUnit(seconds, unit)), unit.label)
}

const formatProgressTickLabel = (seconds: bigint, unit: DurationUnit): string => {
  const value = roundToUnit(seconds, unit)
  return `${unit.label[0].toUpperCase()}${unit.label.slice(1)} ${value}`
}

// Tick marks at 0%, 50%, 100% of the fixed rate period. The 100% mark sits
// at the phase boundary on the bar, and the repayment portion continues past.
const progressTicks = computed(() => {
  const totalDuration = currentCycle.value?.primaryDurationSec ?? 0n
  const fixedEnd = fixedRatePercent.value
  const unit = selectDurationUnit(totalDuration, 2n)
  return [
    { label: formatProgressTickLabel(0n, unit), pct: '0%', position: '0%' },
    { label: formatProgressTickLabel(totalDuration / 2n, unit), pct: '50%', position: `${fixedEnd / 2}%` },
    { label: formatProgressTickLabel(totalDuration, unit), pct: '100%', position: `${fixedEnd}%` },
  ]
})

const phaseLabel = computed(() => {
  return isInFixedRate.value ? 'Fixed rate period' : 'Repayment window'
})

const phaseProgressLabel = computed(() => {
  const duration = currentPhaseDurationSec.value
  if (duration <= 0n) return 'second 0 of 0'

  const unit = selectDurationUnit(duration, 2n)
  const elapsed = elapsedInPhase.value > duration ? duration : elapsedInPhase.value
  const elapsedUnits = Math.floor(Number(elapsed) / Number(unit.seconds))
  const totalUnits = Math.max(1, ceilToUnit(duration, unit))

  return `${unit.label} ${elapsedUnits} of ${totalUnits}`
})
</script>

<template>
  <div
    v-if="hasValidIRM && currentCycle"
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

    <!-- Pre-start notice -->
    <div
      v-if="currentCycle.preStartTimestamp !== null"
      class="text-p3 text-content-secondary"
    >
      First cycle starts {{ formatCyclicalDate(currentCycle.preStartTimestamp) }}
    </div>

    <!-- Current cycle -->
    <div
      v-if="hasStarted"
      class="flex flex-col gap-12"
    >
      <p class="text-p3 text-content-tertiary font-medium uppercase tracking-wide text-[11px]">
        Cycle
      </p>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-16">
        <VaultOverviewLabelValue label="Fixed rate cycle">
          <span class="text-p3 text-content-primary">
            {{ formatCyclicalDate(fixedRateStart) }}<br>{{ formatCyclicalDate(fixedRateEnd) }}
          </span>
        </VaultOverviewLabelValue>
        <VaultOverviewLabelValue label="Repayment window">
          <span class="text-p3 text-content-primary">
            {{ formatCyclicalDate(repaymentWindowStart) }}<br>{{ formatCyclicalDate(repaymentWindowEnd) }}
          </span>
        </VaultOverviewLabelValue>
        <VaultOverviewLabelValue label="Cycle length">
          <span class="text-p3 text-content-primary">
            {{ formatDuration(currentCycle.primaryDurationSec) }} / {{ formatDuration(currentCycle.secondaryDurationSec) }}
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
        <VaultOverviewLabelValue label="Fixed APY">
          <span class="text-p3 text-content-primary">
            {{ formatPercent(fixedBorrowAPY) }}%
          </span>
        </VaultOverviewLabelValue>
        <VaultOverviewLabelValue label="Repayment APY">
          <span class="text-p3 text-content-primary">
            {{ formatPercent(repaymentBorrowAPY) }}%
          </span>
        </VaultOverviewLabelValue>
      </div>
    </div>

    <!-- Progress -->
    <div
      v-if="hasStarted"
      class="flex flex-col gap-12 mt-12"
    >
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
          :class="{ '!translate-x-0': tick.pct === '0%' }"
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
          :style="{ left: `${cyclePositionPercent}%` }"
        />
      </div>

      <!-- Status text -->
      <div class="text-[12px] text-content-secondary">
        {{ phaseLabel }} {{ phaseProgressLabel }}
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
