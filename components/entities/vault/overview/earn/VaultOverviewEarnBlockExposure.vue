<script setup lang="ts">
import { getAddress } from 'viem'
import { DateTime } from 'luxon'
import { logWarn } from '~/utils/errorHandling'
import type { EarnVault, EarnVaultStrategyInfo, Vault } from '~/entities/vault'
import { getAssetUsdValueOrZero } from '~/services/pricing/priceProvider'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { formatNumber, compactNumber, formatCompactUsdValue } from '~/utils/string-utils'
import { nanoToValue, roundAndCompactTokens } from '~/utils/crypto-utils'
import { useModal } from '~/components/ui/composables/useModal'
import { VaultSupplyApyModal } from '#components'
import { getStrategyHookWarning } from '~/composables/useVaultWarnings'

const emits = defineEmits<{
  'vault-click': [address: string]
}>()

const onExposureClick = (address: string) => {
  emits('vault-click', address)
}
const { vault } = defineProps<{ vault: EarnVault }>()

const { getOrFetch } = useVaultRegistry()
const { isEscrowLoadedOnce } = useVaults()
const { withIntrinsicSupplyApy, getIntrinsicApy, getIntrinsicApyInfo } = useIntrinsicApy()
const { getSupplyRewardApy, hasSupplyRewards, getSupplyRewardCampaigns } = useRewardsApy()
const modal = useModal()

const exposureVaults: Ref<Vault[]> = ref([])
const isLoading = ref(false)
const exposureUsdPrices = ref<Map<string, number>>(new Map())
const exposureCapUsdPrices = ref<Map<string, number>>(new Map())

const UINT136_MAX = 2n ** 136n - 1n

const isPendingRemoval = (strategy: EarnVaultStrategyInfo) => strategy.removableAt > 0n

const isUnlimitedCap = (strategy: EarnVaultStrategyInfo) => strategy.currentAllocationCap >= UINT136_MAX

const getPendingRemovalTooltipText = (strategy: EarnVaultStrategyInfo) => {
  const removableAt = DateTime.fromSeconds(Number(strategy.removableAt))
  return `This strategy is pending removal. Removable ${removableAt.toRelative({ base: DateTime.now(), style: 'short' })}.`
}

const exposureList = computed(() => {
  return [...vault.strategies].sort((a, b) => {
    return nanoToValue(b.allocatedAssets) - nanoToValue(a.allocatedAssets)
  })
})

const totalAllocatedAssets = computed(() => {
  return exposureList.value.reduce((prev, curr) => {
    return prev + curr.allocatedAssets
  }, 0n)
})

const load = async () => {
  try {
    isLoading.value = true
    // Wait for escrow vaults to load first, so they're properly identified in registry
    await until(isEscrowLoadedOnce).toBe(true)
    const promises = exposureList.value.map((exposure) => {
      return getOrFetch(exposure.info.vault) as Promise<Vault>
    })
    exposureVaults.value = (await Promise.all(promises)).filter(Boolean)

    // Load USD prices for all exposures
    await loadExposureUsdPrices()
  }
  catch (e) {
    logWarn('VaultOverviewEarnBlockExposure/loadExposure', e)
  }
  finally {
    isLoading.value = false
  }
}

const loadExposureUsdPrices = async () => {
  const pricePromises = exposureList.value.map(async (exposure) => {
    const exposureVault = getExposureVaultByAddress(exposure.info.vault)
    if (!exposureVault) return { key: exposure.strategy, allocationUsd: 0, capUsd: 0 }
    const [allocationUsd, capUsd] = await Promise.all([
      getAssetUsdValueOrZero(exposure.allocatedAssets, exposureVault, 'off-chain'),
      isUnlimitedCap(exposure)
        ? Promise.resolve(0)
        : getAssetUsdValueOrZero(exposure.currentAllocationCap, exposureVault, 'off-chain'),
    ])
    return { key: exposure.strategy, allocationUsd, capUsd }
  })

  const results = await Promise.all(pricePromises)
  const newPrices = new Map<string, number>()
  const newCapPrices = new Map<string, number>()
  results.forEach(({ key, allocationUsd, capUsd }) => {
    newPrices.set(key, allocationUsd)
    newCapPrices.set(key, capUsd)
  })
  exposureUsdPrices.value = newPrices
  exposureCapUsdPrices.value = newCapPrices
}

