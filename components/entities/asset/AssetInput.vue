<script setup lang="ts">
import { formatUnits } from 'viem'
import type { Vault, SecuritizeVault, VaultAsset, CollateralOption, EarnVault } from '~/entities/vault'
import { getAssetUsdPrice } from '~/services/pricing/priceProvider'
import { nanoToValue } from '~/utils/crypto-utils'
import { compactNumber, formatSmartAmount, trimTrailingZeros } from '~/utils/string-utils'
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
  readonly?: boolean
  priceOverride?: number // For vaults without standard price info (e.g., securitize)
  swappable?: boolean // When true, asset pill shows dropdown arrow and emits click-asset
}>()
const emits = defineEmits(['input', 'change-collateral', 'click-asset'])
const model = defineModel<string>({ default: '' })

const inputEl = useTemplateRef<HTMLInputElement>('inputEl')
const modal = useModal()
const isFocused = ref(false)

const selectedIdx = ref(0)
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
  if (!props.vault) {
    usdUnitPrice.value = null
    return
  }
  const priceInfo = await getAssetUsdPrice(props.vault, 'off-chain')
  usdUnitPrice.value = priceInfo ? nanoToValue(priceInfo.amountOutMid, 18) : null
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
  model.value = trimTrailingZeros(formatUnits(props.balance ?? 0n, Number(props.asset.decimals)))
  emits('input')
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
  emits('input', e)
}
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
        ? 'bg-bg-surface border-accent-500 shadow-[var(--shadow-focus-accent)]'
        : 'bg-[var(--ui-form-field-background)] border-[var(--ui-form-field-border-color)] shadow-[var(--ui-form-field-shadow)]',
    ]"
  >
    <div
      v-if="label || desc"
      class="flex justify-between text-euler-dark-800"
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
        class="text-h1 text-euler-dark-1000 w-full h-40 outline-none placeholder:text-euler-dark-800"
        type="text"
        placeholder="0.00"
        maxlength="24"
        autocomplete="off"
        step="0.1"
        :readonly="readonly"
        :inputmode="readonly ? 'none' : 'decimal'"
        @focus="isFocused = true"
        @blur="isFocused = false"
        @input="onInput"
      >

      <div
        class="bg-euler-dark-500 text-p3 font-semibold gap-8 flex items-center justify-center px-12 h-36 rounded-[40px] whitespace-nowrap cursor-pointer"
        @click="swappable ? emits('click-asset') : openChooseCollateralModal()"
      >
        <AssetAvatar
          :asset="asset"
          size="20"
        />
        {{ asset.symbol }}
        <SvgIcon
          v-if="swappable || (collateralOptions?.length ?? 0) > 1"
          class="text-euler-dark-800 !w-16 !h-16"
          name="arrow-down"
        />
      </div>
    </div>
    <div
      class="flex"
      :class="hasPrice ? 'justify-between' : 'justify-end'"
    >
      <p
        v-if="hasPrice && price !== null"
        class="text-euler-dark-800"
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
          <span class="text-euler-dark-800">{{ formatSmartAmount(friendlyBalance) }} {{ asset.symbol }}</span> <span
            class="text-aquamarine-700 font-semibold px-4 cursor-pointer select-none text-[12px] leading-[16px]"
          >Max</span> <!-- TODO: button -->
        </p>
      </BaseLoadableContent>
    </div>
  </div>
</template>
