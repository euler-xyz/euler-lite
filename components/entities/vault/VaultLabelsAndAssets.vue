<script setup lang="ts">
import type { SecuritizeCollateralVault, EVault, EulerEarn } from '@eulerxyz/euler-v2-sdk'
import type { VaultAsset } from '~/types/asset'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'
import { isAnyVaultBlockedByCountry } from '~/composables/useGeoBlock'
import { getAddress } from 'viem'

const { vault, assets, size, assetsLabel, pairVault, back, backFallback } = defineProps<{
  vault?: EVault | EulerEarn | SecuritizeCollateralVault
  assets: VaultAsset[]
  size?: 'large'
  assetsLabel?: string
  pairVault?: EVault
  back?: boolean
  backFallback?: string
}>()
const normalizeAddress = (address?: string) => {
  if (!address) return ''
  try {
    return getAddress(address)
  }
  catch {
    return ''
  }
}

const vaultAddress = computed(() => normalizeAddress(vault?.address))
const { getVaultCategory, isVerifiedVault } = useVaultRegistry()
const product = useEulerProductOfVault(vaultAddress)
const displayName = computed(() => {
  if (!vault) return ''
  if (getVaultCategory(vault.address) === 'escrow') {
    return 'Escrowed collateral'
  }
  return product.name || vault.shares.name
})

const pairVaultAddress = computed(() => pairVault ? normalizeAddress(pairVault.address) : '')
const pairProduct = useEulerProductOfVault(pairVaultAddress)

const isVaultDeprecated = computed(() => {
  const addr = vaultAddress.value
  return product.deprecatedVaults?.includes(addr) ?? false
})
const isPairVaultDeprecated = computed(() => {
  if (!pairVault) return false
  const addr = pairVaultAddress.value
  return pairProduct.deprecatedVaults?.includes(addr) ?? false
})
const isDeprecated = computed(() => isVaultDeprecated.value || isPairVaultDeprecated.value)
const isRestricted = computed(() => {
  const addresses: string[] = []
  if (vault?.address) addresses.push(vault.address)
  if (pairVault?.address) addresses.push(pairVault.address)
  if (!addresses.length) return false
  return isAnyVaultBlockedByCountry(...addresses)
})

const getVaultLabel = (v?: EVault | EulerEarn | SecuritizeCollateralVault) => {
  if (!v) return ''
  if (getVaultCategory(v.address) === 'escrow') {
    return 'Escrowed collateral'
  }
  const addr = normalizeAddress(v.address)
  if (addr === vaultAddress.value) {
    return product.name || vault?.shares.name || v.shares.name
  }
  return pairProduct.name || v.shares.name
}

const displayLabel = computed(() => {
  if (!vault) return ''
  const collateralLabel = getVaultLabel(vault)

  if (!pairVault) {
    return collateralLabel
  }

  const borrowLabel = getVaultLabel(pairVault)

  if (collateralLabel === borrowLabel) {
    return collateralLabel
  }

  return `${collateralLabel} / ${borrowLabel}`
})

const displayAssetsLabel = computed(() => assetsLabel || assets.map(asset => asset.symbol).join('/'))
</script>

<template>
  <div
    v-if="vault"
    :class="[size === 'large' ? 'gap-16' : 'gap-12']"
    class="flex items-center min-w-0"
    data-id="vault-header"
    :data-key="pairVault ? `${vault.address.toLowerCase()}:${pairVault.address.toLowerCase()}` : vault.address.toLowerCase()"
    :data-vault-address="vault.address.toLowerCase()"
    :data-pair-vault-address="pairVault?.address.toLowerCase()"
  >
    <BackButton
      v-if="back"
      class="tablet:hidden"
      :fallback="backFallback"
    />
    <AssetAvatar
      :asset="assets"
      :size="size === 'large' ? '46' : '38'"
    />

    <div class="min-w-0">
      <div class="flex flex-wrap items-center gap-8 mb-4 min-w-0">
        <span
          class="text-content-tertiary min-w-0"
          data-id="data-point"
          :data-key="pairVault ? `${vault.address.toLowerCase()}:${pairVault.address.toLowerCase()}` : vault.address.toLowerCase()"
          data-field="name"
          :data-value="pairVault ? displayLabel : displayName"
        >
          <VaultDisplayName
            :name="pairVault ? displayLabel : displayName"
            :is-unverified="(!!vault && !isVerifiedVault(vault.address)) || !!(pairVault && !isVerifiedVault(pairVault.address))"
          />
        </span>
        <span
          v-if="isDeprecated"
          class="inline-flex items-center gap-4 rounded-8 px-8 py-2 bg-warning-100 text-warning-500 text-p5"
        >
          <SvgIcon
            name="warning"
            class="!w-14 !h-14"
          />
          Deprecated
        </span>
        <span
          v-if="isRestricted"
          class="inline-flex items-center gap-4 rounded-8 px-8 py-2 bg-warning-100 text-warning-500 text-p5"
          title="This vault is not available in your region"
        >
          <SvgIcon
            name="warning"
            class="!w-14 !h-14"
          />
          Restricted
        </span>
        <slot />
      </div>

      <p
        class="flex flex-wrap items-center gap-8 text-p2 font-semibold text-content-primary min-w-0"
        data-id="data-point"
        :data-key="pairVault ? `${vault.address.toLowerCase()}:${pairVault.address.toLowerCase()}` : vault.address.toLowerCase()"
        data-field="asset-symbols"
        :data-value="displayAssetsLabel"
      >
        <span class="min-w-0 truncate">{{ displayAssetsLabel }}</span>
        <slot name="symbol-trailing" />
      </p>
    </div>
  </div>
</template>
