<script setup lang="ts">
import {
  formatOracleCheckTitle,
  OracleAdapterCheckOutcome,
  OracleAdapterCheckSeverity,
  type OracleAdapterCheck,
} from '~/entities/oracle'
import { getRelativeTimeBetweenDates } from '~/utils/time-utils'

defineEmits(['close'])

const {
  modalTitle = 'Checks',
  checks,
  lastCheckedAt,
  note,
  inline = false,
  close = true,
} = defineProps<{
  modalTitle?: string
  checks: OracleAdapterCheck[]
  lastCheckedAt?: string
  note?: string
  inline?: boolean
  close?: boolean
}>()

// Data V3 re-evaluates every adapter hourly; a verdict older than this means
// the assessment runner is behind, so the reader should not lean on it.
const STALE_ASSESSMENT_MS = 3 * 60 * 60 * 1000
const ORACLE_SOURCE_REPOSITORY_URL = 'https://github.com/euler-xyz/euler-price-oracle'

const addressPattern = /\b0x[a-fA-F0-9]{40}\b/g

type CheckMessagePart = {
  text: string
  address?: string
}

type CheckLine = {
  key: string
  text: string
  muted: boolean
}

const getAddressCopyKey = (address: string) => `oracle-check-address-${address.toLowerCase()}`

const fallbackCopy = (text: string) => {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  document.body.removeChild(textarea)
  return copied
}

const writeAddressToClipboard = async (address: string) => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(address)
      return
    }
    catch {
      // Fall through to the textarea fallback used by older or restricted browsers.
    }
  }

  if (!fallbackCopy(address)) {
    throw new Error('Unable to copy address')
  }
}

const { isCopied, copyToClipboard } = useClipboardCopy({ write: writeAddressToClipboard })

const getCheckMessageParts = (message: string): CheckMessagePart[] => {
  const parts: CheckMessagePart[] = []
  let lastIndex = 0

  for (const match of message.matchAll(addressPattern)) {
    const address = match[0]
    const index = match.index ?? 0
    if (index > lastIndex) {
      parts.push({ text: message.slice(lastIndex, index) })
    }
    parts.push({ text: address, address })
    lastIndex = index + address.length
  }

  if (lastIndex < message.length) {
    parts.push({ text: message.slice(lastIndex) })
  }

  return parts.length ? parts : [{ text: message }]
}

const formatDetailValue = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)))
  }
  return undefined
}

// Renders a finding's `expected` / `observed` evidence when it is a primitive,
// a short list of primitives, or a small flat object (e.g. the implied vs
// reference price behind quote-price-consistency). Deeper shapes stay in the
// API payload only.
const formatCheckDetail = (value: unknown): string | undefined => {
  const primitive = formatDetailValue(value)
  if (primitive !== undefined) return primitive
  if (!value || typeof value !== 'object') return undefined

  if (Array.isArray(value)) {
    if (!value.length || value.length > 4) return undefined
    const items = value.map(formatDetailValue)
    return items.every((item): item is string => item !== undefined) ? items.join(', ') : undefined
  }

  const entries = Object.entries(value as Record<string, unknown>)
  if (!entries.length || entries.length > 4) return undefined
  const parts: string[] = []
  for (const [key, entry] of entries) {
    const text = formatDetailValue(entry)
    if (text === undefined) return undefined
    parts.push(`${key} ${text}`)
  }
  return parts.join(' · ')
}

const getCheckLines = (check: OracleAdapterCheck): CheckLine[] => {
  const lines: CheckLine[] = [{ key: 'message', text: check.message, muted: false }]
  const expected = formatCheckDetail(check.expected)
  if (expected !== undefined) lines.push({ key: 'expected', text: `Expected: ${expected}`, muted: true })
  const observed = formatCheckDetail(check.observed)
  if (observed !== undefined) lines.push({ key: 'observed', text: `Observed: ${observed}`, muted: true })
  return lines
}

const copyAddress = (address: string) => {
  copyToClipboard(address, getAddressCopyKey(address)).catch(() => {})
}

const openedAt = new Date()

const checkedAt = computed(() => {
  if (!lastCheckedAt) return undefined
  const date = new Date(lastCheckedAt)
  return Number.isNaN(date.getTime()) ? undefined : date
})

