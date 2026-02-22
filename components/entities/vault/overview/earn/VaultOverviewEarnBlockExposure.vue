<script setup lang="ts">
import { getAddress } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import type { EarnVault, Vault } from '~/entities/vault'
import { getAssetUsdValueOrZero } from '~/services/pricing/priceProvider'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { formatNumber, formatCompactUsdValue } from '~/utils/string-utils'
import { nanoToValue, roundAndCompactTokens } from '~/utils/crypto-utils'

const emits = defineEmits<{
  'vault-click': [address: string]
}>()

const onExposureClick = (address: string) => {
  emits('vault-click', address)
}
const { vault } = defineProps<{ vault: EarnVault }>()

const { getOrFetch } = useVaultRegistry()
const { isEscrowLoadedOnce } = useVaults()

const exposureVaults: Ref<Vault[]> = ref([])
const isLoading = ref(false)
const exposureUsdPrices = ref<Map<string, number>>(new Map())

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
    if (!exposureVault) return { key: exposure.strategy, value: 0 }
    const usdValue = await getAssetUsdValueOrZero(exposure.allocatedAssets, exposureVault, 'off-chain')
    return { key: exposure.strategy, value: usdValue }
  })

  const results = await Promise.all(pricePromises)
  const newPrices = new Map<string, number>()
  results.forEach(({ key, value }) => newPrices.set(key, value))
  exposureUsdPrices.value = newPrices
}

const getExposureVaultByAddress = (address: string) => {
  const normalized = getAddress(address)
  return exposureVaults.value.find(vlt => normalized === getAddress(vlt.address))
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
    class="flex flex-col gap-24 p-24 border-b border-line-default last:border-b-0"
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
        v-for="exposure in exposureList"
        :key="exposure.strategy"
        class="bg-surface rounded-xl text-content-primary block no-underline cursor-pointer shadow-card hover:shadow-card-hover transition-shadow border border-line-default"
        @click="onExposureClick(exposure.info.vault)"
      >
        <div
          class="px-16 pt-16 pb-12 border-b border-line-subtle"
        >
          <VaultLabelsAndAssets
            :vault="getExposureVaultByAddress(exposure.info.vault) as Vault"
            :assets="[{
              address: exposure.info.asset,
              decimals: exposure.info.assetDecimals,
              name: exposure.info.assetName,
              symbol: exposure.info.assetSymbol,
            }]"
          />
        </div>
        <div class="flex flex-col gap-12 px-16 pt-12 pb-16">
          <VaultOverviewLabelValue
            label="Allocation (%)"
            orientation="horizontal"
            :value="`${formatNumber(Number(exposure.allocatedAssets) / Number(totalAllocatedAssets) * 100, 2)}%`"
          />
          <VaultOverviewLabelValue
            label="Allocation ($)"
            orientation="horizontal"
          >
            <template v-if="hasExposureUsdPrice(exposure)">
              {{ formatCompactUsdValue(getExposureUsdPrice(exposure)) }}
            </template>
            <template v-else>
              {{ getExposureAssetAmount(exposure) }}
            </template>
          </VaultOverviewLabelValue>
        </div>
      </div>
    </div>
  </div>
</template>