const getExposureVaultByAddress = (address: string) => {
  const normalized = getAddress(address)
  return exposureVaults.value.find(vlt => normalized === getAddress(vlt.address))
}

const exposureRows = computed(() => {
  return exposureList.value.map((exposure) => {
    const strategyVault = getExposureVaultByAddress(exposure.info.vault)
    return {
      exposure,
      vault: strategyVault,
      hookWarning: strategyVault ? getStrategyHookWarning(strategyVault) : null,
    }
  })
})

const getAllocationPercentage = (exposure: EarnVaultStrategyInfo) => {
  if (totalAllocatedAssets.value === 0n) return 0
  return Number(exposure.allocatedAssets) / Number(totalAllocatedAssets.value) * 100
}

const getStrategySupplyApy = (strategyVault: Vault) => {
  const lendingAPY = nanoToValue(strategyVault.interestRateInfo.supplyAPY, 25)
  const supplyApy = withIntrinsicSupplyApy(lendingAPY, strategyVault.asset.address)
  return supplyApy + getSupplyRewardApy(strategyVault.address)
}

const onStrategySupplyInfoClick = (event: MouseEvent, strategyVault: Vault) => {
  event.preventDefault()
  event.stopPropagation()
  const lendingAPY = nanoToValue(strategyVault.interestRateInfo.supplyAPY, 25)
  modal.open(VaultSupplyApyModal, {
    props: {
      lendingAPY,
      intrinsicAPY: getIntrinsicApy(strategyVault.asset.address),
      intrinsicApyInfo: getIntrinsicApyInfo(strategyVault.asset.address),
      campaigns: getSupplyRewardCampaigns(strategyVault.address),
    },
  })
}

const hasExposureUsdPrice = (exposure: typeof exposureList.value[0]) => {
  return exposureUsdPrices.value.has(exposure.strategy)
}

const getExposureUsdPrice = (exposure: typeof exposureList.value[0]) => {
  return exposureUsdPrices.value.get(exposure.strategy) || 0
}

const getExposureAssetAmount = (exposure: typeof exposureList.value[0]) => {
  return `${roundAndCompactTokens(exposure.allocatedAssets, exposure.info.assetDecimals)} ${exposure.info.assetSymbol}`
}

load()
</script>

