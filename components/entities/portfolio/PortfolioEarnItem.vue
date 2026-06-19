<script setup lang="ts">
import type { EulerEarn, PortfolioSavingsPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { getSubAccountId as getSubAccountIndex } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'
import { formatAssetValue, getAssetUsdValue } from '~/utils/sdk-prices'
import { isVaultBlockedByCountry } from '~/composables/useGeoBlock'
import { isVaultDeprecated, getVaultNotice } from '~/utils/eulerLabelsUtils'

import { VaultOverviewModal, VaultSupplyApyModal, UiModalPreviewTrigger } from '#components'
import { useModal } from '~/components/ui/composables/useModal'
import { formatNumber, formatCompactUsdValue, formatExactAmount } from '~/utils/string-utils'
import { roundAndCompactTokens } from '~/utils/crypto-utils'
import { getVaultIntrinsicApy, getVaultIntrinsicApyInfo } from '~/utils/vault-intrinsic-apy'

const { position } = defineProps<{ position: PortfolioSavingsPosition<VaultEntity> }>()
const modal = useModal()

const { address } = useWagmi()
const { portfolioAddress } = useEulerAccount()
const ownerAddress = computed(() => portfolioAddress.value || address.value || '')
const subAccountIndex = computed(() => {
  if (!ownerAddress.value || !position.subAccount) return 0
  return getSubAccountIndex(getAddress(ownerAddress.value), getAddress(position.subAccount))
})

const { getSupplyRewardCampaignsFromVault } = useRewardsApy()
const { settings } = useUserSettings()
const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
const { viewer, visibleTotal } = useApyVisibility()

const vault = computed(() => position.vault as EulerEarn)
const positionKey = computed(() => `${position.subAccount.toLowerCase()}:${vault.value.address.toLowerCase()}`)
const { modifiedKeys, removedKeys } = useTxBatch()
const isSimulatedRemoved = computed(() => removedKeys.value.has(positionKey.value))
const isSimulatedModified = computed(() => !isSimulatedRemoved.value && modifiedKeys.value.has(positionKey.value))
const apyBreakdown = computed(() => position.getApyBreakdown({ viewer: viewer.value }))
const rewardsExist = computed(() =>
  settings.value.enableRewardsApy && (apyBreakdown.value?.rewards ?? 0) > 0,
)
const { isVerifiedVault } = useVaultRegistry()

const product = useEulerProductOfVault(computed(() => vault.value.address))
const isGeoBlocked = computed(() => isVaultBlockedByCountry(vault.value.address))
const isDeprecated = computed(() => isVaultDeprecated(vault.value.address))
const isUnverified = computed(() => !isVerifiedVault(vault.value.address))
const vaultNotice = computed(() => getVaultNotice(vault.value.address))
const displayName = computed(() => product.name || vault.value.shares.name)

const supplyValueDisplay = ref('-')

const updateSupplyValueDisplay = async () => {
  const price = await formatAssetValue(position.assets, vault.value, 'off-chain')
  supplyValueDisplay.value = price.hasPrice ? formatCompactUsdValue(price.usdValue) : price.display
}

watchEffect(() => {
  updateSupplyValueDisplay()
})

const supplyApyWithRewards = computed(() => visibleTotal(apyBreakdown.value) ?? 0)

const hasPrice = ref(false)

const updateHasPrice = async () => {
  const price = await getAssetUsdValue(position.assets, vault.value, 'off-chain')
  hasPrice.value = price !== undefined && price > 0
}

watchEffect(() => {
  updateHasPrice()
})

const supplyApyModalData = computed(() => ({
  props: {
    lendingAPY: getVaultSupplyApy(vault.value),
    intrinsicAPY: getVaultIntrinsicApy(vault.value, enableIntrinsicApy.value),
    intrinsicApyInfo: getVaultIntrinsicApyInfo(vault.value, enableIntrinsicApy.value),
    campaigns: getSupplyRewardCampaignsFromVault(vault.value),
    rewardVaultAddress: vault.value.address,
    baseApyAverageLabel: '1h',
  },
}))

const onClick = () => {
  if (isSimulatedRemoved.value) return
  modal.open(VaultOverviewModal, {
    props: {
      title: 'Vault information',
      earnVault: vault,
    },
  })
}
</script>

<template>
  <div
    class="relative block overflow-hidden no-underline bg-surface rounded-xl border border-line-subtle shadow-card transition-all duration-default ease-default"
    :class="[
      isSimulatedRemoved
        ? '!border !border-dashed !border-line-emphasis'
        : 'cursor-pointer hover:shadow-card-hover hover:border-line-emphasis',
      { '!border !border-dashed !border-accent-600': isSimulatedModified },
    ]"
    data-id="portfolio-list-item"
    :data-modal-trigger="isSimulatedRemoved ? undefined : 'vault-information'"
    data-list="earn"
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
        <div
          class="flex w-full"
        >
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
              <span class="inline-flex items-center rounded-8 px-8 py-2 bg-accent-100 text-accent-600 text-p5">
                1h
              </span>
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
            <div
              class="text-p2 flex text-accent-600"
              data-id="data-point"
              :data-key="positionKey"
              data-field="supply-apy"
              :data-value="supplyApyWithRewards"
            >
              <UiModalPreviewTrigger
                v-if="rewardsExist"
                :component="VaultSupplyApyModal"
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
        <div
          class="flex flex-col gap-12 w-full"
        >
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
                :data-value="supplyValueDisplay"
              >
                {{ supplyValueDisplay }}
              </div>
              <UiExactAmount
                v-if="hasPrice"
                class="text-content-tertiary text-p3"
                :exact="formatExactAmount(position.assets, vault.asset.decimals, vault.asset.symbol)"
              >
                ~ {{ roundAndCompactTokens(position.assets, vault.asset.decimals) }} {{ vault.asset.symbol }}
              </UiExactAmount>
            </div>
          </div>
          <div
            v-if="!isSimulatedRemoved"
            class="flex justify-between items-center gap-8"
            @click.stop
          >
            <UiButton
              :to="isGeoBlocked ? undefined : { path: `/earn/${vault.address}/`, query: { network: $route.query.network } }"
              :disabled="isGeoBlocked"
              rounded
            >
              Supply
            </UiButton>
            <UiButton
              variant="primary-stroke"
              :to="{ path: `/earn/${vault.address}/${subAccountIndex}/withdraw`, query: { network: $route.query.network } }"
              rounded
            >
              Withdraw
            </UiButton>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
