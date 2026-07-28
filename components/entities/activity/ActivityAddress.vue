<script setup lang="ts">
import type { ActivityVaultType } from '@eulerxyz/euler-v2-sdk'
import { getExplorerLink } from '~/utils/block-explorer'
import type { ActivityAddressLinkKind } from '~/utils/activity-display'
import { shortenAddress } from '~/utils/string-utils'

const props = withDefaults(defineProps<{
  address: string
  chainId: number
  label?: string
  linkKind?: ActivityAddressLinkKind
  vaultType?: ActivityVaultType
  compactVault?: boolean
}>(), {
  linkKind: 'explorer',
  compactVault: false,
})

const route = useRoute()
const { activateSpyMode } = useSpyMode()
const {
  getVault,
  getType: getVaultType,
  getOrFetch: getOrFetchVault,
  getVaultCategory,
  isVerifiedVault,
  registryVersion,
} = useVaultRegistry()
const addressRef = toRef(props, 'address')
const product = useEulerProductOfVault(addressRef)
const copyKey = computed(() => `activity-address-${props.address.toLowerCase()}`)
const explorerLink = computed(() => getExplorerLink(props.address, props.chainId, true))
const resolvedVault = computed(() => {
  void registryVersion.value
  return props.linkKind === 'vault' ? getVault(props.address) : undefined
})
const resolvedVaultType = computed(() =>
  getVaultType(props.address) ?? props.vaultType)
const compactVaultName = computed(() => {
  if (!resolvedVault.value) return props.label || shortenAddress(props.address)
  if (getVaultCategory(resolvedVault.value.address) === 'escrow') {
    return 'Escrowed collateral'
  }
  return product.name || resolvedVault.value.shares.name
})
const internalLink = computed(() => {
  const query = typeof route.query.network === 'string'
    ? { network: route.query.network }
    : undefined
  if (props.linkKind === 'spy') {
    return { path: '/portfolio/activity', query: { ...query, spy: props.address } }
  }
  if (props.linkKind === 'vault') {
    return {
      path: resolvedVaultType.value === 'earn' ? `/earn/${props.address}` : `/lend/${props.address}`,
      query,
    }
  }
  return null
})

watch(
  () => [props.address, props.linkKind] as const,
  ([address, linkKind]) => {
    if (linkKind === 'vault') void getOrFetchVault(address)
  },
  { immediate: true },
)

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

const handleInternalClick = (event: MouseEvent) => {
  if (
    props.linkKind !== 'spy'
    || event.button !== 0
    || event.metaKey
    || event.ctrlKey
    || event.shiftKey
    || event.altKey
  ) return
  activateSpyMode(props.address)
}
</script>

<template>
  <span class="inline-flex min-w-0 max-w-full items-center gap-2">
    <NuxtLink
      v-if="internalLink && resolvedVault && compactVault"
      :to="internalLink"
      class="inline-flex min-w-0 max-w-full items-center gap-6 rounded-8 transition-opacity hover:opacity-80"
      :title="address"
    >
      <AssetAvatar
        :asset="[resolvedVault.asset]"
        size="20"
      />
      <span
        class="min-w-0 truncate text-p4 text-content-secondary"
        :title="compactVaultName"
      >
        <VaultDisplayName
          :name="compactVaultName"
          :is-unverified="!isVerifiedVault(resolvedVault.address)"
        />
      </span>
      <span class="shrink-0 text-p4 font-medium text-content-primary">
        {{ resolvedVault.asset.symbol }}
      </span>
    </NuxtLink>
    <NuxtLink
      v-else-if="internalLink && resolvedVault"
      :to="internalLink"
      class="inline-flex min-w-0 max-w-full rounded-8 transition-opacity hover:opacity-80"
      :title="address"
    >
      <VaultLabelsAndAssets
        :vault="resolvedVault"
        :assets="[resolvedVault.asset]"
        size="small"
      />
    </NuxtLink>
    <NuxtLink
      v-else-if="internalLink"
      :to="internalLink"
      class="min-w-0 truncate text-content-secondary transition-colors hover:text-accent-500 hover:underline"
      :title="address"
      @click="handleInternalClick"
    >{{ label || shortenAddress(address) }}</NuxtLink>
    <a
      v-else
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
