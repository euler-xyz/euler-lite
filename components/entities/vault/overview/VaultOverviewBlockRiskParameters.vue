<script setup lang="ts">
import { maxUint256, type Address } from 'viem'
import { formatNumber, compactNumber, formatCompactUsdValue } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import { vaultConvertToAssetsAbi } from '~/abis/vault'
import type { Vault } from '~/entities/vault'
import { getSupplyCapPercentage, getBorrowCapPercentage } from '~/composables/useVaultWarnings'
import { formatAssetValue } from '~/services/pricing/priceProvider'
import {
  decodeHookedOps,
  formatHookedOpsSummary,
  isHookDisabling,
  isVaultEffectivelyPaused,
} from '~/utils/vault-hooks'
import { useModal } from '~/components/ui/composables/useModal'
import { VaultHooksInfoModal } from '#components'

const { vault } = defineProps<{ vault: Vault }>()

const modal = useModal()

const { client: rpcClient } = useRpcClient()
const { borrowList } = useVaults()

const shareTokenExchangeRate: Ref<bigint | undefined> = ref()

const borrowCount = computed(() => {
  return borrowList.value.filter(pair => pair.borrow.address === vault.address).length
})

const isBorrowable = computed(() => borrowCount.value > 0)

const supplyCapPercentageDisplay = computed(() => getSupplyCapPercentage(vault))
const borrowCapPercentageDisplay = computed(() => getBorrowCapPercentage(vault))

const supplyCapDisplay = ref('-')
const borrowCapDisplay = ref('-')

watchEffect(async () => {
  if (vault.supplyCap >= maxUint256) {
    supplyCapDisplay.value = '∞'
    return
  }
  if (vault.supplyCap === 0n) {
    supplyCapDisplay.value = '$0'
    return
  }
  const price = await formatAssetValue(vault.supplyCap, vault, 'off-chain')
  supplyCapDisplay.value = price.hasPrice ? formatCompactUsdValue(price.usdValue) : price.display
})

watchEffect(async () => {
  if (vault.borrowCap >= maxUint256) {
    borrowCapDisplay.value = '∞'
    return
  }
  if (vault.borrowCap === 0n) {
    borrowCapDisplay.value = '$0'
    return
  }
  const price = await formatAssetValue(vault.borrowCap, vault, 'off-chain')
  borrowCapDisplay.value = price.hasPrice ? formatCompactUsdValue(price.usdValue) : price.display
})

const load = async () => {
  const client = rpcClient.value!
  shareTokenExchangeRate.value = await client.readContract({
    address: vault.address as Address,
    abi: vaultConvertToAssetsAbi,
    functionName: 'convertToAssets',
    args: [1n * 10n ** vault.decimals],
  }) as bigint
}

load()

const hookedUserOps = computed(() => decodeHookedOps(vault.hookedOps))

const hooksRowLabel = computed(() =>
  isHookDisabling(vault) ? 'Disabled operations' : 'Hooked operations',
)

const hooksRowValue = computed(() => {
  if (vault.hookedOps === 0n) return 'None'
  if (isVaultEffectivelyPaused(vault)) return 'Paused'
  return formatHookedOpsSummary(hookedUserOps.value)
})

const showHooksInfoIcon = computed(() => vault.hookedOps !== 0n)

const openHooksModal = () => {
  modal.open(VaultHooksInfoModal, {
    props: { vault },
  })
}
</script>

<template>
  <div class="bg-surface-secondary rounded-xl flex flex-col gap-24 p-24 shadow-card">
    <p class="text-h3 text-content-primary">
      Risk parameters
    </p>
    <div class="flex flex-col items-start gap-24">
      <VaultOverviewLabelValue
        v-if="isBorrowable"
        :value="`0-${vault.maxLiquidationDiscount / 100n}%`"
        orientation="horizontal"
      >
        <template #label>
          <span class="flex items-center gap-4">
            Liquidation bonus
            <UiFootnote
              title="Liquidation Bonus"
              text="The discount a liquidator receives on collateral when liquidating an unhealthy position. The actual bonus scales dynamically from 0% up to this maximum based on how unhealthy the position is. A more unhealthy position offers a larger bonus to incentivise faster liquidation."
              class="[--ui-footnote-icon-color:var(--text-muted)] hover:[--ui-footnote-icon-color:var(--text-secondary)]"
            />
          </span>
        </template>
      </VaultOverviewLabelValue>
      <VaultOverviewLabelValue
        label="Supply cap"
        orientation="horizontal"
      >
        <div class="flex gap-4 items-center">
          <span>
            {{ supplyCapDisplay }}
            <span v-if="vault.supplyCap < maxUint256">({{ compactNumber(supplyCapPercentageDisplay, 2) }}%)</span>
          </span>
          <UiRadialProgress
            v-if="vault.supplyCap < maxUint256"
            :value="supplyCapPercentageDisplay"
            :max="100"
          />
        </div>
      </VaultOverviewLabelValue>
      <VaultOverviewLabelValue
        v-if="isBorrowable"
        label="Borrow cap"
        orientation="horizontal"
      >
        <div class="flex gap-4 items-center">
          <span>
            {{ borrowCapDisplay }}
            <span v-if="vault.borrowCap < maxUint256">({{ compactNumber(borrowCapPercentageDisplay, 2) }}%)</span>
          </span>
          <UiRadialProgress
            v-if="vault.borrowCap < maxUint256"
            :value="borrowCapPercentageDisplay"
            :max="100"
          />
        </div>
      </VaultOverviewLabelValue>
      <VaultOverviewLabelValue
        label="Share token exchange rate"
        orientation="horizontal"
      >
        <template v-if="shareTokenExchangeRate !== undefined">
          {{ formatNumber(nanoToValue(shareTokenExchangeRate, vault.decimals), 6, 2) }}
        </template>
        <template v-else>
          -
        </template>
      </VaultOverviewLabelValue>
      <VaultOverviewLabelValue
        v-if="isBorrowable"
        :value="vault.configFlags === 0n ? 'Yes' : 'No'"
        orientation="horizontal"
      >
        <template #label>
          <span class="flex items-center gap-4">
            Bad debt socialisation
            <UiFootnote
              title="Bad Debt Socialisation"
              text="When enabled, if a liquidated position has remaining debt but no collateral left, the loss is spread across all depositors by reducing the share token value. This prevents bad debt from accumulating in the vault. When disabled, bad debt remains in the system indefinitely."
              class="[--ui-footnote-icon-color:var(--text-muted)] hover:[--ui-footnote-icon-color:var(--text-secondary)]"
            />
          </span>
        </template>
      </VaultOverviewLabelValue>
      <VaultOverviewLabelValue
        v-if="isBorrowable"
        label="Interest fee"
        :value="`${formatNumber(nanoToValue(vault.interestFee, 2))}%`"
        orientation="horizontal"
      />
      <VaultOverviewLabelValue orientation="horizontal">
        <template #label>
          <span class="flex items-center gap-4">
            {{ hooksRowLabel }}
            <button
              v-if="showHooksInfoIcon"
              type="button"
              :aria-label="`${hooksRowLabel} details`"
              class="inline-flex shrink-0 outline-none text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
              @click="openHooksModal"
            >
              <SvgIcon
                class="!w-16 !h-16"
                name="info-circle"
              />
            </button>
          </span>
        </template>
        {{ hooksRowValue }}
      </VaultOverviewLabelValue>
    </div>
  </div>
</template>
