<script setup lang="ts">
import { useAccount } from '@wagmi/vue'
import type { Vault } from '~/entities/vault'
import { getUtilisationWarning } from '~/composables/useVaultWarnings'
import { getAssetUsdValue, formatAssetValue } from '~/services/pricing/priceProvider'
import { isVaultBlockedByCountry } from '~/composables/useGeoBlock'
import { formatNumber, compactNumber, formatCompactUsdValue, formatSmartAmount } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import { type AccountDepositPosition, getSubAccountIndex } from '~/entities/account'
import { VaultOverviewModal, VaultSupplyApyModal } from '#components'
import { useModal } from '~/components/ui/composables/useModal'

const { position } = defineProps<{ position: AccountDepositPosition }>()
const modal = useModal()

const { address } = useAccount()
const { portfolioAddress } = useEulerAccount()
const ownerAddress = computed(() => portfolioAddress.value || address.value || '')
const _subAccountIndex = computed(() => {
  if (!ownerAddress.value || !position.subAccount) return 0
  return getSubAccountIndex(ownerAddress.value, position.subAccount)
})

const { withIntrinsicSupplyApy, getIntrinsicApy, getIntrinsicApyInfo } = useIntrinsicApy()
const { getSupplyRewardApy, hasSupplyRewards, getSupplyRewardCampaigns } = useRewardsApy()

const vault = computed(() => position.vault)
const utilisationWarning = computed(() => {
  if ('type' in vault.value && vault.value.type === 'securitize') return null
  return getUtilisationWarning(vault.value as Vault, 'lend')
})

// Check if securitize vault by type field
const isSecuritize = computed(() => 'type' in vault.value && vault.value.type === 'securitize')
const regularVault = computed(() => isSecuritize.value ? null : vault.value as Vault)

const rewardsExist = computed(() => hasSupplyRewards(vault.value.address))
const supplyApy = computed(() => {
  return withIntrinsicSupplyApy(
    nanoToValue(vault.value.interestRateInfo.supplyAPY, 25),
    vault.value.asset.address,
  )
})
const supplyApyWithRewards = computed(() => supplyApy.value + getSupplyRewardApy(vault.value.address))

const product = useEulerProductOfVault(computed(() => vault.value.address))
const isGeoBlocked = computed(() => isVaultBlockedByCountry(vault.value.address))
const isEscrow = computed(() => 'vaultCategory' in vault.value && vault.value.vaultCategory === 'escrow')
const isUnverified = computed(() => 'verified' in vault.value && !vault.value.verified)
const displayName = computed(() => {
  if (isEscrow.value) return 'Escrowed collateral'
  return product.name || vault.value.name
})

const supplyValueDisplay = ref('-')

const updateSupplyValueDisplay = async () => {
  if (!regularVault.value) {
    supplyValueDisplay.value = `${formatSmartAmount(nanoToValue(position.assets, vault.value.asset.decimals))} ${vault.value.asset.symbol}`
    return
  }
  const price = await formatAssetValue(position.assets, regularVault.value, 'off-chain')
  supplyValueDisplay.value = price.hasPrice ? formatCompactUsdValue(price.usdValue) : price.display
}

watchEffect(() => {
  updateSupplyValueDisplay()
})

const hasPrice = ref(false)

const updateHasPrice = async () => {
  if (!regularVault.value) {
    hasPrice.value = false
    return
  }
  const price = await getAssetUsdValue(position.assets, regularVault.value, 'off-chain')
  hasPrice.value = price !== undefined && price > 0
}

watchEffect(() => {
  updateHasPrice()
})

const projectedEarningsPerMonth = ref('—')

const updateProjectedEarningsPerMonth = async () => {
  if (!regularVault.value) {
    projectedEarningsPerMonth.value = '—'
    return
  }
  const price = await getAssetUsdValue(position.assets, regularVault.value, 'off-chain')
  if (price === undefined || price === 0) {
    projectedEarningsPerMonth.value = '—'
    return
  }
  // Monthly earnings = (value * APY%) / 12
  projectedEarningsPerMonth.value = compactNumber((price * supplyApyWithRewards.value) / 12 / 100)
}