<template>
  <div
    v-if="exposureList.length"
    class="bg-surface-secondary rounded-xl flex flex-col gap-24 p-24 shadow-card"
  >
    <div>
      <p class="text-h3 text-content-primary mb-12">
        Exposure
      </p>
    </div>

    <div
      v-if="isLoading"
      class="flex items-center justify-center py-32"
    >
      <UiLoader class="icon--48" />
    </div>

    <div
      v-else
      class="flex flex-col gap-12"
    >
      <div
        v-for="row in exposureRows"
        :key="row.exposure.strategy"
        class="bg-surface rounded-xl text-content-primary block no-underline cursor-pointer shadow-card hover:shadow-card-hover transition-shadow border border-line-default"
        @click="onExposureClick(row.exposure.info.vault)"
      >
        <div
          class="px-16 pt-16 pb-12 border-b border-line-subtle flex items-center justify-between"
        >
          <template v-if="row.vault">
            <VaultLabelsAndAssets
              :vault="row.vault"
              :assets="[{
                address: row.exposure.info.asset,
                decimals: row.exposure.info.assetDecimals,
                name: row.exposure.info.assetName,
                symbol: row.exposure.info.assetSymbol,
              }]"
            >
              <span
                v-if="row.hookWarning"
                @click.stop.prevent
              >
                <VaultWarningIcon :warning="row.hookWarning" />
              </span>
            </VaultLabelsAndAssets>
          </template>
          <template v-else>
            <div class="flex items-center gap-12">
              <AssetAvatar
                :asset="{ address: row.exposure.info.asset, symbol: row.exposure.info.assetSymbol }"
                size="40"
              />
              <div>
                <div class="text-content-tertiary text-p3">
                  {{ row.exposure.info.vaultName }}
                </div>
                <div class="text-h5 text-content-primary">
                  {{ row.exposure.info.assetSymbol }}
                </div>
              </div>
            </div>
          </template>
          <div
            v-if="row.vault"
            class="flex flex-col items-end shrink-0"
          >
            <div class="text-content-tertiary text-p3 mb-4 flex items-center gap-4">
              Supply APY
              <SvgIcon
                class="!w-16 !h-16 shrink-0 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
                name="info-circle"
                @click="onStrategySupplyInfoClick($event, row.vault)"
              />
            </div>
            <div class="text-p2 flex items-center text-accent-600 font-semibold">
              <SvgIcon
                v-if="hasSupplyRewards(row.vault.address)"
                class="!w-20 !h-20 text-accent-500 mr-4 cursor-pointer"
                name="sparks"
                @click="onStrategySupplyInfoClick($event, row.vault)"
              />
              {{ formatNumber(getStrategySupplyApy(row.vault)) }}%
            </div>
          </div>
        </div>
        <div class="flex flex-col gap-12 px-16 pt-12 pb-16">
          <VaultOverviewLabelValue
            label="Current allocation"
            orientation="horizontal"
          >
            <template v-if="hasExposureUsdPrice(row.exposure)">
              {{ formatCompactUsdValue(getExposureUsdPrice(row.exposure)) }}
              <span class="text-content-secondary">({{ compactNumber(getAllocationPercentage(row.exposure), 2) }}%)</span>
            </template>
            <template v-else>
              {{ getExposureAssetAmount(row.exposure) }}
              <span class="text-content-secondary">({{ compactNumber(getAllocationPercentage(row.exposure), 2) }}%)</span>
            </template>
          </VaultOverviewLabelValue>
          <VaultOverviewLabelValue
            orientation="horizontal"
          >
            <template #label>
              <span class="flex items-center gap-4">
                Allocation cap
                <span @click.stop.prevent>
                  <UiFootnote
                    title="Allocation cap"
                    text="The maximum amount that can be allocated to this strategy."
                    class="footnote-info [--ui-footnote-icon-color:var(--text-muted)] hover:[--ui-footnote-icon-color:var(--text-secondary)]"
                  />
                </span>
              </span>
            </template>
            <span class="flex items-center gap-4">
              <span
                v-if="isPendingRemoval(row.exposure)"
                @click.stop.prevent
              >
                <UiFootnote
                  icon="clock"
                  title="Pending removal"
                  :text="getPendingRemovalTooltipText(row.exposure)"
                  class="footnote-clock [--ui-footnote-icon-color:var(--warning-500)]"
                />
              </span>
              <template v-if="isUnlimitedCap(row.exposure)">
                ∞
              </template>
              <template v-else-if="exposureCapUsdPrices.has(row.exposure.strategy)">
                {{ formatCompactUsdValue(exposureCapUsdPrices.get(row.exposure.strategy) || 0) }}
              </template>
              <template v-else>
                {{ roundAndCompactTokens(row.exposure.currentAllocationCap, row.exposure.info.assetDecimals) }} {{ row.exposure.info.assetSymbol }}
              </template>
            </span>
          </VaultOverviewLabelValue>
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.footnote-info:deep(.ui-footnote__icon) {
  width: 20px;
  height: 20px;
}

.footnote-info {
  width: 20px;
  height: 20px;
}

.footnote-clock:deep(.ui-footnote__icon) {
  width: 14px;
  height: 14px;
}

.footnote-clock {
  width: 14px;
  height: 14px;
}
</style>
