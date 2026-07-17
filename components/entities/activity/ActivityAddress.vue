<script setup lang="ts">
import { getExplorerLink } from '~/utils/block-explorer'
import { shortenAddress } from '~/utils/string-utils'

const props = defineProps<{
  address: string
  chainId: number
  label?: string
}>()

const copyKey = computed(() => `activity-address-${props.address.toLowerCase()}`)
const explorerLink = computed(() => getExplorerLink(props.address, props.chainId, true))

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
  if (fallbackCopy(address)) return
  if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(address)
  else throw new Error('Unable to copy address')
}

const { isCopied, copyToClipboard } = useClipboardCopy({ timeout: 5000, write: writeAddressToClipboard })

const copyAddress = () => {
  copyToClipboard(props.address, copyKey.value).catch(() => {})
}
</script>

<template>
  <span class="inline-flex min-w-0 max-w-full items-center gap-2">
    <a
      :href="explorerLink"
      target="_blank"
      rel="noopener noreferrer"
      class="min-w-0 truncate text-content-secondary transition-colors hover:text-accent-500 hover:underline"
      :title="address"
    >{{ label || shortenAddress(address) }}</a>
    <button
      type="button"
      class="inline-flex h-28 w-28 shrink-0 items-center justify-center rounded-6 text-content-muted transition-colors hover:bg-surface hover:text-content-primary"
      :aria-label="isCopied(copyKey) ? `Copied address ${address}` : `Copy address ${address}`"
      :title="isCopied(copyKey) ? 'Copied' : 'Copy address'"
      @click.stop="copyAddress"
    >
      <SvgIcon
        :name="isCopied(copyKey) ? 'check' : 'copy'"
        class="!h-16 !w-16"
        aria-hidden="true"
      />
    </button>
  </span>
</template>
