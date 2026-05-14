<script setup lang="ts">
import { formatUnits } from 'viem'
import type { Vault, SecuritizeVault, VaultAsset, CollateralOption, EarnVault } from '~/entities/vault'
import { getAssetUsdPrice } from '~/services/pricing/priceProvider'
import { nanoToValue } from '~/utils/crypto-utils'
import { compactNumber, formatSmartAmount, trimTrailingZeros, formatExactAmount } from '~/utils/string-utils'
import { ChooseCollateralModal } from '#components'
import { useModal } from '~/components/ui/composables/useModal'

const props = defineProps<{
  label?: string
  desc?: string
  maxable?: boolean
  vault?: Vault | EarnVault | SecuritizeVault
  asset: VaultAsset
  balance?: bigint
  balanceLoading?: boolean
  collateralOptions?: CollateralOption[]
  collateralModalTitle?: string
  collateralModalApyLabel?: string
  readonly?: boolean
  priceOverride?: number // USD unit price for assets without a vault (e.g., swap-to-deposit)
  swappable?: boolean // When true, asset pill shows dropdown arrow and emits click-asset
  selectedSource?: 'wallet' | 'saving' // Source indicator chip when multiple collateral options exist
  selectedSubAccount?: string // Disambiguates between multiple savings positions on different sub-accounts
  selectedVaultAddress?: string // Disambiguates same sub-account positions across different vaults
  maxHandler?: () => void // When provided, replaces the default "Max" button behavior
}>()
const emits = defineEmits(['input', 'change-collateral', 'click-asset'])
const model = defineModel<string>({ default: '' })

const inputEl = useTemplateRef<HTMLInputElement>('inputEl')
const modal = useModal()
const isFocused = ref(false)
const emitInputTimeout = ref<ReturnType<typeof setTimeout> | null>(null)
const emitInputDebounced = () => {
  if (emitInputTimeout.value) {
    clearTimeout(emitInputTimeout.value)
  }
  emitInputTimeout.value = setTimeout(() => {
    emits('input')
    emitInputTimeout.value = null
  }, 250)
}

const emitInputNow = () => {
  if (emitInputTimeout.value) {
    clearTimeout(emitInputTimeout.value)
    emitInputTimeout.value = null
  }
  emits('input')
}

const matchesSelectedSubAccount = (a?: string, b?: string) => {
  if (!a || !b) return false
  return a.toLowerCase() === b.toLowerCase()
}
const matchesSelectedVault = (a?: string, b?: string) => {
  if (!b) return true
  if (!a) return false
  return a.toLowerCase() === b.toLowerCase()
}
const getSelectedIdx = () => {
  if (props.selectedSource && props.collateralOptions?.length) {
    if (props.selectedSubAccount) {
      const exact = props.collateralOptions.findIndex(o =>
        o.type === props.selectedSource
        && matchesSelectedSubAccount(o.subAccount, props.selectedSubAccount)
        && matchesSelectedVault(o.vaultAddress, props.selectedVaultAddress),
      )
      if (exact >= 0) return exact
    }
    const idx = props.collateralOptions.findIndex(o => o.type === props.selectedSource)
    if (idx >= 0) return idx
  }
  return 0
}
const selectedIdx = ref(getSelectedIdx())
watch(
  [() => props.selectedSource, () => props.selectedSubAccount, () => props.selectedVaultAddress, () => props.collateralOptions],
  () => { selectedIdx.value = getSelectedIdx() },
)
const friendlyBalance = computed(() => nanoToValue(props.balance ?? 0n, props.asset?.decimals || 18))

// Auto-advance past disabled options (blocked/restricted vaults)
watch(() => props.collateralOptions, (options) => {
  if (!options?.length) return
  const current = options[selectedIdx.value]
  if (current?.disabled) {
    const firstEnabled = options.findIndex(o => !o.disabled)
    if (firstEnabled >= 0) {
      selectedIdx.value = firstEnabled
      emits('change-collateral', firstEnabled)
    }
  }
})

// Fetch USD unit price (re-runs when vault changes)
const usdUnitPrice = ref<number | null>(null)

watchEffect(async () => {
  if (props.vault) {
    const priceInfo = await getAssetUsdPrice(props.vault, 'off-chain')
    usdUnitPrice.value = priceInfo ? nanoToValue(priceInfo.amountOutMid, 18) : null
    return
  }

  usdUnitPrice.value = null
})

// Display price (synchronous computed — tracks model.value reactively)
const price = computed(() => {
  if (props.priceOverride !== undefined) {
    return props.priceOverride * (+model.value || 0)
  }
  if (usdUnitPrice.value === null) return null
  return (+model.value || 0) * usdUnitPrice.value
})

