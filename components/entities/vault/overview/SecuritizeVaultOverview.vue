<script setup lang="ts">
import type { EVault, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { useEulerEntitiesOfVault } from '~/composables/useEulerLabels'
import { getProductByVault, getProductKeyByVault, isVaultGovernanceLimited } from '~/utils/eulerLabelsUtils'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { isVaultBlockedByCountry } from '~/composables/useGeoBlock'
import { autoLink } from '~/utils/autoLink'
import { getExplorerLink } from '~/utils/block-explorer'
import { getSpecialAddressLabel } from '~/utils/special-addresses'
import { formatAssetValue } from '~/utils/sdk-prices'
import { formatNumber, compactNumber, formatUsdValue, formatCompactUsdValue } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import { formatMarketAvailability } from '~/utils/vault-display'
import { VaultSupplyApyModal } from '#components'
import { getAddress, maxUint256 } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import { getVaultIntrinsicApy, getVaultIntrinsicApyInfo } from '~/utils/vault-intrinsic-apy'

const { vault } = defineProps<{ vault: SecuritizeCollateralVault, desktopOverview?: boolean }>()
const emit = defineEmits<{
  'market-click': []
}>()
const route = useRoute()
const { enableEntityBranding: enableEntityBrandingDisplay, enableVaultType: enableVaultTypeDisplay } = useDeployConfig()

const { chainId } = useEulerAddresses()
const { borrowList: _borrowList, isVaultGovernorVerified } = useVaults()
const { settings } = useUserSettings()
const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
const { getSupplyRewardApy, getSupplyRewardCampaigns, hasSupplyRewards } = useRewardsApy()
const vaultAddress = computed(() => getAddress(vault.address))
const product = useEulerProductOfVault(vaultAddress)
const description = computed(() => {
  return product.vaultOverrides?.[vaultAddress.value]?.description ?? product.description
})
const entities = useEulerEntitiesOfVault(vault as unknown as EVault)
const isGovernorVerified = computed(() => isVaultGovernorVerified(vault as unknown as EVault))
const isGovernanceLimited = computed(() => isVaultGovernanceLimited(vault.address) && isGovernorVerified.value)
const marketProductKey = computed(() => getProductKeyByVault(vault.address))
const marketProductName = computed(() => getProductByVault(vault.address).name)

const isDeprecated = computed(() => {
  return product.deprecatedVaults?.includes(vaultAddress.value) ?? false
})
const deprecationReason = computed(() => isDeprecated.value ? product.deprecationReason || '' : '')
const isRestricted = computed(() => isVaultBlockedByCountry(vault.address))

const shortenAddress = (address: string) => {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

const onCopyClick = (address: string) => {
  navigator.clipboard.writeText(address)
}

const getExplorerAddressLink = (address: string) => getExplorerLink(address, chainId.value, true)

// Count markets where this can be borrowed (securitize vaults cannot be borrow destinations)
const borrowCount = computed(() => 0)

// Supply APY calculation (intrinsic + rewards, no base interest for securitize vaults)
const rewardSupplyAPY = computed(() => getSupplyRewardApy(vault.address))
const intrinsicApy = computed(() => getVaultIntrinsicApy(vault, enableIntrinsicApy.value))
const supplyApyWithRewards = computed(() => intrinsicApy.value + rewardSupplyAPY.value)

const supplyApyModalData = computed(() => ({
  props: {
    lendingAPY: 0, // Securitize vaults don't have interest rates
    intrinsicAPY: intrinsicApy.value,
    intrinsicApyInfo: getVaultIntrinsicApyInfo(vault, enableIntrinsicApy.value),
    campaigns: getSupplyRewardCampaigns(vault.address),
    rewardVaultAddress: vault.address,
  },
}))

// Risk parameters - fetch share token exchange rate (ERC4626 standard)
const shareTokenExchangeRate: Ref<bigint | undefined> = ref()

const loadRiskParameters = () => {
  try {
    // Share→asset exchange rate from the SDK vault entity (was a direct
    // convertToAssets RPC read); the entity derives it from the same data.
    shareTokenExchangeRate.value = vault.convertToAssets(1n * 10n ** BigInt(vault.shares.decimals))
  }
  catch (e) {
    logWarn('SecuritizeVaultOverview/shareTokenExchangeRate', e)
  }
}

loadRiskParameters()

// Price display
const priceDisplay = ref('-')

watchEffect(async () => {
  const price = await formatAssetValue(1, vault, 'off-chain')
  priceDisplay.value = price.hasPrice ? formatUsdValue(price.usdValue) : '-'
})

// Total supply display with USD if available
const totalSupplyDisplay = ref('-')

watchEffect(async () => {
  const price = await formatAssetValue(vault.totalAssets, vault, 'off-chain')
  totalSupplyDisplay.value = price.hasPrice ? formatCompactUsdValue(price.usdValue) : price.display
})

// Supply cap display - supplyCap is in shares denomination (vault.decimals), same as regular vaults
const supplyCapDisplay = ref('∞')

watchEffect(async () => {
  if (!vault.supplyCap || vault.supplyCap === 0n || vault.supplyCap >= maxUint256) {
    supplyCapDisplay.value = '∞'
    return
  }
  const price = await formatAssetValue(vault.supplyCap, vault, 'off-chain')
  supplyCapDisplay.value = price.hasPrice ? formatCompactUsdValue(price.usdValue) : price.display
})

const supplyCapPercentageDisplay = computed(() => {
  if (!vault.supplyCap || vault.supplyCap >= maxUint256 || vault.supplyCap === 0n) return 0
  const decimals = 2
  const scale = 10n ** BigInt(decimals)
  // Compare totalShares to supplyCap (both in shares denomination)
  const fraction = (vault.totalShares * scale * 100n) / vault.supplyCap
  // Zero-pad the fractional part so e.g. a remainder of 5 renders as ".05" not ".5"
  const fractional = String(fraction % scale).padStart(decimals, '0')
  return parseFloat(`${fraction / scale}.${fractional}`)
})
</script>

<template>
  <div
    class="flex flex-col"
    :class="[desktopOverview ? 'gap-16' : 'gap-12']"
  >
    <!-- Overview -->
    <VaultOverviewAccordionSection
      title="Overview"
      :default-open="true"
      content-class="flex flex-col items-start gap-24"
    >
      <VaultDeprecationBanner
        v-if="isDeprecated"
        :reason="deprecationReason"
      />
      <div
        v-if="isRestricted"
        class="w-full rounded-12 p-16 bg-warning-100 text-warning-500"
      >
        <div class="flex items-center gap-8">
          <SvgIcon
            name="warning"
            class="!w-20 !h-20 flex-shrink-0"
          />
          <p class="text-p3 text-warning-500">
            This vault is not available in your region.
          </p>
        </div>
      </div>
      <div
        v-if="description"
        class="w-full rounded-12 p-16 bg-surface-tertiary"
      >
        <!-- eslint-disable vue/no-v-html -- trusted label content -->
        <p
          class="text-p3 text-content-secondary auto-link"
          v-html="autoLink(description)"
        />
        <!-- eslint-enable vue/no-v-html -->
      </div>
      <VaultOverviewLabelValue
        label="Price"
        :value="priceDisplay"
      />
      <VaultOverviewLabelValue label="Market">
        <NuxtLink
          v-if="marketProductKey"
          :to="{ name: 'explore-market', params: { market: marketProductKey }, query: { network: route.query.network } }"
          class="text-p2 text-content-primary hover:text-accent-600 underline transition-colors"
          @click="emit('market-click')"
        >
          {{ marketProductName }}
        </NuxtLink>
        <template v-else>
          {{ marketProductName || '-' }}
        </template>
      </VaultOverviewLabelValue>
      <VaultOverviewLabelValue
        v-if="enableEntityBrandingDisplay"
        label="Risk manager"
      >
        <div
          v-if="entities.length && isGovernorVerified"
          class="flex flex-col gap-16"
        >
          <div
            v-for="(entity, idx) in entities"
            :key="idx"
            class="flex items-center gap-8"
            :class="{ 'opacity-20': isGovernanceLimited }"
          >
            <BaseAvatar
              :label="entity.name"
              :src="getEulerLabelEntityLogo(entity.logo)"
              class="!w-28 !h-28"
            />
            <a
              :href="entity.url"
              target="_blank"
              rel="noopener noreferrer"
              class="text-p2 text-content-primary underline"
            >{{ entity.name }}</a>
          </div>
        </div>
        <VaultTypeChip
          v-else-if="!isGovernorVerified"
          :vault="vault"
          type="unknown"
          nudge
        />
        <div v-else>
          -
        </div>
      </VaultOverviewLabelValue>
      <VaultOverviewLabelValue
        v-if="enableVaultTypeDisplay"
        label="Vault type"
      >
        <VaultTypeBadges
          :vault="vault"
          nudge
        />
      </VaultOverviewLabelValue>
      <VaultOverviewLabelValue label="Can be borrowed">
        <div class="flex items-center gap-8">
          <div>
            <UiIcon :name="borrowCount ? 'green-tick' : 'red-cross'" />
          </div>
          <span class="text-p2 text-content-primary">
            {{ formatMarketAvailability(borrowCount) }}
          </span>
        </div>
      </VaultOverviewLabelValue>
    </VaultOverviewAccordionSection>

    <!-- Statistics -->
    <VaultOverviewAccordionSection
      title="Statistics"
      :default-open="true"
      content-class="flex flex-col items-start gap-24"
    >
      <VaultOverviewLabelValue
        label="Total supply"
        :value="totalSupplyDisplay"
        orientation="horizontal"
      />
      <VaultOverviewLabelValue
        orientation="horizontal"
      >
        <template #label>
          Supply APY
        </template>
        <span class="flex items-center gap-4">
          <UiModalPreviewTrigger
            v-if="hasSupplyRewards(vault.address)"
            :component="VaultSupplyApyModal"
            :modal-data="supplyApyModalData"
            aria-label="Show supply APY rewards breakdown"
          >
            <SvgIcon
              class="!w-20 !h-20 text-accent-500 cursor-pointer"
              name="sparks"
            />
          </UiModalPreviewTrigger>
          {{ formatNumber(supplyApyWithRewards) }}%
        </span>
      </VaultOverviewLabelValue>
    </VaultOverviewAccordionSection>

    <!-- Risk Parameters -->
    <VaultOverviewAccordionSection
      title="Risk parameters"
      :default-open="false"
      content-class="flex flex-col items-start gap-24"
    >
      <VaultOverviewLabelValue
        label="Supply cap"
        orientation="horizontal"
      >
        <div class="flex gap-4 items-center">
          <span>
            {{ supplyCapDisplay }}
            <span v-if="vault.supplyCap && vault.supplyCap < maxUint256 && vault.supplyCap > 0n">
              ({{ compactNumber(supplyCapPercentageDisplay, 2) }}%)
            </span>
          </span>
          <UiRadialProgress
            v-if="vault.supplyCap && vault.supplyCap < maxUint256 && vault.supplyCap > 0n"
            :value="supplyCapPercentageDisplay"
            :max="100"
          />
        </div>
      </VaultOverviewLabelValue>
      <VaultOverviewLabelValue
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
    </VaultOverviewAccordionSection>

    <!-- Addresses -->
    <VaultOverviewAccordionSection
      title="Addresses"
      :default-open="false"
      content-class="flex flex-col items-start gap-24"
    >
      <VaultOverviewLabelValue
        :label="`${vault.asset.symbol} token`"
        orientation="horizontal"
      >
        <div class="flex gap-4 items-center">
          <NuxtLink
            :to="getExplorerAddressLink(vault.asset.address)"
            class="text-accent-600 underline cursor-pointer hover:text-accent-500"
            target="_blank"
          >
            {{ getSpecialAddressLabel(vault.asset.address) || shortenAddress(vault.asset.address) }}
          </NuxtLink>
          <button
            class="text-content-muted cursor-pointer outline-none hover:text-content-secondary active:text-content-primary"
            @click="onCopyClick(vault.asset.address)"
          >
            <SvgIcon
              class="!w-18 !h-18"
              name="copy"
            />
          </button>
        </div>
      </VaultOverviewLabelValue>
      <VaultOverviewLabelValue
        :label="`${vault.asset.symbol} vault`"
        orientation="horizontal"
      >
        <div class="flex gap-4 items-center">
          <NuxtLink
            :to="getExplorerAddressLink(vault.address)"
            class="text-accent-600 underline cursor-pointer hover:text-accent-500"
            target="_blank"
          >
            {{ getSpecialAddressLabel(vault.address) || shortenAddress(vault.address) }}
          </NuxtLink>
          <button
            class="text-content-muted cursor-pointer outline-none hover:text-content-secondary active:text-content-primary"
            @click="onCopyClick(vault.address)"
          >
            <SvgIcon
              class="!w-18 !h-18"
              name="copy"
            />
          </button>
        </div>
      </VaultOverviewLabelValue>
      <VaultOverviewLabelValue
        v-if="vault.governor && vault.governor !== '0x0000000000000000000000000000000000000000'"
        label="Risk manager"
        orientation="horizontal"
      >
        <div class="flex gap-4 items-center">
          <NuxtLink
            :to="getExplorerAddressLink(vault.governor)"
            class="text-accent-600 underline cursor-pointer hover:text-accent-500"
            target="_blank"
          >
            {{ getSpecialAddressLabel(vault.governor) || shortenAddress(vault.governor) }}
          </NuxtLink>
          <button
            class="text-content-muted cursor-pointer outline-none hover:text-content-secondary active:text-content-primary"
            @click="onCopyClick(vault.governor)"
          >
            <SvgIcon
              class="!w-18 !h-18"
              name="copy"
            />
          </button>
        </div>
      </VaultOverviewLabelValue>
    </VaultOverviewAccordionSection>
  </div>
</template>
