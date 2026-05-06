<script setup lang="ts">
import type { VaultAsset } from '~/types/asset'
import { getAddress, type Address, zeroAddress, isAddress } from 'viem'

import { formatNumber } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import { isAssetBlockedByCountry, isAssetRestrictedByCountry } from '~/composables/useGeoBlock'

export interface SwapTokenSelectMeta {
  isUnknownToken?: boolean
}

const emits = defineEmits<{
  close: []
}>()

const { onSelect, currentAssetAddress, mode = 'input', allowNativeCurrency = false, pairedAsset } = defineProps<{
  onSelect: (asset: VaultAsset, meta?: SwapTokenSelectMeta) => void
  currentAssetAddress?: string
  mode?: 'input' | 'output'
  /** Show address-zero native currency entry. Only enable for flows that support wrapping. */
  allowNativeCurrency?: boolean
  /**
   * Counterpart asset already fixed by the surrounding flow (e.g. the vault's
   * underlying asset when this picker chooses what to swap into/out of). Passed
   * straight through to `isAssetRestrictedByCountry` so soft-restrict can be
   * bypassed when option and counterpart form an ERC-4626 wrap pair.
   */
  pairedAsset?: { address: string }
}>()

const { getByType } = useVaultRegistry()
const { getBalance } = useWallets()
const { getAllTokens, toVaultAsset } = useTokenList()
const {
  customToken,
  customTokenBalance,
  isLoading: isCustomTokenLoading,
  error: customTokenError,
  resolve: resolveCustomToken,
  reset: resetCustomToken,
} = useCustomTokenResolver()

const searchQuery = ref('')

interface TokenOption {
  asset: VaultAsset
  balance: bigint
  balanceFormatted: number
  source: 'vault' | 'tokenList'
}

// Picker-geo semantics:
// - 'input' (pay-with): user gives up this asset. Hard-block disables, soft-restrict
//   does not (reducing exposure).
// - 'output' (receive-as): user acquires this asset. Both hard-block and
//   soft-restrict disable.
// Accepts the full asset so symbol/name pattern rules (assets.json + all/assets.json)
// are consulted, not just the address map.
const getAssetGeoState = (asset: VaultAsset, pickerMode: 'input' | 'output'): { disabled: boolean, showChip: boolean } => {
  if (isAssetBlockedByCountry(asset)) return { disabled: true, showChip: true }
  if (pickerMode === 'output' && isAssetRestrictedByCountry(asset, { counterpart: pairedAsset })) {
    return { disabled: true, showChip: true }
  }
  return { disabled: false, showChip: false }
}

const tokenOptions = computed((): TokenOption[] => {
  const seen = new Set<string>()
  const options: TokenOption[] = []

  // Vault assets first — they take precedence
  const allVaults = [...getByType('evk'), ...getByType('earn'), ...getByType('securitize')]
  for (const vault of allVaults) {
    if (!vault.asset?.address) continue
    let normalized: string
    try {
      normalized = getAddress(vault.asset.address)
    }
    catch {
      continue
    }
    if (seen.has(normalized)) continue
    seen.add(normalized)

    const balance = getBalance(normalized as Address)
    options.push({
      asset: vault.asset,
      balance,
      balanceFormatted: nanoToValue(balance, vault.asset.decimals),
      source: 'vault',
    })
  }

  // Token list tokens — only those not already in vault set
  for (const entry of getAllTokens()) {
    let normalized: string
    try {
      normalized = getAddress(entry.address)
    }
    catch {
      continue
    }
    if (seen.has(normalized)) continue
    if (normalized === zeroAddress && !allowNativeCurrency) continue
    seen.add(normalized)

    const asset = toVaultAsset(entry)
    const balance = getBalance(normalized as Address)
    options.push({
      asset,
      balance,
      balanceFormatted: nanoToValue(balance, asset.decimals),
      source: 'tokenList',
    })
  }

  // Sort: tokens with balance first (desc by balance), then vault tokens alphabetically
  return options.sort((a, b) => {
    if (a.balance > 0n && b.balance <= 0n) return -1
    if (a.balance <= 0n && b.balance > 0n) return 1
    if (a.balance > 0n && b.balance > 0n) {
      if (a.balanceFormatted > b.balanceFormatted) return -1
      if (a.balanceFormatted < b.balanceFormatted) return 1
    }
    return a.asset.symbol.localeCompare(b.asset.symbol)
  })
})

// Include both vault and token list addresses in known set
const knownAddresses = computed(() => {
  const set = new Set<string>()
  for (const opt of tokenOptions.value) {
    set.add(opt.asset.address.toLowerCase())
  }
  return set
})

const isUnknownAddress = computed(() => {
  const q = searchQuery.value.trim()
  return isAddress(q) && !knownAddresses.value.has(q.toLowerCase())
})

const filteredOptions = computed(() => {
  const base = searchQuery.value
    ? tokenOptions.value.filter((opt) => {
        const q = searchQuery.value.toLowerCase()
        return opt.asset.symbol.toLowerCase().includes(q)
          || opt.asset.name.toLowerCase().includes(q)
          || opt.asset.address.toLowerCase().includes(q)
      })
    : tokenOptions.value

  // For input mode (pay with): filter zero-balance tokens when not searching
  // For output mode (receive as): always show all tokens
  if (mode === 'input' && !searchQuery.value) {
    return base.filter(opt => opt.balance > 0n)
  }
  return base
})