const hasPrice = computed(() => price.value !== null)
const setMax = () => {
  if (props.maxHandler) {
    props.maxHandler()
    return
  }
  model.value = trimTrailingZeros(formatUnits(props.balance ?? 0n, Number(props.asset.decimals)))
  emitInputNow()
  if (inputEl.value) {
    inputEl.value.value = model.value || ''
  }
}
const onInput = (e: Event) => {
  const inputEvent = e as InputEvent
  if (props.readonly || inputEvent.data === '-') {
    (e.target as HTMLInputElement).value = String(model.value ?? '')
    return
  }
  let value = (e.target as HTMLInputElement).value
  value = value.replace(',', '.')
  if (isNaN(Number(value)) && Boolean(value)) {
    (e.target as HTMLInputElement).value = String(model.value)
  }
  else {
    model.value = value
  }
  emitInputDebounced()
}
const onBlur = () => {
  isFocused.value = false
  if (!props.readonly) {
    emitInputNow()
  }
}

onBeforeUnmount(() => {
  if (emitInputTimeout.value) {
    clearTimeout(emitInputTimeout.value)
    emitInputTimeout.value = null
  }
})
const openChooseCollateralModal = () => {
  if ((props.collateralOptions?.length ?? 0) < 2) {
    return
  }
  modal.open(ChooseCollateralModal, {
    props: {
      productName: props.desc,
      symbol: props.asset.symbol,
      collateralOptions: props.collateralOptions,
      selected: selectedIdx.value,
      title: props.collateralModalTitle,
      apyLabel: props.collateralModalApyLabel,
      onSave: (selectedIndex: number) => {
        selectedIdx.value = selectedIndex
        emits('change-collateral', selectedIndex)
        modal.close()
      },
    },
  })
}
</script>

<template>
  <div
    class="flex flex-col gap-12 p-16 rounded-16 border transition-all duration-200"
    :class="[
      isFocused
        ? 'bg-bg-surface border-accent-500 shadow-accent-glow'
        : 'bg-[var(--ui-form-field-background)] border-[var(--ui-form-field-border-color)] shadow-[var(--ui-form-field-shadow)]',
    ]"
  >
    <div
      v-if="label || desc"
      class="flex justify-between text-content-tertiary"
    >
      <p>
        {{ label }}
      </p>

      <p>
        {{ desc }}
      </p>
    </div>
    <div
      class="flex items-center gap-12"
    >
      <input
        ref="inputEl"
        v-text-fit
        :value="model"
        class="text-h1 text-content-primary w-full min-w-0 h-40 outline-none placeholder:text-content-tertiary"
        type="text"
        placeholder="0.00"
        maxlength="24"
        autocomplete="off"
        step="0.1"
        :readonly="props.readonly"
        :inputmode="props.readonly ? 'none' : 'decimal'"
        @focus="isFocused = true"
        @blur="onBlur"
        @input="onInput"
      >

      <div
        class="bg-card text-p3 font-semibold gap-8 flex items-center justify-center px-12 min-h-36 py-6 rounded-[40px] whitespace-nowrap cursor-pointer shrink-0"
        @click="swappable ? emits('click-asset') : openChooseCollateralModal()"
      >
        <AssetAvatar
          :asset="asset"
          size="20"
        />
        <div class="flex flex-col items-start">
          <span class="flex items-center gap-8">
            {{ asset.symbol }}
            <SvgIcon
              v-if="swappable || (collateralOptions?.length ?? 0) > 1"
              class="text-content-tertiary !w-16 !h-16"
              name="arrow-down"
            />
          </span>
          <span
            v-if="selectedSource === 'wallet' && (collateralOptions?.length ?? 0) > 1"
            class="text-[10px] leading-[12px] text-accent-600"
          >
            Wallet
          </span>
          <span
            v-else-if="selectedSource === 'saving' && (collateralOptions?.length ?? 0) > 1"
            class="text-[10px] leading-[12px] text-yellow-600"
          >
            Savings
          </span>
        </div>
      </div>
    </div>
    <div
      class="flex"
      :class="hasPrice ? 'justify-between' : 'justify-end'"
    >
      <p
        v-if="hasPrice && price !== null"
        class="text-content-tertiary"
      >
        <template v-if="price > 10 ** 18">
          A lot
        </template>
        <template v-else>
          ${{ compactNumber(price, 2) }}
        </template>
      </p>

      <BaseLoadableContent
        v-if="maxable"
        :loading="balanceLoading ?? false"
      >
        <p @click="setMax">
          <UiExactAmount
            class="text-content-tertiary"
            :exact="formatExactAmount(balance ?? 0n, asset?.decimals ?? 18n, asset.symbol)"
          >
            {{ formatSmartAmount(friendlyBalance) }} {{ asset.symbol }}
          </UiExactAmount> <span
            class="text-accent-500 font-semibold px-4 cursor-pointer select-none text-[12px] leading-[16px]"
          >Max</span> <!-- TODO: button -->
        </p>
      </BaseLoadableContent>
    </div>
  </div>
</template>
