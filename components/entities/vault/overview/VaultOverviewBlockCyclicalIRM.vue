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

const getUTCMonthDayCount = (year: number, month: number): number => {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

const getMonthlyCycleBoundaryMs = (year: number, month: number, startDay: number): number => {
  const effectiveStartDay = Math.min(startDay, getUTCMonthDayCount(year, month))
  return Date.UTC(year, month, effectiveStartDay)
}

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
    const startDay = Number(m.cycleStartDay)
    const currentMonthBoundaryMs = getMonthlyCycleBoundaryMs(y, mo, startDay)
    const isAfterCurrentMonthBoundary = d.getTime() >= currentMonthBoundaryMs
    const cycleStartMs = isAfterCurrentMonthBoundary
      ? currentMonthBoundaryMs
      : getMonthlyCycleBoundaryMs(y, mo - 1, startDay)
    const cycleEndMs = isAfterCurrentMonthBoundary
      ? getMonthlyCycleBoundaryMs(y, mo + 1, startDay)
      : currentMonthBoundaryMs
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

const repaymentEndCapPercent = computed(() => 100 - fixedRatePercent.value)
const nowTimestamp = computed(() => BigInt(Math.floor(now.value.getTime() / 1000)))
const timelineMarkerStyle = computed(() => ({
  left: `clamp(1px, ${cyclePositionPercent.value}%, calc(100% - 1px))`,
}))
const timelineNowStyle = computed(() => ({
  left: `${cyclePositionPercent.value}%`,
}))
const timelineNowAlignment = computed(() => {
  if (cyclePositionPercent.value < 20) return 'start'
  if (cyclePositionPercent.value > 80) return 'end'
  return 'center'
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

const shouldFormatCycleDatesInUTC = computed(() => isMonthly.value)

const formatCyclicalDate = (timestamp: bigint): string => {
  const date = new Date(Number(timestamp) * 1000)
  const useUTC = shouldFormatCycleDatesInUTC.value
  const day = useUTC ? date.getUTCDate() : date.getDate()
  const suffix = getDaySuffix(day)
  const month = date.toLocaleString('en-US', { month: 'short', timeZone: useUTC ? 'UTC' : undefined })
  const year = useUTC ? date.getUTCFullYear() : date.getFullYear()
  const hour = useUTC ? date.getUTCHours() : date.getHours()
  const ampm = hour >= 12 ? 'pm' : 'am'
  const hour12 = hour % 12 || 12
  const min = useUTC ? date.getUTCMinutes() : date.getMinutes()
  const timeStr = min === 0 ? `${hour12}${ampm}` : `${hour12}:${String(min).padStart(2, '0')}${ampm}`
  return `${month} ${day}${suffix}, ${year} ${timeStr}`
}

const formatTimelineDate = (timestamp: bigint): string => {
  const date = new Date(Number(timestamp) * 1000)
  const useUTC = shouldFormatCycleDatesInUTC.value
  const month = date.toLocaleString('en-US', { month: 'short', timeZone: useUTC ? 'UTC' : undefined })
  const day = useUTC ? date.getUTCDate() : date.getDate()
  const year = useUTC ? date.getUTCFullYear() : date.getFullYear()
  const hours = String(useUTC ? date.getUTCHours() : date.getHours()).padStart(2, '0')
  const minutes = String(useUTC ? date.getUTCMinutes() : date.getMinutes()).padStart(2, '0')
  return `${month} ${day}, ${year} ${hours}:${minutes}`
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

const formatDuration = (seconds: bigint): string => {
  if (seconds <= 0n) return '0 seconds'
  const unit = selectDurationUnit(seconds)
  return pluralize(Math.max(1, roundToUnit(seconds, unit)), unit.label)
}
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
            <dt>Borrow APY</dt>
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
            <dt>Borrow APY</dt>
            <dd class="!font-semibold !text-warning-500">
              {{ formatPercent(repaymentBorrowAPY) }}%
            </dd>
          </div>
        </dl>
      </div>
    </div>

    <footer
      v-if="hasStarted"
      class="cyclical-irm-timeline"
    >
      <div class="cyclical-irm-progress">
        <div
          class="cyclical-irm-progress__fill"
          :style="{ width: `${cyclePositionPercent}%` }"
        />
        <div
          class="cyclical-irm-progress__repay"
          :style="{ width: `${repaymentEndCapPercent}%` }"
        />
        <div
          class="cyclical-irm-progress__marker"
          :style="timelineMarkerStyle"
        />
      </div>
      <div class="cyclical-irm-timeline__now-row">
        <span
          class="cyclical-irm-timeline__now"
          :class="`cyclical-irm-timeline__now--${timelineNowAlignment}`"
          :style="timelineNowStyle"
        >
          Now: {{ formatTimelineDate(nowTimestamp) }}
        </span>
      </div>
      <div class="cyclical-irm-timeline__bounds">
        <span class="cyclical-irm-timeline__bound">
          {{ formatTimelineDate(fixedRateStart) }}
        </span>
        <span class="cyclical-irm-timeline__bound cyclical-irm-timeline__bound--end">
          {{ formatTimelineDate(repaymentWindowEnd) }}
        </span>
      </div>
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

.cyclical-irm-timeline {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 4px;
}

.cyclical-irm-progress {
  position: relative;
  height: 4px;
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

.cyclical-irm-progress__marker {
  position: absolute;
  top: -5px;
  width: 2px;
  height: 14px;
  border-radius: 2px;
  background: var(--text-primary);
  transform: translateX(-50%);
}

.cyclical-irm-timeline__now-row {
  position: relative;
  min-height: 16px;
  font-size: 12px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
}

.cyclical-irm-timeline__now {
  position: absolute;
  top: 0;
  max-width: 100%;
  overflow: hidden;
  color: var(--text-secondary);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cyclical-irm-timeline__now--start {
  transform: translateX(0);
}

.cyclical-irm-timeline__now--center {
  transform: translateX(-50%);
}

.cyclical-irm-timeline__now--end {
  transform: translateX(-100%);
}

.cyclical-irm-timeline__bounds {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin-top: -3px;
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
}

.cyclical-irm-timeline__bound {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cyclical-irm-timeline__bound--end {
  text-align: right;
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

  .cyclical-irm-timeline__bounds {
    flex-direction: column;
    gap: 2px;
  }
}
</style>
