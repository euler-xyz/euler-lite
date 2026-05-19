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

const progressPercentLabel = computed(() => `${Math.round(cyclePositionPercent.value)}%`)
const repaymentEndCapPercent = computed(() => 100 - fixedRatePercent.value)

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

const progressDayLabel = computed(() => {
  const duration = currentPhaseDurationSec.value
  if (duration <= 0n) return 'D0 / 0'
  const elapsed = elapsedInPhase.value > duration ? duration : elapsedInPhase.value
  const elapsedDays = Math.floor(Number(elapsed) / Number(DURATION_UNITS[0].seconds))
  const totalDays = Math.max(1, ceilToUnit(duration, DURATION_UNITS[0]))

  return `D${elapsedDays} / ${totalDays}`
})
</script>

<template>
  <section
    v-if="hasValidIRM && currentCycle"
    class="bg-surface-secondary rounded-xl flex flex-col gap-24 p-24 shadow-card"
  >
    <header class="flex items-center justify-between gap-16">
      <h2 class="text-h3 text-content-primary">
        Interest rate model
      </h2>
      <CyclicalNoteBadge />
    </header>

    <div
      v-if="currentCycle.preStartTimestamp !== null"
      class="text-p3 text-content-secondary"
    >
      First cycle starts {{ formatCyclicalDate(currentCycle.preStartTimestamp) }}
    </div>

    <div
      v-if="hasStarted"
      class="cyclical-irm-grid"
    >
      <div>
        <p class="mb-10 text-p2 text-content-tertiary">
          Fixed period
        </p>
        <dl class="flex flex-col">
          <div class="cyclical-irm-row">
            <dt>Start</dt>
            <dd>{{ formatCyclicalDate(fixedRateStart) }}</dd>
          </div>
          <div class="cyclical-irm-row">
            <dt>End</dt>
            <dd>{{ formatCyclicalDate(fixedRateEnd) }}</dd>
          </div>
          <div class="cyclical-irm-row">
            <dt>Length</dt>
            <dd>{{ formatDuration(currentCycle.primaryDurationSec) }}</dd>
          </div>
          <div class="cyclical-irm-row">
            <dt>APY</dt>
            <dd class="!font-semibold !text-accent-500">
              {{ formatPercent(fixedBorrowAPY) }}%
            </dd>
          </div>
        </dl>
      </div>

      <div
        class="cyclical-irm-divider"
        aria-hidden="true"
      />

      <div>
        <p class="mb-10 text-p2 text-content-tertiary">
          Repayment window
        </p>
        <dl class="flex flex-col">
          <div class="cyclical-irm-row">
            <dt>Start</dt>
            <dd>{{ formatCyclicalDate(repaymentWindowStart) }}</dd>
          </div>
          <div class="cyclical-irm-row">
            <dt>End</dt>
            <dd>{{ formatCyclicalDate(repaymentWindowEnd) }}</dd>
          </div>
          <div class="cyclical-irm-row">
            <dt>Length</dt>
            <dd>{{ formatDuration(currentCycle.secondaryDurationSec) }}</dd>
          </div>
          <div class="cyclical-irm-row">
            <dt>APY</dt>
            <dd class="!font-semibold !text-warning-500">
              {{ formatPercent(repaymentBorrowAPY) }}%
            </dd>
          </div>
        </dl>
      </div>
    </div>

    <footer
      v-if="hasStarted"
      class="flex items-center gap-12"
    >
      <span class="min-w-[60px] text-p5 text-content-secondary tabular-nums">{{ progressDayLabel }}</span>
      <div class="cyclical-irm-progress">
        <div
          class="cyclical-irm-progress__fill"
          :style="{ width: `${cyclePositionPercent}%` }"
        />
        <div
          class="cyclical-irm-progress__repay"
          :style="{ width: `${repaymentEndCapPercent}%` }"
        />
      </div>
      <span class="min-w-36 text-right text-p5 text-content-tertiary tabular-nums">{{ progressPercentLabel }}</span>
    </footer>
  </section>
</template>

<style lang="scss" scoped>
.cyclical-irm-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 1px minmax(0, 1fr);
  gap: 24px;
}

.cyclical-irm-divider {
  width: 1px;
  background: var(--border-subtle);
}

.cyclical-irm-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  padding: 9px 0;
  border-bottom: 1px dashed var(--border-subtle);

  &:last-child {
    border-bottom: 0;
  }

  dt,
  dd {
    margin: 0;
  }

  dt {
    flex: 0 0 auto;
    color: var(--text-tertiary);
    font-size: 14px;
    line-height: 20px;
  }

  dd {
    min-width: 0;
    color: var(--text-primary);
    font-size: 14px;
    line-height: 20px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
}

.cyclical-irm-progress {
  position: relative;
  flex: 1;
  height: 4px;
  overflow: hidden;
  border-radius: 2px;
  background: var(--ui-progress-background-color);
}

.cyclical-irm-progress__fill {
  position: absolute;
  inset: 0 auto 0 0;
  max-width: 100%;
  background: var(--accent-500);
}

.cyclical-irm-progress__repay {
  position: absolute;
  inset: 0 0 0 auto;
  background: var(--warning-500);
}

@media (max-width: 640px) {
  .cyclical-irm-grid {
    grid-template-columns: 1fr;
    gap: 18px;
  }

  .cyclical-irm-divider {
    width: 100%;
    height: 1px;
  }
}
</style>
