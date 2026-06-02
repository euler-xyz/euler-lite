<script setup lang="ts">
import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { maxUint256, type Address } from 'viem'
import { vaultConvertToAssetsAbi } from '~/abis/vault'
import { formatNumber, compactNumber, formatCompactUsdValue } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'

import { formatAssetValue } from '~/utils/sdk-prices'
import { formatHookedOpsSummary, getHookedOperationMetas, getVaultHookedOperations, hasAnyHookedOperation, isHookDisabling, isVaultEffectivelyPaused } from '~/utils/vault-hooks'
import { isVaultBorrowable } from '~/utils/vault/classification'
import { VaultHooksInfoModal } from '#components'

const { vault } = defineProps<{ vault: EVault }>()

const { client: rpcClient } = useRpcClient()
const { getVaultCategory } = useVaultRegistry()

const shareTokenExchangeRate: Ref<bigint | undefined> = ref()

// Borrow-side risk params stay visible while debt is being wound down — not
// just while new borrows are allowed (see isVaultBorrowable).
const isBorrowable = computed(() => isVaultBorrowable(vault))

const supplyCapPercentageDisplay = computed(() => vault.caps.supplyCapUtilization)
const borrowCapPercentageDisplay = computed(() => vault.caps.borrowCapUtilization)
const hookedOperations = computed(() => getVaultHookedOperations(vault))
const maxLiquidationDiscountPercent = computed(() => {
  return vault.liquidation.maxLiquidationDiscount * 100
})
const showShareTokenExchangeRate = computed(() =>
  getVaultCategory(vault.address) !== 'escrow'
  && (vault.caps.borrowCap !== 0n || vault.totalBorrowed > 0n),
)

const supplyCapDisplay = ref('-')
const borrowCapDisplay = ref('-')

watchEffect(async () => {
  if (vault.caps.supplyCap >= maxUint256) {
    supplyCapDisplay.value = '∞'
    return
  }
  if (vault.caps.supplyCap === 0n) {
    supplyCapDisplay.value = '$0'
    return
  }
  const price = await formatAssetValue(vault.caps.supplyCap, vault, 'off-chain')
  supplyCapDisplay.value = price.hasPrice ? formatCompactUsdValue(price.usdValue) : price.display
})

watchEffect(async () => {
  if (vault.caps.borrowCap >= maxUint256) {
    borrowCapDisplay.value = '∞'
    return
  }
  if (vault.caps.borrowCap === 0n) {
    borrowCapDisplay.value = '$0'
    return
  }
  const price = await formatAssetValue(vault.caps.borrowCap, vault, 'off-chain')
  borrowCapDisplay.value = price.hasPrice ? formatCompactUsdValue(price.usdValue) : price.display
})

const load = async () => {
  if (!showShareTokenExchangeRate.value) return

  const client = rpcClient.value!
  shareTokenExchangeRate.value = await client.readContract({
    address: vault.address as Address,
    abi: vaultConvertToAssetsAbi,
    functionName: 'convertToAssets',
    args: [1n * 10n ** BigInt(vault.shares.decimals)],
  }) as bigint
}

load()

const hookedUserOps = computed(() => getHookedOperationMetas(hookedOperations.value))

const hooksRowLabel = computed(() =>
  isHookDisabling(vault) ? 'Disabled operations' : 'Hooked operations',
)

const hooksRowValue = computed(() => {
  if (!hasAnyHookedOperation(hookedOperations.value)) return 'None'
  if (isVaultEffectivelyPaused(vault)) return 'Paused'
  return formatHookedOpsSummary(hookedUserOps.value)
})

const showHooksInfoIcon = computed(() => hasAnyHookedOperation(hookedOperations.value))

const hooksModalData = computed(() => ({
  props: { vault },
}))
</script>

<template>
  <div class="bg-surface-secondary rounded-xl flex flex-col gap-24 p-24 shadow-card">
    <p class="text-h3 text-content-primary">
      Risk parameters
    </p>
    <div class="flex flex-col items-start gap-24">
      <VaultOverviewLabelValue
        v-if="isBorrowable"
        :value="`0-${maxLiquidationDiscountPercent}%`"
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
            <span v-if="vault.caps.supplyCap < maxUint256">({{ compactNumber(supplyCapPercentageDisplay, 2) }}%)</span>
          </span>
          <UiRadialProgress
            v-if="vault.caps.supplyCap < maxUint256"
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
            <span v-if="vault.caps.borrowCap < maxUint256">({{ compactNumber(borrowCapPercentageDisplay, 2) }}%)</span>
          </span>
          <UiRadialProgress
            v-if="vault.caps.borrowCap < maxUint256"
            :value="borrowCapPercentageDisplay"
            :max="100"
          />
        </div>
      </VaultOverviewLabelValue>
      <VaultOverviewLabelValue
        v-if="showShareTokenExchangeRate"
        label="Share token exchange rate"
        orientation="horizontal"
      >
        <template v-if="shareTokenExchangeRate !== undefined">
          {{ formatNumber(nanoToValue(shareTokenExchangeRate, vault.asset.decimals), 6, 2) }}
        </template>
        <template v-else>
          -
        </template>
      </VaultOverviewLabelValue>
      <VaultOverviewLabelValue
        v-if="isBorrowable"
        :value="vault.liquidation.socializeDebt ? 'Yes' : 'No'"
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
        :value="`${formatNumber(vault.fees.interestFee * 100)}%`"
        orientation="horizontal"
      />
      <VaultOverviewLabelValue orientation="horizontal">
        <template #label>
          <span class="flex items-center gap-4">
            {{ hooksRowLabel }}
            <UiModalPreviewTrigger
              v-if="showHooksInfoIcon"
              :component="VaultHooksInfoModal"
              :modal-data="hooksModalData"
              :aria-label="`${hooksRowLabel} details`"
            >
              <SvgIcon
                class="!w-16 !h-16 shrink-0 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
                name="info-circle"
              />
            </UiModalPreviewTrigger>
          </span>
        </template>
        {{ hooksRowValue }}
      </VaultOverviewLabelValue>
    </div>
  </div>
</template>
