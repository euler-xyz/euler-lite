<script setup lang="ts">
import { useAccount } from '@wagmi/vue'
import type { Vault, SecuritizeVault } from '~/entities/vault'
import { formatAssetValue } from '~/services/pricing/priceProvider'
import { isVaultBlockedByCountry } from '~/composables/useGeoBlock'
import { useEulerProductOfVault, useEulerEntitiesOfVault } from '~/composables/useEulerLabels'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { formatNumber, formatCompactUsdValue } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import BaseLoadableContent from '~/components/base/BaseLoadableContent.vue'

const { isConnected } = useAccount()
const { vault } = defineProps<{ vault: SecuritizeVault }>()

const vaultAddress = computed(() => vault.address)
const product = useEulerProductOfVault(vaultAddress)
const { enableEntityBranding } = useDeployConfig()
const { isVaultGovernorVerified } = useVaults()
// SecuritizeVault has governorAdmin, safe to cast for entity lookup
const entities = useEulerEntitiesOfVault(vault as unknown as Vault)

const isUnverified = computed(() => !vault.verified)
const isGovernorVerified = computed(() => isVaultGovernorVerified(vault as unknown as Vault))
const entityName = computed(() => {
  if (!isGovernorVerified.value || entities.length === 0) return ''
  if (entities.length === 1) return entities[0].name
  if (entities.length === 2) return `${entities[0].name} & ${entities[1].name}`
  return `${entities[0].name} & others`
})
const entityLogos = computed(() => {
  if (!entityName.value || entities.length === 0) return []
  return entities.map(e => getEulerLabelEntityLogo(e.logo))
})
const displayName = computed(() => product.name || vault.name)
const isGeoBlocked = computed(() => isVaultBlockedByCountry(vault.address))

const { getBalance, isLoading: isBalancesLoading } = useWallets()
const { withIntrinsicSupplyApy } = useIntrinsicApy()
const { getSupplyRewardApy, hasSupplyRewards } = useRewardsApy()

const balance = computed(() =>
  getBalance(vault.asset.address as `0x${string}`),
)
const totalRewardsAPY = computed(() => getSupplyRewardApy(vault.address))
const hasRewards = computed(() => hasSupplyRewards(vault.address))
const lendingAPY = computed(() =>
  nanoToValue(vault.interestRateInfo.supplyAPY, 25),
)
const supplyApy = computed(() =>
  withIntrinsicSupplyApy(lendingAPY.value, vault.asset.address),
)
const supplyApyWithRewards = computed(
  () => supplyApy.value + totalRewardsAPY.value,
)

const prices = ref<{ totalSupply: string, walletBalance: string }>({
  totalSupply: '-',
  walletBalance: '-',
})

watchEffect(async () => {
  const walletBal = balance.value
  const [supplyResult, walletResult] = await Promise.all([
    formatAssetValue(vault.totalAssets, vault, 'off-chain'),
    formatAssetValue(walletBal, vault, 'off-chain'),
  ])
  prices.value = {
    totalSupply: supplyResult.hasPrice ? formatCompactUsdValue(supplyResult.usdValue) : supplyResult.display,
    walletBalance: walletResult.hasPrice ? formatCompactUsdValue(walletResult.usdValue) : walletResult.display,
  }
})
</script>

<template>
  <NuxtLink
    class="block no-underline text-content-primary bg-surface rounded-12 border border-line-default hover:shadow-card-hover hover:border-line-emphasis transition-all"
    :class="isGeoBlocked ? 'opacity-50' : ''"
    :to="`/lend/${vault.address}`"
  >
    <div class="flex pb-12 p-16 border-b border-line-subtle">
      <AssetAvatar
        :asset="vault.asset"
        size="40"
      />
      <div class="flex-grow ml-12">
        <div class="text-content-tertiary text-p3 mb-4 flex items-center gap-8">
          <VaultDisplayName
            :name="displayName"
            :is-unverified="isUnverified"
          />
          <span
            v-if="isGeoBlocked"
            class="inline-flex items-center gap-4 rounded-8 px-8 py-2 bg-warning-100 text-warning-500 text-p5"
            title="This vault is not available in your region"
          >
            <SvgIcon
              name="warning"
              class="!w-14 !h-14"
            />
            Restricted
          </span>
        </div>
        <div class="text-h5 text-content-primary">
          {{ vault.asset.symbol }}
        </div>
      </div>
      <div class="flex flex-col items-end">
        <div class="text-content-tertiary text-p3 mb-4 text-right">
          Supply APY
        </div>
        <div class="flex items-center">
          <div class="text-p2 flex items-center text-accent-600 font-semibold">
            <SvgIcon
              v-if="hasRewards"
              class="!w-20 !h-20 text-accent-500 mr-4"
              name="sparks"
            />
            {{ formatNumber(supplyApyWithRewards) }}%
          </div>
        </div>
      </div>
    </div>
    <div
      class="flex-1 flex py-12 px-16 pb-12 justify-between mobile:border-b mobile:border-line-subtle"
    >
      <div
        v-if="enableEntityBranding"
        class="flex-1 mr-16"
      >
        <div class="text-content-tertiary text-p3 mb-4">Risk manager</div>
        <div
          v-if="entityName"
          class="flex items-center gap-6"
        >
          <BaseAvatar
            class="icon--20"
            :label="entityName"
            :src="entityLogos"
          />
          <span class="text-p2 text-content-primary truncate">{{ entityName }}</span>
        </div>
        <div
          v-else
          class="text-p2 text-content-primary"
        >-</div>
      </div>
      <div class="flex-1">
        <div class="text-content-tertiary text-p3 mb-4">
          Total supply
        </div>
        <div class="text-p2 text-content-primary">
          {{ prices.totalSupply }}
        </div>
      </div>
      <div
        v-if="isConnected"
        class="flex flex-col flex-1 items-end text-right mobile:!hidden"
      >
        <div class="text-content-tertiary text-p3 mb-4">In wallet</div>
        <BaseLoadableContent
          :loading="isBalancesLoading"
          style="min-width: 70px; height: 20px"
        >
          <div class="text-p2 text-content-primary whitespace-nowrap">
            {{ prices.walletBalance }}
          </div>
        </BaseLoadableContent>
      </div>
    </div>
    <div class="hidden mobile:flex mobile:flex-col gap-12 py-12 px-16 pb-16">
      <div
        v-if="enableEntityBranding"
        class="flex w-full justify-between"
      >
        <div class="flex-1">
          <div class="text-content-tertiary text-p3">Risk manager</div>
        </div>
        <div class="flex gap-8 justify-end items-center text-right flex-1">
          <template v-if="entityName">
            <BaseAvatar
              class="icon--20"
              :label="entityName"
              :src="entityLogos"
            />
            <span class="text-p2 text-content-primary truncate">{{ entityName }}</span>
          </template>
          <div
            v-else
            class="text-p2 text-content-primary"
          >-</div>
        </div>
      </div>
      <div
        v-if="isConnected"
        class="flex w-full justify-between"
      >
        <div class="flex-1">
          <div class="text-content-tertiary text-p3">In wallet</div>
        </div>
        <div class="flex gap-8 justify-end items-center text-right flex-1">
          <BaseLoadableContent
            :loading="isBalancesLoading"
            style="min-width: 70px; height: 20px"
          >
            <div class="text-p2 text-content-primary whitespace-nowrap">
              {{ prices.walletBalance }}
            </div>
          </BaseLoadableContent>
        </div>
      </div>
    </div>
  </NuxtLink>
</template>
