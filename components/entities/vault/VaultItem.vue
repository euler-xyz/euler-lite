<script setup lang="ts">
import { useAccount } from '@wagmi/vue'
import { getAddress } from 'viem'
import { getVaultUtilization, type Vault } from '~/entities/vault'
import { getUtilisationWarning, getSupplyCapWarning } from '~/composables/useVaultWarnings'
import { formatAssetValue } from '~/services/pricing/priceProvider'
import { useEulerProductOfVault, useEulerEntitiesOfVault } from '~/composables/useEulerLabels'
import { isVaultFeatured } from '~/utils/eulerLabelsUtils'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { isVaultBlockedByCountry } from '~/composables/useGeoBlock'
import { formatNumber, compactNumber, formatCompactUsdValue } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import BaseLoadableContent from '~/components/base/BaseLoadableContent.vue'
import { useModal } from '~/components/ui/composables/useModal'
import { VaultSupplyApyModal } from '#components'

const { isConnected } = useAccount()
const { vault } = defineProps<{ vault: Vault }>()
const vaultAddress = computed(() => vault.address)
const product = useEulerProductOfVault(vaultAddress)
const { enableEntityBranding } = useDeployConfig()
const { isVaultGovernorVerified } = useVaults()
const entities = useEulerEntitiesOfVault(vault)
const isUnverified = computed(() => !vault.verified)
const isGovernorVerified = computed(() => isVaultGovernorVerified(vault))
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
const isEscrow = computed(() => vault.vaultCategory === 'escrow')
const isBorrowable = computed(() => vault.vaultCategory !== 'escrow' && vault.collateralLTVs.some(ltv => ltv.borrowLTV > 0n))
const displayName = computed(() => {
  if (isEscrow.value) return 'Escrowed collateral'
  return product.name || vault.name
})
const { getBalance, isLoading: isBalancesLoading } = useWallets()
const { withIntrinsicSupplyApy, getIntrinsicApy, getIntrinsicApyInfo } = useIntrinsicApy()
const { getSupplyRewardApy, hasSupplyRewards, getSupplyRewardCampaigns } = useRewardsApy()
const modal = useModal()

const balance = computed(() =>
  getBalance(vault.asset.address as `0x${string}`),
)
const totalRewardsAPY = computed(() => getSupplyRewardApy(vault.address))
const hasRewards = computed(() => hasSupplyRewards(vault.address))
const lendingAPY = computed(() =>
  nanoToValue(vault.interestRateInfo.supplyAPY, 25),
)
const intrinsicAPY = computed(() => getIntrinsicApy(vault.asset.address))
const supplyApy = computed(() =>
  withIntrinsicSupplyApy(lendingAPY.value, vault.asset.address),
)
const supplyApyWithRewards = computed(
  () => supplyApy.value + totalRewardsAPY.value,
)
const utilization = computed(() => getVaultUtilization(vault))
const isGeoBlocked = computed(() => isVaultBlockedByCountry(vault.address))
const isFeatured = computed(() => isVaultFeatured(vault.address))
const utilisationWarning = computed(() => getUtilisationWarning(vault, 'lend'))
const supplyCapWarning = computed(() => getSupplyCapWarning(vault))
const isDeprecated = computed(() => {
  try {
    const addr = getAddress(vault.address)
    return product.deprecatedVaults?.includes(addr) ?? false
  }
  catch {
    return product.deprecatedVaults?.includes(vault.address) ?? false
  }
})
const deprecationReason = computed(() =>
  isDeprecated.value ? product.deprecationReason : '',
)

const onSupplyInfoIconClick = (event: MouseEvent) => {
  event.preventDefault()
  event.stopPropagation()
  modal.open(VaultSupplyApyModal, {
    props: {
      lendingAPY: lendingAPY.value,
      intrinsicAPY: intrinsicAPY.value,
      intrinsicApyInfo: getIntrinsicApyInfo(vault.asset.address),
      campaigns: getSupplyRewardCampaigns(vault.address),
    },
  })
}

const prices = ref<{ totalSupply: string, liquidity: string, walletBalance: string }>({
  totalSupply: '-',
  liquidity: '-',
  walletBalance: '-',
})

watchEffect(async () => {
  const liquidity = vault.supply >= vault.borrow ? vault.supply - vault.borrow : 0n
  const walletBal = balance.value
  const [supplyResult, liquidityResult, walletResult] = await Promise.all([
    formatAssetValue(vault.totalAssets, vault, 'off-chain'),
    formatAssetValue(liquidity, vault, 'off-chain'),
    formatAssetValue(walletBal, vault, 'off-chain'),
  ])
  prices.value = {
    totalSupply: supplyResult.hasPrice ? formatCompactUsdValue(supplyResult.usdValue) : supplyResult.display,
    liquidity: liquidityResult.hasPrice ? formatCompactUsdValue(liquidityResult.usdValue) : liquidityResult.display,
    walletBalance: walletResult.hasPrice ? formatCompactUsdValue(walletResult.usdValue) : walletResult.display,
  }
})
</script>

