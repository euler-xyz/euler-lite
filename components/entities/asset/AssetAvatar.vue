<script setup lang="ts">
import { getAssetLogoUrl } from '~/composables/useTokenList'

const { asset, size, iconUrl, chainId } = defineProps<{
  asset: { address: string, symbol: string, chainId?: number } | { address: string, symbol: string, chainId?: number }[]
  size?: '16' | '20' | '36' | '38' | '40' | '46'
  iconUrl?: string
  chainId?: number
}>()

const sizeClass = computed(() => size ? `icon--${size}` : undefined)

const src = computed(() => {
  if (iconUrl) return iconUrl
  if (Array.isArray(asset)) {
    return asset.map(a => getAssetLogoUrl(a.address, a.symbol, a.chainId ?? chainId))
  }
  return getAssetLogoUrl(asset.address, asset.symbol, asset.chainId ?? chainId)
})

const label = computed(() => {
  if (Array.isArray(asset)) return asset.map(a => a.symbol)
  return asset.symbol
})
</script>

<template>
  <BaseAvatar
    :src="src"
    :label="label"
    :class="sizeClass"
  />
</template>
