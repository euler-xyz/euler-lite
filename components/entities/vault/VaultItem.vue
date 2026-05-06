<script setup lang="ts">
import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { getUtilisationWarning, getSupplyCapWarning } from '~/composables/useVaultWarnings'
import { formatAssetValue } from '~/services/pricing/priceProvider'
import { useEulerProductOfVault, useEulerEntitiesOfVault } from '~/composables/useEulerLabels'
import { isVaultRecentlyAdded, isVaultKeyring } from '~/utils/eulerLabelsUtils'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { isVaultBlockedByCountry } from '~/composables/useGeoBlock'
import { formatNumber, compactNumber, formatCompactUsdValue } from '~/utils/string-utils'
import BaseLoadableContent from '~/components/base/BaseLoadableContent.vue'
import { useModal } from '~/components/ui/composables/useModal'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { VaultSupplyApyModal, VaultCollateralExposureModal } from '#components'
import { useAccount } from '@wagmi/vue'
import { isCyclicalNoteVault } from '~/utils/vault/classification'
import { getAddress } from 'viem'

const { isConnected } = useAccount()
const { vault } = defineProps<{ vault: EVault }>()
const vaultAddress = computed(() => vault.address)
const product = useEulerProductOfVault(vaultAddress)
const { enableEntityBranding } = useDeployConfig()
const { isVaultGovernorVerified } = useVaults()
const entities = useEulerEntitiesOfVault(vault)
const { getVaultCategory, isVerifiedVault, get: registryGet } = useVaultRegistry()
const isUnverified = computed(() => !isVerifiedVault(vault.address))
const isGovernorVerified = computed(() => isVaultGovernorVerified(vault))
const isGovernanceLimited = computed(() => product.isGovernanceLimited && isGovernorVerified.value)
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
const isEscrow = computed(() => getVaultCategory(vault.address) === 'escrow')
const isBorrowable = computed(() => !isEscrow.value && vault.collaterals.some(ltv => ltv.borrowLTV > 0))
const displayName = computed(() => {
  if (isEscrow.value) return 'Escrowed collateral'
  return product.name || vault.shares.name
})
const { getBalance, isLoading: isBalancesLoading } = useWallets()
const { withIntrinsicSupplyApy, getIntrinsicApy, getIntrinsicApyInfo } = useIntrinsicApy()
const { getSupplyRewardApy, hasSupplyRewards, getSupplyRewardCampaigns } = useRewardsApy()
const modal = useModal()
const collateralAssets = computed(() => {
  if (!isBorrowable.value) return []
  const seen = new Set<string>()
  const assets: { address: string, symbol: string }[] = []
  for (const ltv of vault.collaterals) {
    if (ltv.borrowLTV <= 0) continue
    if (ltv.currentLiquidationLTV <= 0) continue
    const entry = registryGet(ltv.address)
    if (entry) {
      const assetAddr = entry.vault.asset.address.toLowerCase()
      if (seen.has(assetAddr)) continue
      seen.add(assetAddr)
      assets.push({ address: entry.vault.asset.address, symbol: entry.vault.asset.symbol })
    }
  }
  return assets
})
const collateralDisplayAssets = computed(() => collateralAssets.value.slice(0, 5))
const collateralOverflowCount = computed(() => Math.max(0, collateralAssets.value.length - 5))

const balance = computed(() =>
  getBalance(vault.asset.address as `0x${string}`),
)
const totalRewardsAPY = computed(() => getSupplyRewardApy(vault.address))
const hasRewards = computed(() => hasSupplyRewards(vault.address))
const lendingAPY = computed(() =>
  getVaultSupplyApy(vault),
)
const intrinsicAPY = computed(() => getIntrinsicApy(vault.asset.address))
const supplyApy = computed(() =>
  withIntrinsicSupplyApy(lendingAPY.value, vault.asset.address),
)
const supplyApyWithRewards = computed(
  () => supplyApy.value + totalRewardsAPY.value,
)
const utilization = computed(() => vault.utilization)
const isGeoBlocked = computed(() => isVaultBlockedByCountry(vault.address))
const isRecentlyAdded = computed(() => isVaultRecentlyAdded(vault.address))
const isKeyring = computed(() => isVaultKeyring(vault.address))
const isCyclicalNote = computed(() => isCyclicalNoteVault(vault))
const utilisationWarning = computed(() => getUtilisationWarning(vault, 'lend'))
const supplyCapWarning = computed(() => getSupplyCapWarning(vault))
const statsGridCols = computed(() => {
  const cols: string[] = []
  if (enableEntityBranding) cols.push('1fr')
  cols.push('1fr') // Total supply
  if (isBorrowable.value) {
    cols.push('1fr') // Available liquidity
    cols.push('1fr') // Utilization
    cols.push('1fr') // Collateral
  }
  if (isConnected.value) cols.push('1fr') // In wallet
  return cols.join(' ')
})
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

const onCollateralInfoClick = (event: MouseEvent) => {
  event.preventDefault()
  event.stopPropagation()
  modal.open(VaultCollateralExposureModal, { props: { vault } })
}

const prices = ref<{ totalSupply: string, liquidity: string, walletBalance: string }>({
  totalSupply: '-',
  liquidity: '-',
  walletBalance: '-',
})

