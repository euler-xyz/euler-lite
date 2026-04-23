<script setup lang="ts">
import { getAddress, maxUint256, type Address } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import type { SecuritizeVault, Vault, VaultCollateralLTV } from '~/entities/vault'
import { useEulerEntitiesOfVault } from '~/composables/useEulerLabels'
import { getProductKeyByVault } from '~/utils/eulerLabelsUtils'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { isVaultBlockedByCountry } from '~/composables/useGeoBlock'
import { autoLink } from '~/utils/autoLink'
import { getExplorerLink } from '~/utils/block-explorer'
import { getSpecialAddressLabel } from '~/utils/special-addresses'
import { formatAssetValue } from '~/services/pricing/priceProvider'
import { formatNumber, compactNumber, formatUsdValue, formatCompactUsdValue } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import { useModal } from '~/components/ui/composables/useModal'
import { VaultSupplyApyModal } from '#components'

const { vault } = defineProps<{ vault: SecuritizeVault, desktopOverview?: boolean }>()
const route = useRoute()
const { enableEntityBranding: enableEntityBrandingDisplay, enableVaultType: enableVaultTypeDisplay } = useDeployConfig()

const { client: rpcClient } = useRpcClient()
const { chainId } = useEulerAddresses()
const { borrowList: _borrowList, isVaultGovernorVerified } = useVaults()
const { getEvkVaults } = useVaultRegistry()
const { getIntrinsicApy, getIntrinsicApyInfo } = useIntrinsicApy()
const modal = useModal()
const { getSupplyRewardApy, getSupplyRewardCampaigns, hasSupplyRewards } = useRewardsApy()
const vaultAddress = computed(() => getAddress(vault.address))
const product = useEulerProductOfVault(vaultAddress)
const description = computed(() => {
  return product.vaultOverrides?.[vaultAddress.value]?.description ?? product.description
})
const entities = useEulerEntitiesOfVault(vault as unknown as Vault)
const isGovernorVerified = computed(() => isVaultGovernorVerified(vault as unknown as Vault))
const isGovernanceLimited = computed(() => product.isGovernanceLimited && isGovernorVerified.value)
const marketProductKey = computed(() => getProductKeyByVault(vault.address))

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

// Find EVK vaults where this securitize vault can be used as collateral
const borrowMarkets = computed(() => {
  const markets: Array<{
    borrowVault: Vault
    ltv: VaultCollateralLTV
  }> = []

  getEvkVaults().forEach((v) => {
    const ltv = v.collateralLTVs.find(l => l.collateral === vault.address && l.borrowLTV > 0n)
    if (ltv) {
      markets.push({ borrowVault: v, ltv })
    }
  })

  return markets
})

const collateralCount = computed(() => borrowMarkets.value.length)

// Supply APY calculation (intrinsic + rewards, no base interest for securitize vaults)
const rewardSupplyAPY = computed(() => getSupplyRewardApy(vault.address))
const intrinsicApy = computed(() => getIntrinsicApy(vault.asset.address))
const supplyApyWithRewards = computed(() => intrinsicApy.value + rewardSupplyAPY.value)

const onSupplyInfoIconClick = () => {
  modal.open(VaultSupplyApyModal, {
    props: {
      lendingAPY: 0, // Securitize vaults don't have interest rates
      intrinsicAPY: intrinsicApy.value,
      intrinsicApyInfo: getIntrinsicApyInfo(vault.asset.address),
      campaigns: getSupplyRewardCampaigns(vault.address),
    },
  })
}

// Risk parameters - fetch share token exchange rate (ERC4626 standard)
const shareTokenExchangeRate: Ref<bigint | undefined> = ref()

const loadRiskParameters = async () => {
  try {
    const client = rpcClient.value!
    shareTokenExchangeRate.value = await client.readContract({
      address: vault.address as Address,
      abi: [{
        type: 'function',
        name: 'convertToAssets',
        inputs: [{ name: 'shares', type: 'uint256' }],
        outputs: [{ name: 'assets', type: 'uint256' }],
        stateMutability: 'view',
      }] as const,
      functionName: 'convertToAssets',
      args: [1n * 10n ** vault.decimals],
    }) as bigint
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
  const scale = 10n ** 2n
  // Compare totalShares to supplyCap (both in shares denomination)
  const fraction = (vault.totalShares * scale * 100n) / vault.supplyCap
  return parseFloat(`${fraction / scale}.${fraction % scale}`)
})
</script>

