<script setup lang="ts">
import { OracleAdapterCheckSeverity, type OracleAdapterCheck } from '~/entities/oracle'

defineEmits(['close'])

const {
  modalTitle = 'Checks',
  checks,
  inline = false,
  close = true,
} = defineProps<{
  modalTitle?: string
  checks: OracleAdapterCheck[]
  inline?: boolean
  close?: boolean
}>()

const addressPattern = /\b0x[a-fA-F0-9]{40}\b/g

type CheckMessagePart = {
  text: string
  address?: string
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

const copyAddress = (address: string) => {
  copyToClipboard(address, getAddressCopyKey(address)).catch(() => {})
}
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
      <div
        v-for="(check, i) in checks"
        :key="`${check.id}-${i}`"
        class="flex items-start gap-10"
      >
        <span
          class="flex-shrink-0 w-20 h-20 rounded-full flex items-center justify-center mt-8"
          :class="{
            'bg-success-500': check.pass,
            'bg-error-500': !check.pass && check.severity === OracleAdapterCheckSeverity.High,
            'bg-warning-500': !check.pass && check.severity !== OracleAdapterCheckSeverity.High,
          }"
        >
          <SvgIcon
            :name="check.pass ? 'check' : 'close'"
            class="!w-10 !h-10 text-white"
          />
        </span>
        <div class="min-w-0">
          <p class="text-p3 font-medium text-content-primary break-words">
            {{ check.id }}
          </p>
          <p class="text-p3 text-content-secondary break-words">
            <template
              v-for="(part, partIndex) in getCheckMessageParts(check.message)"
              :key="`${check.id}-${i}-${partIndex}`"
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
        </div>
      </div>
    </div>
  </BaseModalWrapper>
</template>