watchEffect(() => {
  updateProjectedEarningsPerMonth()
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
      lendingAPY: nanoToValue(vault.value.interestRateInfo.supplyAPY, 25),
      intrinsicAPY: getIntrinsicApy(vault.value.asset.address),
      intrinsicApyInfo: getIntrinsicApyInfo(vault.value.asset.address),
      campaigns: getSupplyRewardCampaigns(vault.value.address),
    },
  })
}

const onClick = () => {
  modal.open(VaultOverviewModal, {
    props: isSecuritize.value
      ? { securitizeVault: vault.value }
      : { vault: vault.value },
  })
}
</script>

<template>
  <div
    class="grid items-center gap-x-16 py-16 px-20 mobile:block text-content-primary border-b border-line-default last:border-b-0 hover:bg-card-hover transition-all cursor-pointer grid-cols-[2fr_repeat(3,1fr)]"
    :class="isGeoBlocked ? 'opacity-50' : ''"
    @click="onClick"
  >
    <!-- Asset -->
    <div class="flex items-center gap-12 min-w-0 mobile:mb-12">
      <AssetAvatar
        :asset="vault.asset"
        size="30"
      />
      <div class="min-w-0">
        <div class="text-content-tertiary text-p3 mb-4 flex items-center gap-8">
          <VaultDisplayName
            :name="displayName"
            :is-unverified="isUnverified"
          />
          <VaultWarningIcon
            v-if="!isSecuritize"
            :warning="utilisationWarning"
            tooltip-placement="top-start"
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

    <!-- Supply APY -->
    <div class="flex items-center gap-4 mobile:!hidden">
      <div class="text-p2 flex items-center text-accent-600 font-semibold tabular-nums">
        <SvgIcon
          v-if="rewardsExist"
          name="sparks"
          class="!w-20 !h-20 text-accent-500 mr-4 cursor-pointer"
          @click.stop="onSupplyInfoIconClick"
        />
        {{ formatNumber(supplyApyWithRewards) }}%
      </div>
      <SvgIcon
        class="!w-16 !h-16 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
        name="info-circle"
        @click.stop="onSupplyInfoIconClick"
      />
    </div>

    <!-- Supply value -->
    <div class="text-p2 text-content-primary tabular-nums mobile:!hidden">
      {{ isSecuritize ? `${formatSmartAmount(assetAmount)} ${vault.asset.symbol}` : supplyValueDisplay }}
    </div>

    <!-- Projected/month -->
    <div class="text-p2 text-content-primary tabular-nums mobile:!hidden">
      {{ (!isSecuritize && hasPrice) ? `$${projectedEarningsPerMonth}` : '—' }}
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
        <div class="text-p2 flex items-center text-accent-600 font-semibold tabular-nums">
          <SvgIcon
            v-if="rewardsExist"
            class="!w-20 !h-20 text-accent-500 mr-4"
            name="sparks"
          />
          {{ formatNumber(supplyApyWithRewards) }}%
        </div>
      </div>
      <div class="flex flex-col items-end">
        <div class="text-content-tertiary text-p3 mb-4">
          Supply value
        </div>
        <div class="text-p2 text-content-primary tabular-nums">
          {{ isSecuritize ? `${formatSmartAmount(assetAmount)} ${vault.asset.symbol}` : supplyValueDisplay }}
        </div>
      </div>
    </div>

    <div
      v-if="!isSecuritize && hasPrice"
      class="hidden mobile:!flex mobile:flex-col gap-12 py-12 pb-16"
    >
      <div class="flex w-full justify-between">
        <div class="text-content-tertiary text-p3">
          Projected earnings/month
        </div>
        <div class="text-p2 text-content-primary tabular-nums">
          ${{ projectedEarningsPerMonth }}
        </div>
      </div>
    </div>
  </div>
</template>
