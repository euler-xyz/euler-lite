<script setup lang="ts">
import { computeSupplyApyBreakdown, getSubAccountId as getSubAccountIndex, isSecuritizeCollateralVault, type EVault, type PortfolioSavingsPosition, type VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'

import { getUtilisationWarning } from '~/composables/useVaultWarnings'
import { getAssetUsdValue, formatAssetValue } from '~/utils/sdk-prices'
import { isVaultBlockedByCountry } from '~/composables/useGeoBlock'
import { isVaultDeprecated, getVaultNotice } from '~/utils/eulerLabelsUtils'
import { formatNumber, formatCompactUsdValue, formatSmartAmount, formatExactAmount } from '~/utils/string-utils'
import { nanoToValue, roundAndCompactTokens } from '~/utils/crypto-utils'
import { VaultOverviewModal, VaultApyModal, UiModalPreviewTrigger } from '#components'
import { useModal } from '~/components/ui/composables/useModal'
import { getVaultIntrinsicApyInfo } from '~/utils/vault-intrinsic-apy'

const { position } = defineProps<{ position: PortfolioSavingsPosition<VaultEntity> }>()
const modal = useModal()

const { portfolioAddress } = useEulerAccount()
// portfolioAddress is already the spy-safe acting address; a wallet
// fallback here would compute wrong position indices while a spy
// candidate is still verifying.
const ownerAddress = computed(() => portfolioAddress.value)
const subAccountIndex = computed(() => {
  if (!ownerAddress.value || !position.subAccount) return 0
  return getSubAccountIndex(getAddress(ownerAddress.value), getAddress(position.subAccount))
})

const { settings } = useUserSettings()
const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
const { getSupplyRewardCampaignsFromVault } = useRewardsApy()
const { viewer, visibleTotal, visibleBreakdown } = useApyVisibility()

const { getVault: getRegistryVault, getVaultCategory, isVerifiedVault } = useVaultRegistry()
const vault = computed(() =>
  (getRegistryVault(position.vault!.address) as VaultEntity | undefined) ?? position.vault!,
)
const positionKey = computed(() => `${position.subAccount.toLowerCase()}:${vault.value.address.toLowerCase()}`)
// Positions the active simulated batch layer modified get a dotted border.
const { modifiedKeys, removedKeys } = useTxBatch()
const isSimulatedRemoved = computed(() => removedKeys.value.has(positionKey.value))
const isSimulatedModified = computed(() => !isSimulatedRemoved.value && modifiedKeys.value.has(positionKey.value))
const utilisationWarning = computed(() => {
  if (isSecuritizeCollateralVault(vault.value)) return null
  return getUtilisationWarning(vault.value as EVault, 'lend')
})

const isSecuritize = computed(() => isSecuritizeCollateralVault(vault.value))

const apyBreakdown = computed(() => computeSupplyApyBreakdown(vault.value, viewer.value))
const rewardsExist = computed(() =>
  settings.value.enableRewardsApy && (apyBreakdown.value?.rewards ?? 0) > 0,
)
const supplyApyWithRewards = computed(() => visibleTotal(apyBreakdown.value) ?? 0)
const visibleApyBreakdown = computed(() => visibleBreakdown(apyBreakdown.value))

const product = useEulerProductOfVault(computed(() => vault.value.address))
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

// Source the breakdown rows and total from the same viewer-aware SDK breakdown
// the headline uses (visibleApyBreakdown / supplyApyWithRewards), so the tooltip
// total always matches the displayed figure instead of being recomputed.
const supplyApyModalData = computed(() => ({
  props: {
    mode: 'supply',
    lendingAPY: visibleApyBreakdown.value?.lending ?? 0,
    intrinsicAPY: visibleApyBreakdown.value?.intrinsicApy ?? 0,
    intrinsicApyInfo: getVaultIntrinsicApyInfo(vault.value, enableIntrinsicApy.value),
    campaigns: getSupplyRewardCampaignsFromVault(vault.value),
    totalSupplyAPY: supplyApyWithRewards.value,
    rewardVaultAddress: vault.value.address,
  },
}))

const onClick = () => {
  if (isSimulatedRemoved.value) return
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
    class="relative block overflow-hidden no-underline bg-surface rounded-xl border border-line-subtle shadow-card transition-all duration-default ease-default"
    :class="[
      isSimulatedRemoved
        ? '!border !border-dashed !border-line-emphasis'
        : 'cursor-pointer hover:shadow-card-hover hover:border-line-emphasis',
      { '!border !border-dashed !border-accent-600': isSimulatedModified },
    ]"
    data-id="portfolio-list-item"
    :data-modal-trigger="isSimulatedRemoved ? undefined : 'vault-information'"
    data-list="lend"
    :data-key="positionKey"
    :data-vault-address="vault.address.toLowerCase()"
    :data-sub-account="position.subAccount.toLowerCase()"
    :data-simulated-removed="isSimulatedRemoved ? 'true' : undefined"
    @click="onClick"
  >
    <div
      v-if="isSimulatedRemoved"
      class="pointer-events-none absolute inset-0 z-10"
      style="background: repeating-linear-gradient(45deg, transparent 0 9px, rgba(114, 131, 149, .06) 9px 18px);"
      aria-hidden="true"
    />
    <div
      class="relative z-0"
      :class="{ 'opacity-50 pointer-events-none': isSimulatedRemoved }"
    >
      <div class="flex py-16 px-16 pb-12 border-b border-line-default">
        <div class="flex w-full">
          <AssetAvatar
            :asset="vault.asset"
            size="40"
          />
          <div class="flex-grow ml-12">
            <div
              class="text-content-tertiary text-p3 mb-4 flex items-center gap-4"
              data-id="data-point"
              :data-key="positionKey"
              data-field="name"
              :data-value="displayName"
            >
              <VaultDisplayName
                :name="displayName"
                :is-unverified="isUnverified"
              />
              <UiHoverPreviewTooltip
                v-if="isGeoBlocked"
                title="Region restricted"
                text="This vault is not available in your region"
                placement="top-start"
              >
                <span class="inline-flex items-center gap-4 rounded-8 px-8 py-2 bg-warning-100 text-warning-500 text-p5">
                  <SvgIcon
                    name="warning"
                    class="!w-14 !h-14"
                  />
                  Restricted
                </span>
              </UiHoverPreviewTooltip>
              <UiHoverPreviewTooltip
                v-if="isDeprecated"
                title="Deprecated"
                text="This vault has been deprecated."
                placement="top-start"
              >
                <span class="inline-flex items-center gap-4 rounded-8 px-8 py-2 bg-warning-100 text-warning-500 text-p5">
                  <SvgIcon
                    name="warning"
                    class="!w-14 !h-14"
                  />
                  Deprecated
                </span>
              </UiHoverPreviewTooltip>
            </div>
            <div
              class="text-h5 text-content-primary"
              data-id="data-point"
              :data-key="positionKey"
              data-field="asset-symbol"
              :data-value="vault.asset.symbol"
            >
              {{ vault.asset.symbol }}
            </div>
          </div>
          <div class="flex flex-col items-end">
            <div class="text-content-tertiary text-p3 mb-4 flex items-center gap-4">
              Supply APY
              <UiModalPreviewTrigger
                :component="VaultApyModal"
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
            <div
              class="text-p2 flex text-accent-600"
              data-id="data-point"
              :data-key="positionKey"
              data-field="supply-apy"
              :data-value="supplyApyWithRewards"
            >
              <UiModalPreviewTrigger
                v-if="rewardsExist"
                :component="VaultApyModal"
                :modal-data="supplyApyModalData"
                aria-label="Show supply APY rewards breakdown"
              >
                <SvgIcon
                  name="sparks"
                  class="!w-20 !h-20 text-accent-600 mr-4 cursor-pointer"
                  data-modal-trigger="supply-apy"
                />
              </UiModalPreviewTrigger>
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
              <div
                class="text-content-primary text-p3"
                data-id="data-point"
                :data-key="positionKey"
                data-field="supply-value"
                :data-value="position.assets.toString()"
              >
                <UiExactAmount :exact="formatExactAmount(position.assets, vault.asset.decimals, vault.asset.symbol)">
                  {{ formatSmartAmount(assetAmount) }} {{ vault.asset.symbol }}
                </UiExactAmount>
              </div>
            </div>
          </div>
          <div
            v-if="!isSimulatedRemoved"
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
  </div>

  <!-- Regular vault display -->
  <div
    v-else
    class="relative block overflow-hidden no-underline bg-surface rounded-xl border border-line-subtle shadow-card transition-all duration-default ease-default"
    :class="[
      isSimulatedRemoved
        ? '!border !border-dashed !border-line-emphasis'
        : 'cursor-pointer hover:shadow-card-hover hover:border-line-emphasis',
      { '!border !border-dashed !border-accent-600': isSimulatedModified },
    ]"
    data-id="portfolio-list-item"
    :data-modal-trigger="isSimulatedRemoved ? undefined : 'vault-information'"
    data-list="lend"
    :data-key="positionKey"
    :data-vault-address="vault.address.toLowerCase()"
    :data-sub-account="position.subAccount.toLowerCase()"
    :data-simulated-removed="isSimulatedRemoved ? 'true' : undefined"
    @click="onClick"
  >
    <div
      v-if="isSimulatedRemoved"
      class="pointer-events-none absolute inset-0 z-10"
      style="background: repeating-linear-gradient(45deg, transparent 0 9px, rgba(114, 131, 149, .06) 9px 18px);"
      aria-hidden="true"
    />
    <div
      class="relative z-0"
      :class="{ 'opacity-50 pointer-events-none': isSimulatedRemoved }"
    >
      <div class="flex py-16 px-16 pb-12 border-b border-line-default">
        <div class="flex w-full">
          <AssetAvatar
            :asset="vault.asset"
            size="40"
          />
          <div class="flex-grow ml-12">
            <div
              class="text-content-tertiary text-p3 mb-4 flex items-center gap-4"
              data-id="data-point"
              :data-key="positionKey"
              data-field="name"
              :data-value="displayName"
            >
              <VaultDisplayName
                :name="displayName"
                :is-unverified="isUnverified"
              />
              <UiHoverPreviewTooltip
                v-if="isGeoBlocked"
                title="Region restricted"
                text="This vault is not available in your region"
                placement="top-start"
              >
                <span class="inline-flex items-center gap-4 rounded-8 px-8 py-2 bg-warning-100 text-warning-500 text-p5">
                  <SvgIcon
                    name="warning"
                    class="!w-14 !h-14"
                  />
                  Restricted
                </span>
              </UiHoverPreviewTooltip>
              <UiHoverPreviewTooltip
                v-if="isDeprecated"
                title="Deprecated"
                text="This vault has been deprecated."
                placement="top-start"
              >
                <span class="inline-flex items-center gap-4 rounded-8 px-8 py-2 bg-warning-100 text-warning-500 text-p5">
                  <SvgIcon
                    name="warning"
                    class="!w-14 !h-14"
                  />
                  Deprecated
                </span>
              </UiHoverPreviewTooltip>
            </div>
            <div
              class="text-h5 text-content-primary"
              data-id="data-point"
              :data-key="positionKey"
              data-field="asset-symbol"
              :data-value="vault.asset.symbol"
            >
              {{ vault.asset.symbol }}
            </div>
          </div>
          <div class="flex flex-col items-end">
            <div class="text-content-tertiary text-p3 mb-4 flex items-center gap-4">
              Supply APY
              <UiModalPreviewTrigger
                :component="VaultApyModal"
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
            <div
              class="text-p2 flex text-accent-600"
              data-id="data-point"
              :data-key="positionKey"
              data-field="supply-apy"
              :data-value="supplyApyWithRewards"
            >
              <UiModalPreviewTrigger
                v-if="rewardsExist"
                :component="VaultApyModal"
                :modal-data="supplyApyModalData"
                aria-label="Show supply APY rewards breakdown"
              >
                <SvgIcon
                  name="sparks"
                  class="!w-20 !h-20 text-accent-600 mr-4 cursor-pointer"
                  data-modal-trigger="supply-apy"
                />
              </UiModalPreviewTrigger>
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
              <div
                class="text-content-primary text-p3"
                data-id="data-point"
                :data-key="positionKey"
                data-field="supply-value"
                :data-value="supplyValueDisplay"
              >
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
            v-if="!isSimulatedRemoved"
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
  </div>
</template>
