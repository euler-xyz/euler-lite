<script setup lang="ts">
import type { DisplayStep } from '~/utils/stepDecoding'
import { formatUnits } from 'viem'
import { formatNumber, shortenAddress } from '~/utils/string-utils'
import { getChainById } from '~/entities/chainRegistry'

defineProps<{
  steps: DisplayStep[]
}>()

const { chainId } = useEulerAddresses()
const nativeCurrency = computed(() => getChainById(chainId.value)?.nativeCurrency)
const nativeSymbol = computed(() => nativeCurrency.value?.symbol ?? 'ETH')
const nativeDecimals = computed(() => nativeCurrency.value?.decimals ?? 18)
const formatNativeValue = (value: bigint) => formatUnits(value, nativeDecimals.value)
const formatNativeValueWithSymbol = (value: bigint) => `${formatNativeValue(value)} ${nativeSymbol.value}`

const getFullAmountText = (assetInfo?: DisplayStep['assetInfo']) => {
  const amount = assetInfo?.amount
  if (!assetInfo || amount === undefined || amount === 'max' || amount === 'remaining') return undefined
  return `${String(amount)} ${assetInfo.symbol}`
}
</script>

<template>
  <div
    v-for="step in steps"
    :key="step.index"
    class="flex justify-between items-center"
  >
    <div class="flex gap-6 items-center flex-wrap">
      <p class="text-p3">
        {{ step.index }}. {{ step.label }}
      </p>
      <template v-if="step.assetInfo">
        <AssetAvatar
          :asset="{ address: step.assetInfo.iconAddress || step.assetInfo.address || '', symbol: step.assetInfo.symbol }"
          :icon-url="step.assetInfo.iconUrl"
          size="16"
        />
        <p
          v-if="!step.iconOnly"
          class="text-p3"
        >
          <template v-if="step.assetInfo.amount === 'max' || step.assetInfo.amount === 'remaining'">
            {{ step.assetInfo.amount }}&nbsp;{{ step.assetInfo.symbol }}
          </template>
          <template v-else-if="getFullAmountText(step.assetInfo)">
            <UiExactAmount
              :exact="getFullAmountText(step.assetInfo)!"
              :placement="step.index === 1 ? 'bottom' : 'top'"
            >
              {{ step.assetInfo.estimated ? '~' : '' }}{{ formatNumber(step.assetInfo.amount, 8, 0) }}&nbsp;{{ step.assetInfo.symbol }}
            </UiExactAmount>
          </template>
          <template v-else>
            {{ step.assetInfo.symbol }}
          </template>
        </p>
      </template>
      <p
        v-if="step.labelSuffix"
        class="text-p3"
      >
        {{ step.labelSuffix }}
      </p>
      <template v-if="step.toAssetInfo">
        <p
          v-if="!step.iconOnly"
          class="text-p3 text-content-primary"
        >
          &rarr;
        </p>
        <AssetAvatar
          :asset="{ address: step.toAssetInfo.iconAddress || step.toAssetInfo.address || '', symbol: step.toAssetInfo.symbol }"
          :icon-url="step.toAssetInfo.iconUrl"
          size="16"
        />
        <p
          v-if="!step.iconOnly"
          class="text-p3"
        >
          <template v-if="getFullAmountText(step.toAssetInfo)">
            <UiExactAmount
              :exact="getFullAmountText(step.toAssetInfo)!"
              :placement="step.index === 1 ? 'bottom' : 'top'"
            >
              {{ step.toAssetInfo.estimated ? '~' : '' }}{{ formatNumber(step.toAssetInfo.amount, 8, 0) }}&nbsp;{{ step.toAssetInfo.symbol }}
            </UiExactAmount>
          </template>
          <template v-else>
            {{ step.toAssetInfo.symbol }}
          </template>
        </p>
      </template>
      <p
        v-if="step.nativeValue !== undefined && step.nativeValueTarget"
        class="basis-full text-p4 text-content-tertiary"
      >
        Fuul claim fee:
        <UiExactAmount
          :exact="formatNativeValueWithSymbol(step.nativeValue)"
          :placement="step.index === 1 ? 'bottom' : 'top'"
        >
          {{ formatNativeValue(step.nativeValue) }}&nbsp;{{ nativeSymbol }}
        </UiExactAmount>
        to
        <UiExactAmount
          :exact="step.nativeValueTarget"
          :placement="step.index === 1 ? 'bottom' : 'top'"
        >
          {{ shortenAddress(step.nativeValueTarget) }}
        </UiExactAmount>
      </p>
    </div>
    <span
      v-if="step.isSeparateTx"
      class="text-p4 text-content-primary"
    >
      Separate tx
    </span>
  </div>
</template>