const checkedAgo = computed(() => (checkedAt.value ? getRelativeTimeBetweenDates(openedAt, checkedAt.value) : undefined))

const isStale = computed(() => (checkedAt.value ? openedAt.getTime() - checkedAt.value.getTime() > STALE_ASSESSMENT_MS : false))
</script>

<template>
  <BaseModalWrapper
    :title="modalTitle"
    :inline="inline"
    :close="close"
    :compact="inline && !close"
    @close="$emit('close')"
  >
    <div class="flex flex-col gap-10">
      <p
        v-if="note"
        class="text-p4 text-content-secondary"
      >
        {{ note }}
      </p>
      <p
        v-if="checkedAgo"
        class="text-p4 text-content-tertiary"
      >
        Checked {{ checkedAgo }}<span
          v-if="isStale"
          class="text-warning-500"
        > · may be out of date</span>
      </p>
      <div
        v-for="(check, i) in checks"
        :key="`${check.id}-${i}`"
        class="flex items-start gap-10"
      >
        <span
          class="flex-shrink-0 w-20 h-20 rounded-full flex items-center justify-center mt-8"
          :class="{
            'bg-success-500': check.outcome === OracleAdapterCheckOutcome.Pass,
            'bg-error-500': check.outcome === OracleAdapterCheckOutcome.Fail && check.severity === OracleAdapterCheckSeverity.High,
            'bg-warning-500': check.outcome === OracleAdapterCheckOutcome.Unknown || (check.outcome === OracleAdapterCheckOutcome.Fail && check.severity !== OracleAdapterCheckSeverity.High),
            'bg-content-muted': check.outcome === OracleAdapterCheckOutcome.NotApplicable,
          }"
        >
          <SvgIcon
            :name="check.outcome === OracleAdapterCheckOutcome.Pass ? 'check' : check.outcome === OracleAdapterCheckOutcome.Fail ? 'close' : check.outcome === OracleAdapterCheckOutcome.Unknown ? 'warning' : 'info-circle'"
            class="!w-10 !h-10 text-white"
          />
        </span>
        <div class="min-w-0">
          <p class="text-p3 font-medium text-content-primary break-words">
            {{ formatOracleCheckTitle(check.id) }}
          </p>
          <template
            v-for="line in getCheckLines(check)"
            :key="`${check.id}-${i}-${line.key}`"
          >
            <p
              class="break-words"
              :class="line.muted ? 'text-p4 text-content-tertiary' : 'text-p3 text-content-secondary'"
            >
              <template
                v-for="(part, partIndex) in getCheckMessageParts(line.text)"
                :key="`${check.id}-${i}-${line.key}-${partIndex}`"
              >
                <button
                  v-if="part.address"
                  type="button"
                  class="group inline-flex max-w-full items-center gap-4 rounded-4 border border-line-subtle bg-surface-secondary px-5 py-1 align-baseline font-mono text-[13px] leading-[18px] text-accent-600 outline-none transition-colors hover:border-line-default hover:text-accent-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-600"
                  :aria-label="`Copy address ${part.address}`"
                  @mousedown.stop.prevent
                  @click.stop.prevent="copyAddress(part.address)"
                  @keydown.enter.stop.prevent="copyAddress(part.address)"
                  @keydown.space.stop.prevent="copyAddress(part.address)"
                >
                  <span class="min-w-0 break-all">{{ part.text }}</span>
                  <SvgIcon
                    class="!w-12 !h-12 shrink-0 opacity-70 transition-opacity group-hover:opacity-100"
                    :name="isCopied(getAddressCopyKey(part.address)) ? 'check' : 'copy'"
                  />
                </button>
                <template v-else>
                  {{ part.text }}
                </template>
              </template>
            </p>
            <a
              v-if="line.key === 'message' && check.id === 'source-provenance'"
              :href="ORACLE_SOURCE_REPOSITORY_URL"
              class="inline-block text-p4 text-accent-600 underline transition-colors hover:text-accent-500"
              target="_blank"
              rel="noopener noreferrer"
            >View source on GitHub ↗</a>
          </template>
        </div>
      </div>
    </div>
  </BaseModalWrapper>
</template>