<template>
  <div
    class="flex flex-col"
    :class="[desktopOverview ? 'gap-16' : 'gap-12']"
  >
    <!-- Overview -->
    <div
      class="bg-surface-secondary rounded-xl flex flex-col gap-24 p-24 shadow-card"
    >
      <p class="text-h3 text-content-primary">
        Overview
      </p>
      <div class="flex flex-col items-start gap-24">
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
          >
            {{ product.name }}
          </NuxtLink>
          <template v-else>
            {{ product.name || '-' }}
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
          />
          <div v-else>
            -
          </div>
        </VaultOverviewLabelValue>
        <VaultOverviewLabelValue
          v-if="enableVaultTypeDisplay"
          label="Vault type"
        >
          <VaultTypeBadges :vault-address="vault.address" />
        </VaultOverviewLabelValue>
        <VaultOverviewLabelValue label="Can be borrowed">
          <div class="flex items-center gap-8">
            <div>
              <UiIcon :name="borrowCount ? 'green-tick' : 'red-cross'" />
            </div>
            <span class="text-p2 text-content-primary">
              {{ borrowCount ? `Yes in ${borrowCount} markets` : 'No' }}
            </span>
          </div>
        </VaultOverviewLabelValue>
        <VaultOverviewLabelValue label="Can be used as collateral">
          <div class="flex items-center gap-8">
            <div>
              <UiIcon :name="collateralCount ? 'green-tick' : 'red-cross'" />
            </div>
            <span class="text-p2 text-content-primary">
              {{ collateralCount ? `Yes in ${collateralCount} markets` : 'No' }}
            </span>
          </div>
        </VaultOverviewLabelValue>
      </div>
    </div>

    <!-- Statistics -->
    <div
      class="bg-surface-secondary rounded-xl flex flex-col gap-24 p-24 shadow-card"
    >
      <p class="text-h3 text-content-primary">
        Statistics
      </p>
      <div class="flex flex-col items-start gap-24">
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
            <SvgIcon
              v-if="hasSupplyRewards(vault.address)"
              class="!w-20 !h-20 text-accent-500 cursor-pointer"
              name="sparks"
              @click="onSupplyInfoIconClick"
            />
            {{ formatNumber(supplyApyWithRewards) }}%
          </span>
        </VaultOverviewLabelValue>
      </div>
    </div>

    <!-- Risk Parameters -->
    <div
      class="bg-surface-secondary rounded-xl flex flex-col gap-24 p-24 shadow-card"
    >
      <p class="text-h3 text-content-primary">
        Risk parameters
      </p>
      <div class="flex flex-col items-start gap-24">
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
      </div>
    </div>

    <!-- Addresses -->
    <div
      class="bg-surface-secondary rounded-xl flex flex-col gap-24 p-24 shadow-card"
    >
      <p class="text-h3 text-content-primary">
        Addresses
      </p>
      <div class="flex flex-col items-start gap-24">
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
          v-if="vault.governorAdmin && vault.governorAdmin !== '0x0000000000000000000000000000000000000000'"
          label="Risk manager"
          orientation="horizontal"
        >
          <div class="flex gap-4 items-center">
            <NuxtLink
              :to="getExplorerAddressLink(vault.governorAdmin)"
              class="text-accent-600 underline cursor-pointer hover:text-accent-500"
              target="_blank"
            >
              {{ getSpecialAddressLabel(vault.governorAdmin) || shortenAddress(vault.governorAdmin) }}
            </NuxtLink>
            <button
              class="text-content-muted cursor-pointer outline-none hover:text-content-secondary active:text-content-primary"
              @click="onCopyClick(vault.governorAdmin)"
            >
              <SvgIcon
                class="!w-18 !h-18"
                name="copy"
              />
            </button>
          </div>
        </VaultOverviewLabelValue>
      </div>
    </div>
  </div>
</template>
