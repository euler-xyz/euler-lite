<script setup lang="ts">
import { useAccount } from '@wagmi/vue'
import { getSubAccountId as getSubAccountIndex, isSecuritizeCollateralVault, type EVault, type PortfolioSavingsPosition, type VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'

import { getUtilisationWarning } from '~/composables/useVaultWarnings'
import { getAssetUsdValue, formatAssetValue } from '~/utils/sdk-prices'
import { isVaultBlockedByCountry } from '~/composables/useGeoBlock'
import { isVaultDeprecated, getVaultNotice } from '~/utils/eulerLabelsUtils'
import { formatNumber, formatCompactUsdValue, formatSmartAmount, formatExactAmount } from '~/utils/string-utils'
import { nanoToValue, roundAndCompactTokens } from '~/utils/crypto-utils'
import { VaultOverviewModal, VaultSupplyApyModal } from '#components'
import { useModal } from '~/components/ui/composables/useModal'

const { position } = defineProps<{ position: PortfolioSavingsPosition<VaultEntity> }>()
const modal = useModal()

const { address } = useAccount()
const { portfolioAddress } = useEulerAccount()
const ownerAddress = computed(() => portfolioAddress.value || address.value || '')
const subAccountIndex = computed(() => {
  if (!ownerAddress.value || !position.subAccount) return 0
  return getSubAccountIndex(getAddress(ownerAddress.value), getAddress(position.subAccount))
})

const { withIntrinsicSupplyApy, getIntrinsicApy, getIntrinsicApyInfo } = useIntrinsicApy()
const { getSupplyRewardApy, hasSupplyRewards, getSupplyRewardCampaigns } = useRewardsApy()

const vault = computed(() => position.vault!)
const utilisationWarning = computed(() => {
  if (isSecuritizeCollateralVault(vault.value)) return null
  return getUtilisationWarning(vault.value as EVault, 'lend')
})

const isSecuritize = computed(() => isSecuritizeCollateralVault(vault.value))

const rewardsExist = computed(() => hasSupplyRewards(vault.value.address))
const supplyApy = computed(() => {
  return withIntrinsicSupplyApy(
    getVaultSupplyApy(vault.value),
    vault.value.asset.address,
  )
})
const supplyApyWithRewards = computed(() => supplyApy.value + getSupplyRewardApy(vault.value.address))

const product = useEulerProductOfVault(computed(() => vault.value.address))
const { getVaultCategory, isVerifiedVault } = useVaultRegistry()
const isGeoBlocked = computed(() => isVaultBlockedByCountry(vault.value.address))
const isDeprecated = computed(() => isVaultDeprecated(vault.value.address))
const isEscrow = computed(() => getVaultCategory(vault.value.address) === 'escrow')
const isUnverified = computed(() => !isVerifiedVault(vault.value.address))
const vaultNotice = computed(() => getVaultNotice(vault.value.address))
const displayName = computed(() => {
  if (isEscrow.value) return 'Escrowed collateral'
  return product.name || vault.value.shares.name
})

const supplyValueDisplay = ref('-')

const updateSupplyValueDisplay = async () => {
  const price = await formatAssetValue(position.assets, vault.value, 'off-chain')
  supplyValueDisplay.value = price.hasPrice ? formatCompactUsdValue(price.usdValue) : price.display
}

watchEffect(() => {
  updateSupplyValueDisplay()
})

const hasPrice = ref(false)

const updateHasPrice = async () => {
  const price = await getAssetUsdValue(position.assets, vault.value, 'off-chain')
  hasPrice.value = price !== undefined && price > 0
}

watchEffect(() => {
  updateHasPrice()
})

// Securitize-specific computed properties
const assetAmount = computed(() => {
  return nanoToValue(position.assets, vault.value.asset.decimals)
})

const onSupplyInfoIconClick = (event: MouseEvent) => {
  event.preventDefault()
  event.stopPropagation()
  modal.open(VaultSupplyApyModal, {
    props: {
      lendingAPY: getVaultSupplyApy(vault.value),
      intrinsicAPY: getIntrinsicApy(vault.value.asset.address),
      intrinsicApyInfo: getIntrinsicApyInfo(vault.value.asset.address),
      campaigns: getSupplyRewardCampaigns(vault.value.address),
    },
  })
}

const onClick = () => {
  modal.open(VaultOverviewModal, {
    props: isSecuritize.value
      ? { title: 'Vault information', securitizeVault: vault.value }
      : { title: 'Vault information', vault: vault.value },
  })
}
</script>

<template>
  <!-- Securitize vault display -->
  <div
    v-if="isSecuritize"
    class="block no-underline bg-surface rounded-xl border border-line-subtle shadow-card cursor-pointer transition-all duration-default ease-default hover:shadow-card-hover hover:border-line-emphasis"
    @click="onClick"
  >
    <div class="flex py-16 px-16 pb-12 border-b border-line-default">
      <div class="flex w-full">
        <AssetAvatar
          :asset="vault.asset"
          size="40"
        />
        <div class="flex-grow ml-12">
          <div class="text-content-tertiary text-p3 mb-4 flex items-center gap-4">
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
              title="This vault has been deprecated."
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
          <div class="text-content-tertiary text-p3 mb-4 flex items-center gap-4">
            Supply APY
            <SvgIcon
              class="!w-16 !h-16 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
              name="info-circle"
              @click.stop="onSupplyInfoIconClick"
            />
          </div>
          <div class="text-p2 flex text-accent-600">
            <SvgIcon
              v-if="rewardsExist"
              name="sparks"
              class="!w-20 !h-20 text-accent-600 mr-4 cursor-pointer"
              @click.stop="onSupplyInfoIconClick"
            />
            {{ formatNumber(supplyApyWithRewards) }}%
          </div>
        </div>
      </div>
    </div>
    <div class="flex py-12 px-16 pb-16">
      <div class="flex flex-col gap-12 w-full">
        <PortfolioNotice :notice="vaultNotice" />
        <div class="flex justify-between">
          <div class="text-content-tertiary text-p3">
            Supply value
          </div>
          <div class="flex justify-between gap-8 text-right">
            <div class="text-content-primary text-p3">
              <UiExactAmount :exact="formatExactAmount(position.assets, vault.asset.decimals, vault.asset.symbol)">
                {{ formatSmartAmount(assetAmount) }} {{ vault.asset.symbol }}
              </UiExactAmount>
            </div>
          </div>
        </div>
        <div
          class="flex flex-wrap items-center gap-8 laptop:flex-nowrap laptop:[&>*]:whitespace-nowrap"
          @click.stop
        >
          <UiButton
            :to="isGeoBlocked ? undefined : { path: `/lend/${vault.address}/`, query: { network: $route.query.network } }"
            :disabled="isGeoBlocked"
            rounded
          >
            Supply
          </UiButton>
          <UiButton
            variant="primary-stroke"
            :to="{ path: `/lend/${vault.address}/${subAccountIndex}/withdraw`, query: { network: $route.query.network } }"
            rounded
          >
            Withdraw
          </UiButton>
          <UiButton
            variant="primary-stroke"
            :to="isGeoBlocked ? undefined : { path: `/lend/${vault.address}/${subAccountIndex}/swap`, query: { network: $route.query.network } }"
            :disabled="isGeoBlocked"
            rounded
          >
            Asset swap
          </UiButton>
        </div>
      </div>
    </div>
  </div>

  <!-- Regular vault display -->
  <div
    v-else
    class="block no-underline bg-surface rounded-xl border border-line-subtle shadow-card cursor-pointer transition-all duration-default ease-default hover:shadow-card-hover hover:border-line-emphasis"
    @click="onClick"
  >
    <div class="flex py-16 px-16 pb-12 border-b border-line-default">
      <div class="flex w-full">
        <AssetAvatar
          :asset="vault.asset"
          size="40"
        />
        <div class="flex-grow ml-12">
          <div class="text-content-tertiary text-p3 mb-4 flex items-center gap-4">
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
              title="This vault has been deprecated."
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
          <div class="text-content-tertiary text-p3 mb-4 flex items-center gap-4">
            Supply APY
            <SvgIcon
              class="!w-16 !h-16 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
              name="info-circle"
              @click.stop="onSupplyInfoIconClick"
            />
          </div>
          <div class="text-p2 flex text-accent-600">
            <SvgIcon
              v-if="rewardsExist"
              name="sparks"
              class="!w-20 !h-20 text-accent-600 mr-4 cursor-pointer"
              @click.stop="onSupplyInfoIconClick"
            />
            {{ formatNumber(supplyApyWithRewards) }}%
          </div>
        </div>
      </div>
    </div>
    <div class="flex py-12 px-16 pb-16">
      <div class="flex flex-col gap-12 w-full">
        <PortfolioNotice :notice="vaultNotice" />
        <VaultWarningBanner :warnings="[utilisationWarning]" />
        <div class="flex justify-between">
          <div class="text-content-tertiary text-p3">
            Supply value
          </div>
          <div class="flex justify-between gap-8 text-right">
            <div class="text-content-primary text-p3">
              {{ supplyValueDisplay }}
            </div>
            <UiExactAmount
              v-if="hasPrice"
              class="text-content-tertiary text-p3"
              :exact="formatExactAmount(position.assets, vault.asset.decimals, vault.asset.symbol)"
            >
              ~ {{ roundAndCompactTokens(position.assets, vault.asset.decimals) }}
              {{ vault.asset.symbol }}
            </UiExactAmount>
          </div>
        </div>
        <div
          class="flex flex-wrap items-center gap-8 laptop:flex-nowrap laptop:[&>*]:whitespace-nowrap"
          @click.stop
        >
          <UiButton
            :to="isGeoBlocked ? undefined : { path: `/lend/${vault.address}/`, query: { network: $route.query.network } }"
            :disabled="isGeoBlocked"
            rounded
          >
            Supply
          </UiButton>
          <UiButton
            variant="primary-stroke"
            :to="{ path: `/lend/${vault.address}/${subAccountIndex}/withdraw`, query: { network: $route.query.network } }"
            rounded
          >
            Withdraw
          </UiButton>
          <UiButton
            variant="primary-stroke"
            :to="isGeoBlocked ? undefined : { path: `/lend/${vault.address}/${subAccountIndex}/swap`, query: { network: $route.query.network } }"
            :disabled="isGeoBlocked"
            rounded
          >
            Asset swap
          </UiButton>
        </div>
      </div>
    </div>
  </div>
</template>