// Compute geo state once per visible row rather than 3x per render
// (class binding + bg-card-hover + click guard).
const geoByAddress = computed(() => {
  const map = new Map<string, { disabled: boolean, showChip: boolean }>()
  for (const opt of filteredOptions.value) {
    map.set(opt.asset.address.toLowerCase(), getAssetGeoState(opt.asset, mode))
  }
  return map
})

const rowGeo = (address: string) =>
  geoByAddress.value.get(address.toLowerCase()) ?? { disabled: false, showChip: false }

const customTokenGeo = computed(() =>
  customToken.value ? getAssetGeoState(customToken.value, mode) : { disabled: false, showChip: false },
)

watch(searchQuery, (q) => {
  const trimmed = q.trim()
  if (isAddress(trimmed) && !knownAddresses.value.has(trimmed.toLowerCase())) {
    resolveCustomToken(trimmed)
  }
  else {
    resetCustomToken()
  }
})

const isSelected = (address: string) => {
  if (!currentAssetAddress) return false
  try {
    return getAddress(address) === getAddress(currentAssetAddress)
  }
  catch {
    return false
  }
}

const handleSelect = (opt: TokenOption) => {
  onSelect(opt.asset, { isUnknownToken: false })
  emits('close')
}

const onRowClick = (opt: TokenOption) => {
  if (rowGeo(opt.asset.address).disabled) return
  handleSelect(opt)
}

const handleSelectCustomToken = () => {
  if (!customToken.value) return
  if (customTokenGeo.value.disabled) return
  onSelect(customToken.value, { isUnknownToken: true })
  emits('close')
}
</script>

<template>
  <BaseModalWrapper
    title="Select asset"
    full
    @close="$emit('close')"
  >
    <div class="flex flex-col flex-1 min-h-0 overflow-hidden">
      <div class="px-16 pb-12">
        <UiInput
          v-model="searchQuery"
          placeholder="Search by name, symbol, or address"
          icon="search"
          clearable
        />
      </div>
      <div class="flex-1 min-h-0 overflow-auto styled-scrollbar">
        <div
          v-for="opt in filteredOptions"
          :key="opt.asset.address"
          class="flex items-center py-12 px-16 rounded-16"
          :class="[
            rowGeo(opt.asset.address).disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
            isSelected(opt.asset.address) && !rowGeo(opt.asset.address).disabled ? 'bg-card-hover' : '',
          ]"
          @click="onRowClick(opt)"
        >
          <AssetAvatar
            :asset="opt.asset"
            size="36"
            class="mr-10"
          />
          <div class="flex-grow">
            <div class="text-content-primary mb-2">
              {{ opt.asset.name }}
            </div>
            <div class="text-h5 flex items-center">
              {{ opt.asset.symbol }}
              <span
                v-if="rowGeo(opt.asset.address).showChip"
                class="ml-6 inline-flex items-center rounded-8 px-8 py-2 bg-warning-100 text-warning-500 text-p5"
              >
                Restricted
              </span>
            </div>
          </div>
          <div class="text-right">
            <div class="text-content-primary mb-2">
              Balance
            </div>
            <div class="text-h5">
              {{ opt.balance > 0n ? formatNumber(opt.balanceFormatted, 6, 0) : '0' }}
            </div>
          </div>
        </div>
        <!-- Custom token: loading -->
        <div
          v-if="isUnknownAddress && isCustomTokenLoading"
          class="flex items-center justify-center py-24 gap-8 text-content-tertiary text-p3"
        >
          <UiLoader class="text-neutral-500" />
          Looking up token...
        </div>

        <!-- Custom token: resolved -->
        <div
          v-else-if="isUnknownAddress && customToken"
          class="flex items-center py-12 px-16 rounded-16 hover:bg-surface-secondary"
          :class="customTokenGeo.disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'"
          @click="handleSelectCustomToken"
        >
          <AssetAvatar
            :asset="customToken"
            size="36"
            class="mr-10"
          />
          <div class="flex-grow">
            <div class="flex items-center gap-6 mb-2">
              <span class="text-content-primary">{{ customToken.name }}</span>
              <span class="inline-flex items-center rounded-8 px-8 py-2 bg-warning-100 text-warning-500 text-p5">
                Import
              </span>
              <span
                v-if="customTokenGeo.showChip"
                class="inline-flex items-center rounded-8 px-8 py-2 bg-warning-100 text-warning-500 text-p5"
              >
                Restricted
              </span>
            </div>
            <div class="text-h5">
              {{ customToken.symbol }}
            </div>
          </div>
          <div class="text-right">
            <div class="text-content-primary mb-2">
              Balance
            </div>
            <div class="text-h5">
              {{ customTokenBalance > 0n ? formatNumber(nanoToValue(customTokenBalance, customToken.decimals), 6, 0) : '0' }}
            </div>
          </div>
        </div>

        <!-- Custom token: error -->
        <div
          v-else-if="isUnknownAddress && customTokenError"
          class="py-24 text-center text-content-tertiary text-p3"
        >
          {{ customTokenError }}
        </div>

        <!-- No results (only when NOT resolving a custom address) -->
        <div
          v-if="!filteredOptions.length && searchQuery && !isUnknownAddress"
          class="py-24 text-center text-content-tertiary text-p3"
        >
          No results found
        </div>
      </div>
    </div>
  </BaseModalWrapper>
</template>
