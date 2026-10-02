<script setup lang="ts">
import { isEulerEarn, isSecuritizeCollateralVault, type SecuritizeCollateralVault, type EVault, type EulerEarn } from '@eulerxyz/euler-v2-sdk'
import type { VaultAsset } from '~/types/asset'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'
import { isAnyVaultBlockedByCountry } from '~/composables/useGeoBlock'
import { getAddress } from 'viem'

const { vault, assets, size, assetsLabel, pairVault, back, backFallback } = defineProps<{
  vault?: EVault | EulerEarn | SecuritizeCollateralVault
  assets: VaultAsset[]
  /** `small` renders a compact identity for list contexts (e.g. activity rows) where surrounding content carries the emphasis. */
  size?: 'large' | 'small'
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
    :class="[size === 'large' ? 'gap-16' : size === 'small' ? 'gap-10' : 'gap-12']"
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
      :size="size === 'large' ? '46' : size === 'small' ? '32' : '38'"
    />

    <div class="min-w-0">
      <div
        class="flex flex-wrap items-center gap-8 min-w-0"
        :class="size === 'small' ? 'mb-2 text-p4' : 'mb-4'"
      >
        <span
          class="block min-w-0 max-w-full truncate text-content-tertiary"
          :title="pairVault ? displayLabel : displayName"
          data-id="data-point"
          :data-key="pairVault ? `${vault.address.toLowerCase()}:${pairVault.address.toLowerCase()}` : vault.address.toLowerCase()"
          data-field="name"
          :data-value="pairVault ? displayLabel : displayName"
        >
          <VaultDisplayName
            :name="pairVault ? displayLabel : displayName"
            :is-unverified="(!!vault && !isVerifiedVault(vault.address)) || !!(pairVault && !isVerifiedVault(pairVault.address))"
            :addresses="[vault.address, ...(pairVault ? [pairVault.address] : [])]"
          />
        </span>
        <VaultDeprecatedBadge :addresses="[vault.address, ...(pairVault ? [pairVault.address] : [])]" />
        <VaultAssessmentWarning
          :address="vault.address"
          :family="isEulerEarn(vault) ? 'earn' : isSecuritizeCollateralVault(vault) ? null : 'evk'"
          hide-deprecated
        />
        <VaultAssessmentWarning
          v-if="pairVault"
          :address="pairVault.address"
          hide-deprecated
        />
        <RestrictedBadge v-if="isRestricted" />
        <slot />
      </div>

      <VaultVisibilityNotice :address="vault.address" />
      <VaultVisibilityNotice
        v-if="pairVault"
        :address="pairVault.address"
      />

      <p
        class="flex flex-wrap items-center gap-8 font-semibold text-content-primary min-w-0"
        :class="size === 'small' ? 'text-p3' : 'text-p2'"
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
