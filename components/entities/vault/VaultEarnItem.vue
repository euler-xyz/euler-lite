<script setup lang="ts">
import { useAccount } from '@wagmi/vue'
import type { EarnVault } from '~/entities/vault'
import { formatAssetValue } from '~/services/pricing/priceProvider'
import { useEulerProductOfVault, useEulerEntitiesOfEarnVault } from '~/composables/useEulerLabels'
import { isVaultFeatured } from '~/utils/eulerLabelsUtils'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { isVaultBlockedByCountry } from '~/composables/useGeoBlock'
import { formatNumber, formatCompactUsdValue } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import BaseLoadableContent from '~/components/base/BaseLoadableContent.vue'
import { useModal } from '~/components/ui/composables/useModal'
import { VaultSupplyApyModal } from '#components'

const { isConnected } = useAccount()
const { vault } = defineProps<{ vault: EarnVault }>()
const product = useEulerProductOfVault(vault.address)
const { enableEntityBranding } = useDeployConfig()
const { isEarnVaultOwnerVerified } = useVaults()
const entities = useEulerEntitiesOfEarnVault(vault)
const isOwnerVerified = computed(() => isEarnVaultOwnerVerified(vault))
const entityName = computed(() => {
  if (!isOwnerVerified.value || entities.length === 0) return ''
  if (entities.length === 1) return entities[0].name
  if (entities.length === 2) return `${entities[0].name} & ${entities[1].name}`
  return `${entities[0].name} & others`
})
const entityLogos = computed(() => {
  if (!entityName.value || entities.length === 0) return []
  return entities.map(e => getEulerLabelEntityLogo(e.logo))
})
const { getBalance, isLoading: isBalancesLoading } = useWallets()
const { getIntrinsicApy, getIntrinsicApyInfo } = useIntrinsicApy()
const { getSupplyRewardApy, hasSupplyRewards, getSupplyRewardCampaigns } = useRewardsApy()
const modal = useModal()

const balance = computed(() =>
  getBalance(vault.asset.address as `0x${string}`),
)
const totalRewardsAPY = computed(() => getSupplyRewardApy(vault.address))
const hasRewards = computed(() => hasSupplyRewards(vault.address))
const isGeoBlocked = computed(() => isVaultBlockedByCountry(vault.address))
const isFeatured = computed(() => isVaultFeatured(vault.address))
const isUnverified = computed(() => !vault.verified)
const displayName = computed(() => product.name || vault.name)

const prices = ref<{ totalSupply: string, liquidity: string, walletBalance: string }>({
  totalSupply: '-',
  liquidity: '-',
  walletBalance: '-',
})

watchEffect(async () => {
  const walletBal = balance.value
  const [supplyResult, liquidityResult, walletResult] = await Promise.all([
    formatAssetValue(vault.totalAssets, vault, 'off-chain'),
    formatAssetValue(vault.availableAssets, vault, 'off-chain'),
    formatAssetValue(walletBal, vault, 'off-chain'),
  ])
  prices.value = {
    totalSupply: supplyResult.hasPrice ? formatCompactUsdValue(supplyResult.usdValue) : supplyResult.display,
    liquidity: liquidityResult.hasPrice ? formatCompactUsdValue(liquidityResult.usdValue) : liquidityResult.display,
    walletBalance: walletResult.hasPrice ? formatCompactUsdValue(walletResult.usdValue) : walletResult.display,
  }
})

const onSupplyInfoIconClick = (event: MouseEvent) => {
  event.preventDefault()
  event.stopPropagation()
  modal.open(VaultSupplyApyModal, {
    props: {
      lendingAPY: nanoToValue(vault.interestRateInfo.supplyAPY, 25),
      intrinsicAPY: getIntrinsicApy(vault.asset.address),
      intrinsicApyInfo: getIntrinsicApyInfo(vault.asset.address),
      campaigns: getSupplyRewardCampaigns(vault.address),
    },
  })
}
</script>