<template>
  <NuxtLink
    class="grid items-center gap-x-16 py-16 px-20 mobile:block no-underline text-content-primary border-b border-line-default last:border-b-0 hover:bg-card-hover transition-all"
    :class="[
      enableEntityBranding ? 'grid-cols-[2fr_repeat(4,1fr)]' : 'grid-cols-[2fr_repeat(3,1fr)]',
      isGeoBlocked ? 'opacity-50' : '',
    ]"
    :to="`/lend/${vault.address}`"
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
          <span
            v-if="isDeprecated"
            class="inline-flex items-center gap-4 rounded-8 px-8 py-2 bg-warning-100 text-warning-500 text-p5"
            :title="deprecationReason || 'This vault has been deprecated.'"
          >
            <SvgIcon
              name="warning"
              class="!w-14 !h-14"
            />
            Deprecated
          </span>
        </div>
        <div class="text-h5 text-content-primary">
          {{ vault.asset.symbol }}
        </div>
      </div>
    </div>

    <!-- Desktop stats (single row) -->
    <div class="flex items-center gap-4 mobile:!hidden">
      <div class="mr-6">
        <VaultPoints :vault="vault" />
      </div>
      <div class="text-p2 flex items-center text-accent-600 font-semibold">
        <SvgIcon
          v-if="hasRewards"
          class="!w-20 !h-20 text-accent-500 mr-4 cursor-pointer"
          name="sparks"
          @click="onSupplyInfoIconClick"
        />
        {{ formatNumber(supplyApyWithRewards) }}%
      </div>
      <SvgIcon
        class="!w-16 !h-16 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
        name="info-circle"
        @click="onSupplyInfoIconClick"
      />
    </div>

    <div class="flex items-center gap-4 mobile:!hidden">
      <div class="text-p2 text-content-primary">
        {{ prices.totalSupply }}
      </div>
      <VaultWarningIcon
        :warning="supplyCapWarning"
        tooltip-placement="top-start"
      />
    </div>

    <div class="mobile:!hidden">
      <div
        v-if="isBorrowable"
        class="text-p2 text-content-primary"
      >
        {{ prices.liquidity }}
      </div>
      <div
        v-else
        class="text-p2 text-content-muted"
      >
        -
      </div>
    </div>

    <div
      v-if="enableEntityBranding"
      class="flex items-center justify-end gap-4 mobile:!hidden"
    >
      <template v-if="isBorrowable">
        <UiRadialProgress
          :value="utilization"
          :max="100"
        />
        <div class="text-p2 text-content-primary">
          {{ compactNumber(utilization, 2, 2) }}%
        </div>
        <VaultWarningIcon :warning="utilisationWarning" />
      </template>
      <div
        v-else
        class="text-p2 text-content-muted"
      >
        -
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
        <div class="flex items-center">
          <div class="mr-6">
            <VaultPoints :vault="vault" />
          </div>
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
      <div class="flex flex-col items-end">
        <div class="text-content-tertiary text-p3 mb-4">Total supply</div>
        <div class="text-p2 text-content-primary">
          {{ prices.totalSupply }}
        </div>
      </div>
    </div>

    <div class="hidden mobile:!flex mobile:flex-col gap-12 py-12 pb-16">
      <div
        v-if="isBorrowable"
        class="flex w-full justify-between"
      >
        <div class="text-content-tertiary text-p3">Available liquidity</div>
        <div class="text-p2 text-content-primary">
          {{ prices.liquidity }}
        </div>
      </div>
      <div
        v-if="enableEntityBranding"
        class="flex w-full justify-between"
      >
        <div class="text-content-tertiary text-p3">Risk manager</div>
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
        v-if="isBorrowable"
        class="flex w-full justify-between"
      >
        <div class="text-content-tertiary text-p3 flex items-center gap-4">
          Utilization
          <VaultWarningIcon :warning="utilisationWarning" />
        </div>
        <div class="flex gap-8 justify-end items-center">
          <UiRadialProgress
            :value="utilization"
            :max="100"
          />
          <div class="text-p2 text-content-primary">
            {{ compactNumber(utilization, 2, 2) }}%
          </div>
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
            <div class="text-p2 text-content-primary whitespace-nowrap">
              {{ prices.walletBalance }}
            </div>
          </BaseLoadableContent>
        </div>
      </div>
    </div>
  </NuxtLink>
</template>