watchEffect(async () => {
  const liquidity = vault.availableLiquidity
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
    class="block no-underline text-content-primary bg-surface rounded-12 border border-line-default shadow-card hover:shadow-card-hover hover:border-line-emphasis transition-all"
    :class="isGeoBlocked ? 'opacity-50' : ''"
    :to="{ path: `/lend/${vault.address}`, query: { network: $route.query.network } }"
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
            v-if="isRecentlyAdded"
            class="inline-flex items-center gap-4 rounded-8 px-8 py-2 bg-accent-100 text-accent-600 text-p5"
            title="Recently added vault"
          >
            <SvgIcon
              name="star"
              class="!w-14 !h-14"
            />
            Recently added
          </span>
          <KeyringBadge v-if="isKeyring" />
          <GovernanceLimitedBadge v-if="isGovernanceLimited" />
          <CyclicalNoteBadge v-if="isCyclicalNote" />
          <RestrictedBadge v-if="isGeoBlocked" />
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
      <div class="flex flex-col items-end">
        <div class="text-content-tertiary text-p3 mb-4 text-right flex items-center gap-4">
          Supply APY
          <SvgIcon
            class="!w-16 !h-16 shrink-0 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
            name="info-circle"
            @click="onSupplyInfoIconClick"
          />
        </div>
        <div class="flex items-center">
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
        </div>
      </div>
    </div>
    <div
      class="grid gap-x-16 py-12 px-16 pb-12 mobile:!flex mobile:justify-between mobile:border-b mobile:border-line-subtle"
      :style="{ gridTemplateColumns: statsGridCols }"
    >
      <div
        v-if="enableEntityBranding"
        class="flex-1 mobile:!hidden"
      >
        <div class="text-content-tertiary text-p3 mb-4">Risk manager</div>
        <div
          v-if="!isGovernorVerified"
          class="flex gap-8 items-center py-4 px-8 rounded-8 bg-error-100 text-error-500 text-p2 w-fit"
        >
          <SvgIcon
            name="warning"
            class="!w-16 !h-16"
          />
          Unknown
        </div>
        <div
          v-else-if="entityName"
          class="flex items-center gap-6"
          :class="{ 'opacity-20': isGovernanceLimited }"
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
      <div class="flex-1 flex flex-col items-center mobile:items-start">
        <div class="text-content-tertiary text-p3 mb-4 flex items-center gap-4">
          Total supply
          <VaultWarningIcon
            :warning="supplyCapWarning"
            tooltip-placement="top-start"
          />
        </div>
        <div class="text-p2 text-content-primary">
          {{ prices.totalSupply }}
        </div>
      </div>
      <div
        v-if="isBorrowable"
        class="flex-1 flex flex-col items-center mobile:items-end"
      >
        <div class="text-content-tertiary text-p3 mb-4">
          Available liquidity
        </div>
        <div class="text-p2 text-content-primary">
          {{ prices.liquidity }}
        </div>
      </div>
      <div
        v-if="isBorrowable"
        class="flex flex-col flex-1 mobile:!hidden"
        :class="
          isConnected ? 'justify-center items-center' : 'items-end text-right'
        "
      >
        <div class="text-content-tertiary text-p3 mb-4 flex items-center gap-4">
          Utilization
          <VaultWarningIcon :warning="utilisationWarning" />
        </div>
        <div class="flex gap-8 justify-end items-center text-right">
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
        v-if="isBorrowable"
        class="flex flex-col flex-1 mobile:!hidden"
        :class="isConnected ? 'items-center' : 'items-end text-right'"
      >
        <div class="text-content-tertiary text-p3 mb-4 flex items-center gap-4">
          Collateral exposure
          <SvgIcon
            v-if="collateralAssets.length > 0"
            class="!w-16 !h-16 shrink-0 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
            name="info-circle"
            @click="onCollateralInfoClick"
          />
        </div>
        <div
          v-if="collateralAssets.length > 0"
          class="flex items-center gap-4 cursor-pointer"
          @click="onCollateralInfoClick"
        >
          <AssetAvatar
            :asset="collateralDisplayAssets"
            size="20"
          />
          <span
            v-if="collateralOverflowCount > 0"
            class="text-p3 text-content-tertiary whitespace-nowrap"
          >
            & {{ collateralOverflowCount }} more
          </span>
        </div>
        <div
          v-else
          class="text-p2 text-content-primary"
        >-</div>
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
          <div
            v-if="!isGovernorVerified"
            class="flex gap-8 items-center py-4 px-8 rounded-8 bg-error-100 text-error-500 text-p2 w-fit"
          >
            <SvgIcon
              name="warning"
              class="!w-16 !h-16"
            />
            Unknown
          </div>
          <div
            v-else-if="entityName"
            class="flex items-center gap-8"
            :class="{ 'opacity-20': isGovernanceLimited }"
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
      </div>
      <div
        v-if="isBorrowable"
        class="flex w-full justify-between"
      >
        <div class="flex-1">
          <div class="text-content-tertiary text-p3 flex items-center gap-4">
            Utilization
            <VaultWarningIcon :warning="utilisationWarning" />
          </div>
        </div>
        <div class="flex gap-8 justify-end items-center text-right flex-1">
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
        v-if="isBorrowable"
        class="flex w-full justify-between"
      >
        <div class="flex-1">
          <div class="text-content-tertiary text-p3 flex items-center gap-4">
            Collateral exposure
            <SvgIcon
              v-if="collateralAssets.length > 0"
              class="!w-16 !h-16 shrink-0 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
              name="info-circle"
              @click="onCollateralInfoClick"
            />
          </div>
        </div>
        <div class="flex gap-8 justify-end items-center text-right flex-1">
          <div
            v-if="collateralAssets.length > 0"
            class="flex items-center gap-8 cursor-pointer"
            @click="onCollateralInfoClick"
          >
            <AssetAvatar
              :asset="collateralDisplayAssets"
              size="20"
            />
            <span
              v-if="collateralOverflowCount > 0"
              class="text-p3 text-content-tertiary whitespace-nowrap"
            >
              & {{ collateralOverflowCount }} more
            </span>
          </div>
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
