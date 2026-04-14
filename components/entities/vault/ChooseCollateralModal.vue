<script setup lang="ts">
import { getVaultProductName } from '~/utils/eulerLabelsUtils'
import type { CollateralOption } from '~/entities/vault'
import { formatNumber } from '~/utils/string-utils'

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

const searchQuery = ref('')
const selectedIdx = ref(selected)
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
    <div class="flex-1 overflow-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div
        v-for="{ option, idx } in filteredOptions"
        :key="`options-${idx}`"
        class="flex items-center py-12 px-16 rounded-16"
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
          class="mr-10"
        />
        <div class="flex-grow">
          <div class="text-content-primary mb-2">
            {{ getOptionLabel(option) }}
          </div>
          <div class="text-h5 flex items-center">
            {{ getOptionSymbol(option) }}
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
          v-if="getOptionType(option) !== 'wallet'"
          class="text-right grow-1"
        >
          <div class="text-content-primary mb-2">
            {{ apyLabel }}
          </div>
          <div class="text-h5">
            {{ option.apy !== undefined ? `${formatNumber(option.apy)}%` : '-' }}
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
