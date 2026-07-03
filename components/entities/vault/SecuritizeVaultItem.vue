<script setup lang="ts">
import type { SecuritizeCollateralVault, EVault } from '@eulerxyz/euler-v2-sdk'
import { formatAssetValue } from '~/utils/sdk-prices'
import { isVaultBlockedByCountry } from '~/composables/useGeoBlock'
import { useEulerProductOfVault, useEulerEntitiesOfVault } from '~/composables/useEulerLabels'
import { isVaultGovernanceLimited } from '~/utils/eulerLabelsUtils'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { withVaultIntrinsicApy, getVaultIntrinsicApy, getVaultIntrinsicApyInfo } from '~/utils/vault-intrinsic-apy'
import { formatNumber, formatCompactUsdValue } from '~/utils/string-utils'
import { VaultSupplyApyModal, UiModalPreviewTrigger } from '#components'
import BaseLoadableContent from '~/components/base/BaseLoadableContent.vue'

const { isConnected } = useWagmi()
const { vault } = defineProps<{ vault: SecuritizeCollateralVault }>()

const vaultAddress = computed(() => vault.address)
const product = useEulerProductOfVault(vaultAddress)
const { enableEntityBranding } = useDeployConfig()
const { isVaultGovernorVerified } = useVaults()
const { isVerifiedVault } = useVaultRegistry()
// SecuritizeCollateralVault has governorAdmin, safe to cast for entity lookup
const entities = useEulerEntitiesOfVault(vault as unknown as EVault)

const isUnverified = computed(() => !isVerifiedVault(vault.address))
const isGovernorVerified = computed(() => isVaultGovernorVerified(vault as unknown as EVault))
const isGovernanceLimited = computed(() => isVaultGovernanceLimited(vault.address) && isGovernorVerified.value)
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
const displayName = computed(() => product.name || vault.shares.name)
const isGeoBlocked = computed(() => isVaultBlockedByCountry(vault.address))

const { getBalance, isLoading: isBalancesLoading } = useWallets()
const { settings } = useUserSettings()
const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
const { getSupplyRewardApy, hasSupplyRewards, getSupplyRewardCampaigns } = useRewardsApy()

const balance = computed(() =>
  getBalance(vault.asset.address as `0x${string}`),
)
const totalRewardsAPY = computed(() => getSupplyRewardApy(vault.address))
const hasRewards = computed(() => hasSupplyRewards(vault.address))
const lendingAPY = computed(() =>
  getVaultSupplyApy(vault),
)
const supplyApy = computed(() =>
  withVaultIntrinsicApy(lendingAPY.value, vault, enableIntrinsicApy.value),
)
const supplyApyWithRewards = computed(
  () => supplyApy.value + totalRewardsAPY.value,
)

const supplyApyModalData = computed(() => ({
  props: {
    lendingAPY: lendingAPY.value,
    intrinsicAPY: getVaultIntrinsicApy(vault, enableIntrinsicApy.value),
    intrinsicApyInfo: getVaultIntrinsicApyInfo(vault, enableIntrinsicApy.value),
    campaigns: getSupplyRewardCampaigns(vault.address),
    rewardVaultAddress: vault.address,
  },
}))

const statsGridCols = computed(() => {
  const cols: string[] = []
  if (enableEntityBranding) cols.push('1fr')
  cols.push('1fr') // Total supply
  if (isConnected.value) cols.push('1fr') // In wallet
  return cols.join(' ')
})

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
    class="block no-underline text-content-primary bg-surface rounded-12 border border-line-default shadow-card hover:shadow-card-hover hover:border-line-emphasis transition-all"
    :class="isGeoBlocked ? 'opacity-50' : ''"
    :to="{ path: `/lend/${vault.address}`, query: { network: $route.query.network } }"
    data-id="vault-list-item"
    data-list="lend"
    :data-key="vault.address.toLowerCase()"
    :data-vault-address="vault.address.toLowerCase()"
  >
    <div class="flex pb-12 p-16 border-b border-line-subtle">
      <AssetAvatar
        :asset="vault.asset"
        size="40"
      />
      <div class="flex-grow ml-12">
        <div
          class="text-content-tertiary text-p3 mb-4 flex items-center gap-8"
          data-id="data-point"
          :data-key="vault.address.toLowerCase()"
          data-field="name"
          :data-value="displayName"
        >
          <VaultDisplayName
            :name="displayName"
            :is-unverified="isUnverified"
          />
          <GovernanceLimitedBadge v-if="isGovernanceLimited" />
          <RestrictedBadge v-if="isGeoBlocked" />
        </div>
        <div
          class="text-h5 text-content-primary"
          data-id="data-point"
          :data-key="vault.address.toLowerCase()"
          data-field="asset-symbol"
          :data-value="vault.asset.symbol"
        >
          {{ vault.asset.symbol }}
        </div>
      </div>
      <div class="flex flex-col items-end">
        <div class="text-content-tertiary text-p3 mb-4 text-right flex items-center gap-4">
          Supply APY
          <UiModalPreviewTrigger
            :component="VaultSupplyApyModal"
            :modal-data="supplyApyModalData"
            aria-label="Show supply APY breakdown"
          >
            <SvgIcon
              class="!w-16 !h-16 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
              name="info-circle"
              data-modal-trigger="supply-apy"
            />
          </UiModalPreviewTrigger>
        </div>
        <div class="flex items-center">
          <div
            class="text-p2 flex items-center text-accent-600 font-semibold"
            data-id="data-point"
            :data-key="vault.address.toLowerCase()"
            data-field="supply-apy"
            :data-value="supplyApyWithRewards"
          >
            <UiModalPreviewTrigger
              v-if="hasRewards"
              :component="VaultSupplyApyModal"
              :modal-data="supplyApyModalData"
              aria-label="Show supply APY rewards breakdown"
            >
              <SvgIcon
                class="!w-20 !h-20 text-accent-500 mr-4 cursor-pointer"
                name="sparks"
                data-modal-trigger="supply-apy"
              />
            </UiModalPreviewTrigger>
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
        class="flex-1"
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
          <span
            class="text-p2 text-content-primary truncate"
            data-id="data-point"
            :data-key="vault.address.toLowerCase()"
            data-field="risk-manager"
            :data-value="entityName"
          >{{ entityName }}</span>
        </div>
        <div
          v-else
          class="text-p2 text-content-primary"
        >-</div>
      </div>
      <div class="flex-1 flex flex-col items-center mobile:items-start">
        <div class="text-content-tertiary text-p3 mb-4">
          Total supply
        </div>
        <div
          class="text-p2 text-content-primary"
          data-id="data-point"
          :data-key="vault.address.toLowerCase()"
          data-field="total-supply"
          :data-value="prices.totalSupply"
        >
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
          <div
            class="text-p2 text-content-primary whitespace-nowrap"
            data-id="data-point"
            :data-key="vault.address.toLowerCase()"
            data-field="wallet-balance"
            :data-value="prices.walletBalance"
          >
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
