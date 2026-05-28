<script setup lang="ts">
import { getSubAccountId as getSubAccountIndex } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'
import type { CollateralOption } from '~/types/collateral-option'
import { getVaultProductName } from '~/utils/eulerLabelsUtils'

import { formatNumber, formatSmartAmount } from '~/utils/string-utils'

const emits = defineEmits(['close'])
const { productName, symbol, collateralOptions, selected = 0, title = 'Select collateral', apyLabel = 'Supply APY', onSave } = defineProps<{
  productName: string
  symbol: string
  collateralOptions: CollateralOption[]
  selected?: number
  title?: string
  apyLabel?: string
  onSave: (selectedIndex: number) => void
}>()

const { isEscrowVault } = useVaultRegistry()
const { address } = useWagmi()
const { portfolioAddress } = useEulerAccount()

const searchQuery = ref('')
const selectedIdx = ref(selected)
const ownerAddress = computed(() => portfolioAddress.value || address.value || '')
const getOptionLabel = (option: CollateralOption) => {
  if (option.vaultAddress && isEscrowVault(option.vaultAddress)) return 'Escrowed collateral'
  if (option.label) return option.label
  if (option.vaultAddress) {
    const name = getVaultProductName(option.vaultAddress)
    if (name) return name
  }
  return productName
}
const getOptionSymbol = (option: CollateralOption) => option.symbol || symbol
const getOptionType = (option: CollateralOption) => {
  if (option.type === 'escrow') return 'escrow'
  if (option.vaultAddress && isEscrowVault(option.vaultAddress)) return 'escrow'
  return option.type
}
const shortenAddress = (value: string) => `${value.slice(0, 6)}...${value.slice(-4)}`
const getSubAccountLabel = (option: CollateralOption) => {
  if (!option.subAccount) return ''
  if (!ownerAddress.value) return shortenAddress(option.subAccount)
  try {
    return `Position ${getSubAccountIndex(getAddress(ownerAddress.value), getAddress(option.subAccount))}`
  }
  catch {
    return shortenAddress(option.subAccount)
  }
}
const getApyLabel = (option: CollateralOption) => {
  return option.type === 'wallet' ? 'If supplied: APY' : apyLabel
}
const showBalanceMetric = (option: CollateralOption) => option.showBalance !== false
const getFormattedAmount = (option: CollateralOption) => {
  return `${formatSmartAmount(option.amount)} ${getOptionSymbol(option)}`
}

const filteredOptions = computed(() => {
  if (!searchQuery.value) return collateralOptions.map((option, idx) => ({ option, idx }))
  const q = searchQuery.value.toLowerCase()
  return collateralOptions
    .map((option, idx) => ({ option, idx }))
    .filter(({ option }) =>
      getOptionSymbol(option).toLowerCase().includes(q)
      || getOptionLabel(option).toLowerCase().includes(q),
    )
})

const handleClose = () => {
  emits('close')
}
</script>

<template>
  <BaseModalWrapper
    :title="title"
    full
    @close="handleClose"
  >
    <div class="px-16 pb-12">
      <UiInput
        v-model="searchQuery"
        placeholder="Search by name or symbol"
        icon="search"
        clearable
      />
    </div>
    <div class="flex-1 min-h-0 overflow-auto styled-scrollbar">
      <div
        v-for="{ option, idx } in filteredOptions"
        :key="`options-${idx}`"
        data-id="collateral-option"
        :data-option-index="String(idx)"
        :data-option-label="getOptionLabel(option)"
        :data-option-symbol="getOptionSymbol(option)"
        :data-option-type="getOptionType(option)"
        :data-option-asset-address="option.assetAddress?.toLowerCase() ?? ''"
        :data-option-vault-address="option.vaultAddress?.toLowerCase() ?? ''"
        :data-option-sub-account="option.subAccount?.toLowerCase() ?? ''"
        :data-option-disabled="option.disabled ? 'true' : 'false'"
        class="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-10 py-12 px-16 rounded-16"
        :class="[
          option.disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
          selectedIdx === idx && !option.disabled ? 'bg-card-hover' : '',
        ]"
        @click="
          if (!option.disabled) { selectedIdx = idx;onSave(idx) }
        "
      >
        <AssetAvatar
          :asset="{ address: option.assetAddress || '', symbol: getOptionSymbol(option) }"
          size="36"
        />
        <div class="grid grid-cols-[minmax(0,1fr)_max-content] items-center gap-12 min-w-0">
          <div class="min-w-0">
            <div class="text-content-primary mb-2 truncate">
              {{ getOptionLabel(option) }}
            </div>
            <div class="text-h5 flex items-center min-w-0">
              <span class="truncate">{{ getOptionSymbol(option) }}</span>
              <div
                v-if="getOptionType(option) === 'wallet'"
                class="ml-6 text-[12px] leading-[16px] py-4 px-8 rounded-8 bg-accent-600/10 text-accent-600"
              >
                Wallet
              </div>
              <div
                v-else-if="getOptionType(option) === 'saving'"
                class="ml-6 text-[12px] leading-[16px] py-4 px-8 rounded-8 bg-[#CBC0951A] text-yellow-600"
              >
                Savings
              </div>
              <div
                v-if="getSubAccountLabel(option)"
                class="ml-6 text-[12px] leading-[16px] py-4 px-8 rounded-8 bg-card text-content-secondary"
              >
                {{ getSubAccountLabel(option) }}
              </div>
              <span
                v-for="tag in (option.tags || [])"
                :key="tag"
                class="ml-6 inline-flex items-center gap-4 rounded-8 px-8 py-2 bg-warning-100 text-warning-500 text-p5"
              >
                <SvgIcon
                  name="warning"
                  class="!w-14 !h-14"
                />
                {{ tag }}
              </span>
            </div>
          </div>
          <div
            class="grid justify-end text-right"
            :class="showBalanceMetric(option) ? 'grid-cols-[max-content_max-content] gap-32' : 'grid-cols-[max-content]'"
          >
            <div
              v-if="showBalanceMetric(option)"
              class="flex flex-col items-end"
            >
              <div class="text-content-primary mb-2">
                Balance
              </div>
              <div class="text-h5">
                {{ getFormattedAmount(option) }}
              </div>
            </div>
            <div class="flex flex-col items-end min-w-[110px]">
              <div class="text-content-primary mb-2">
                {{ getApyLabel(option) }}
              </div>
              <div class="text-h5">
                {{ option.apy !== undefined ? `${formatNumber(option.apy)}%` : '-' }}
              </div>
            </div>
          </div>
        </div>
      </div>
      <div
        v-if="!filteredOptions.length && searchQuery"
        class="py-24 text-center text-content-tertiary text-p3"
      >
        No results found
      </div>
    </div>
  </BaseModalWrapper>
</template>