<template>
  <NuxtLink
    class="grid items-center gap-x-16 py-16 px-20 mobile:block no-underline border-b border-line-default last:border-b-0 transition-all duration-default ease-default hover:bg-card-hover"
    :class="[
      enableEntityBranding ? 'grid-cols-[2fr_repeat(4,1fr)]' : 'grid-cols-[2fr_repeat(3,1fr)]',
      isGeoBlocked ? 'opacity-50' : '',
    ]"
    :to="`/earn/${vault.address}`"
  >
    <!-- Asset -->
    <div class="flex items-center mobile:mb-12">
      <SvgIcon
        v-if="isFeatured"
        name="star"
        class="!w-16 !h-16 text-accent-600 mr-4 shrink-0"
        title="Featured Vault"
      />
      <AssetAvatar
        :asset="vault.asset"
        size="30"
      />
      <div class="flex-grow ml-12 min-w-0">
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
    </div>

    <!-- Desktop stats (single row) -->
    <div class="flex items-center gap-4 mobile:!hidden">
      <div class="text-p2 flex items-center text-accent-600">
        <div class="mr-6">
          <VaultPoints :vault="vault" />
        </div>
        <SvgIcon
          v-if="hasRewards"
          class="!w-20 !h-20 text-accent-600 mr-4 cursor-pointer"
          name="sparks"
          @click="onSupplyInfoIconClick"
        />
        {{ formatNumber(nanoToValue(vault.interestRateInfo.supplyAPY, 25) + totalRewardsAPY) }}%
      </div>
      <SvgIcon
        class="!w-16 !h-16 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
        name="info-circle"
        @click="onSupplyInfoIconClick"
      />
    </div>

    <div
      v-if="enableEntityBranding"
      class="mobile:!hidden"
    >
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
        class="text-p2 text-content-primary tabular-nums"
      >-</div>
    </div>

    <div class="mobile:!hidden">
      <div class="text-p2 text-content-primary">
        {{ prices.totalSupply }}
      </div>
    </div>

    <div class="flex items-center justify-end mobile:!hidden">
      <div class="text-p2 text-content-primary">
        {{ prices.liquidity }}
      </div>
    </div>

    <!-- Mobile layout -->
    <div class="hidden mobile:!flex mobile:py-12 mobile:justify-between mobile:border-b mobile:border-line-subtle">
      <div>
        <div class="text-content-tertiary text-p3 mb-4 flex items-center gap-4">
          Supply APY
          <SvgIcon
            class="!w-16 !h-16 text-content-muted"
            name="info-circle"
          />
        </div>
        <div class="text-p2 flex items-center text-accent-600 tabular-nums">
          <div class="mr-6">
            <VaultPoints :vault="vault" />
          </div>
          <SvgIcon
            v-if="hasRewards"
            class="!w-20 !h-20 text-accent-600 mr-4"
            name="sparks"
          />
          {{ formatNumber(nanoToValue(vault.interestRateInfo.supplyAPY, 25) + totalRewardsAPY) }}%
        </div>
      </div>
      <div class="flex flex-col items-end">
        <div class="text-content-tertiary text-p3 mb-4">Total supply</div>
        <div class="text-p2 text-content-primary">
          {{ prices.totalSupply }}
        </div>
      </div>
    </div>

    <div class="hidden mobile:!flex mobile:flex-col gap-12 py-12 pb-16">
      <div class="flex w-full justify-between">
        <div class="text-content-tertiary text-p3">Available liquidity</div>
        <div class="text-p2 text-content-primary">
          {{ prices.liquidity }}
        </div>
      </div>
      <div
        v-if="enableEntityBranding"
        class="flex w-full justify-between"
      >
        <div class="text-content-tertiary text-p3">Capital allocator</div>
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
            class="text-p2 text-content-primary tabular-nums"
          >-</div>
        </div>
      </div>
      <div
        v-if="isConnected"
        class="flex w-full justify-between"
      >
        <div class="text-content-tertiary text-p3">In wallet</div>
        <div class="flex gap-8 justify-end items-center text-right flex-1">
          <BaseLoadableContent
            :loading="isBalancesLoading"
            style="min-width: 70px; height: 20px"
          >
            <div class="text-p2 text-content-primary tabular-nums whitespace-nowrap">
              {{ prices.walletBalance }}
            </div>
          </BaseLoadableContent>
        </div>
      </div>
    </div>
  </NuxtLink>
</template>
