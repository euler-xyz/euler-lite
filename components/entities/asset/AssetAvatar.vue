<script setup lang="ts">
import { getAssetLogoUrl } from '~/composables/useTokenList'

const { asset, size, iconUrl } = defineProps<{
  asset: { address: string, symbol: string } | { address: string, symbol: string }[]
  size?: '16' | '20' | '28' | '36' | '38' | '40' | '46'
  iconUrl?: string
}>()

const sizeClass = computed(() => size ? `icon--${size}` : undefined)

const src = computed(() => {
  if (iconUrl) return iconUrl
  if (Array.isArray(asset)) {
    return asset.map(a => getAssetLogoUrl(a.address, a.symbol))
  }
  return getAssetLogoUrl(asset.address, asset.symbol)
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
