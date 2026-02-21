<script setup lang="ts">
import { useAccount } from '@wagmi/vue'
import { getAddress, type Address, type Abi } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import { formatNumber, formatCompactUsdValue } from '~/utils/string-utils'
import { nanoToValue, roundAndCompactTokens } from '~/utils/crypto-utils'
import { getPublicClient } from '~/utils/public-client'
import type { AccountBorrowPosition } from '~/entities/account'
import { getSubAccountIndex } from '~/entities/account'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'
import {
  getNetAPY,
  getRoe,
  type Vault,
  type SecuritizeVault,
} from '~/entities/vault'
import { getUtilisationWarning } from '~/composables/useVaultWarnings'
import {
  getAssetUsdValue,
  formatAssetValue,
  getCollateralUsdValue,
  toUsdAmount,
  type UsdAmount,
} from '~/services/pricing/priceProvider'
import { eulerAccountLensABI } from '~/entities/euler/abis'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { isAnyVaultBlockedByCountry } from '~/composables/useGeoBlock'

const { position } = defineProps<{ position: AccountBorrowPosition }>()

const { address } = useAccount()
const { portfolioAddress } = useEulerAccount()
const ownerAddress = computed(() => portfolioAddress.value || address.value || '')
const subAccountIndex = computed(() => {
  if (!ownerAddress.value || !position.subAccount) return 0
  return getSubAccountIndex(ownerAddress.value, position.subAccount)
})

const { withIntrinsicBorrowApy, withIntrinsicSupplyApy } = useIntrinsicApy()
const { getSupplyRewardApy, getBorrowRewardApy } = useRewardsApy()

const { name: collateralProductName } = useEulerProductOfVault(position.collateral.address)
const { name: borrowProductName } = useEulerProductOfVault(position.borrow.address)

type PositionCollateral = {
  vault: Vault | SecuritizeVault
  assets: bigint
}

const collateralItems = ref<PositionCollateral[]>([])
const { isReady: isVaultsReady } = useVaults()
const { getOrFetch } = useVaultRegistry()
const { eulerLensAddresses, isReady: isEulerAddressesReady, loadEulerConfig } = useEulerAddresses()
const { EVM_PROVIDER_URL } = useEulerConfig()

const hasQueryFailure = computed(() => Boolean(position.liquidityQueryFailure))

const borrowVault = computed(() => position.borrow)
const utilisationWarning = computed(() => getUtilisationWarning(position.borrow, 'borrow'))
const collateralVault = computed(() => position.collateral)
const hasMultipleCollaterals = computed(() => (position.collaterals?.length || 0) > 1)
const collateralSymbolLabel = computed(() => {
  const symbol = position.collateral.asset.symbol
  return hasMultipleCollaterals.value ? `${symbol} & others` : symbol
})
const pairSymbols = computed(() => `${collateralSymbolLabel.value}/${position.borrow.asset.symbol}`)

const isGeoBlocked = computed(() => isAnyVaultBlockedByCountry(position.collateral.address, position.borrow.address))

const isAnyUnverified = computed(() => {
  const collateralUnverified = 'verified' in position.collateral && !position.collateral.verified
  const borrowUnverified = 'verified' in position.borrow && !position.borrow.verified
  return collateralUnverified || borrowUnverified
})

const collateralLabel = computed(() => {
  if ('vaultCategory' in position.collateral && position.collateral.vaultCategory === 'escrow') {
    return 'Escrowed collateral'
  }
  return collateralProductName || position.collateral.name
})
const borrowLabel = computed(() => borrowProductName || position.borrow.name)

const pairName = computed(() => {
  if (collateralLabel.value === borrowLabel.value) {
    return collateralLabel.value
  }
  return `${collateralLabel.value} / ${borrowLabel.value}`
})
const supplyRewardAPY = computed(() => getSupplyRewardApy(collateralVault.value.address || ''))
const borrowRewardAPY = computed(() => getBorrowRewardApy(borrowVault.value.address || '', collateralVault.value.address || ''))
const collateralSupplyApy = computed(() => {
  return withIntrinsicSupplyApy(
    nanoToValue(collateralVault.value.interestRateInfo.supplyAPY || 0n, 25),
    collateralVault.value?.asset.address,
  )
})
const borrowApy = computed(() => withIntrinsicBorrowApy(
  nanoToValue(borrowVault.value?.interestRateInfo.borrowAPY || 0n, 25),
  borrowVault.value?.asset.address,
))

const collateralValue = ref<UsdAmount>({ usd: 0, hasPrice: false })

const updateCollateralValue = async () => {
  // Collateral price ALWAYS comes from liability vault's oracle, converted to USD
  if (!collateralItems.value.length) {
    collateralValue.value = toUsdAmount(await getCollateralUsdValue(position.supplied, position.borrow, position.collateral, 'off-chain'))
    return
  }

  // For multiple collaterals, sum up using liability vault's oracle for each
  const promises = collateralItems.value.map(item =>
    getCollateralUsdValue(item.assets, position.borrow, item.vault, 'off-chain'),
  )
  const values = await Promise.all(promises)
  const allHavePrice = values.every(v => v !== undefined)
  collateralValue.value = {
    usd: values.reduce<number>((total, val) => total + (val ?? 0), 0),
    hasPrice: allHavePrice,
  }
}

watchEffect(() => {
  updateCollateralValue()
})

const collateralValueDisplay = computed(() => {
  return collateralValue.value.hasPrice
    ? formatCompactUsdValue(collateralValue.value.usd)
    : `${roundAndCompactTokens(collateralItems.value[0]?.assets ?? 0n, BigInt(position.collateral.decimals))} ${position.collateral.asset.symbol}`
})

const borrowedValueInfo = ref<{ display: string, hasPrice: boolean }>({ display: '-', hasPrice: false })

const updateBorrowedValueInfo = async () => {
  const price = await formatAssetValue(position.borrowed ?? 0n, borrowVault.value!, 'off-chain')
  borrowedValueInfo.value = {
    display: price.hasPrice ? formatCompactUsdValue(price.usdValue) : price.display,
    hasPrice: price.hasPrice,
  }
}

watchEffect(() => {
  updateBorrowedValueInfo()
})

const borrowedValueDisplay = computed(() => borrowedValueInfo.value.display)

const borrowedValue = ref<UsdAmount>({ usd: 0, hasPrice: false })

const updateBorrowedValue = async () => {
  borrowedValue.value = toUsdAmount(await getAssetUsdValue(position.borrowed, borrowVault.value, 'off-chain'))
}

watchEffect(() => {
  updateBorrowedValue()
})

const netAssetValue = computed<UsdAmount>(() => {
  if (!collateralValue.value.hasPrice || !borrowedValue.value.hasPrice) {
    return { usd: 0, hasPrice: false }
  }
  return {
    usd: collateralValue.value.usd - borrowedValue.value.usd,
    hasPrice: true,
  }
})

const netAssetValueDisplay = computed(() => {
  return netAssetValue.value.hasPrice ? formatCompactUsdValue(netAssetValue.value.usd) : '-'
})

const netAPY = computed(() => {
  return getNetAPY(
    collateralValue.value.usd,
    collateralSupplyApy.value,
    borrowedValue.value.usd,
    borrowApy.value,
    supplyRewardAPY.value || null,
    borrowRewardAPY.value || null,
  )
})

const roe = computed(() => {
  return getRoe(
    collateralValue.value.usd,
    collateralSupplyApy.value,
    borrowedValue.value.usd,
    borrowApy.value,
    supplyRewardAPY.value || null,
    borrowRewardAPY.value || null,
  )
})

const loadCollaterals = async () => {
  // Only load additional collaterals if position has multiple,
  // unless oracle failed — then always fetch actual assets from lens
  if ((!position.collaterals?.length || position.collaterals.length <= 1) && !position.liquidityQueryFailure) return

  const collateralAddresses = position.collaterals?.length
    ? position.collaterals
    : [position.collateral.address]

  const normalized = collateralAddresses.reduce<string[]>((acc, address) => {
    try {
      acc.push(getAddress(address))
    }
    catch {
      return acc
    }
    return acc
  }, [])

  const primaryAddress = getAddress(position.collateral.address)
  const unique = Array.from(new Set(normalized))
  const orderedAddresses = [primaryAddress, ...unique.filter(address => address !== primaryAddress)]

  try {
    if (!isEulerAddressesReady.value) {
      await loadEulerConfig()
    }

    await until(isVaultsReady).toBe(true)

    const lensAddress = eulerLensAddresses.value?.accountLens
    if (!lensAddress) {
      throw new Error('Account lens address is not available')
    }

    const client = getPublicClient(EVM_PROVIDER_URL)

    const items = await Promise.all(
      orderedAddresses.map(async (address) => {
        try {
          const vault = await getOrFetch(address) as Vault | SecuritizeVault | undefined
          let assets = 0n

          try {
            const res = await client.readContract({
              address: lensAddress as Address,
              abi: eulerAccountLensABI as Abi,
              functionName: 'getVaultAccountInfo',
              args: [position.subAccount, address],
            }) as Record<string, any>
            assets = res.assets
          }
          catch {
            if (address === primaryAddress) {
              assets = position.supplied
            }
          }

          return { vault, assets }
        }
        catch (e) {
          logWarn('[PortfolioBorrowItem] failed to load collateral vault', e, { data: address })
          return null
        }
      }),
    )

    collateralItems.value = items.filter((item): item is PositionCollateral => !!item)
  }
  catch (e) {
    logWarn('[PortfolioBorrowItem] failed to load collaterals', e)
  }
}

// Initialize collateralItems - for securitize, we won't load additional collaterals
collateralItems.value = [{
  vault: position.collateral,
  assets: position.supplied,
}]

onMounted(() => {
  loadCollaterals()
})
</script>

<template>
  <NuxtLink
    :to="`/position/${subAccountIndex}`"
    class="block no-underline bg-surface rounded-xl border border-line-default transition-all duration-default ease-default hover:shadow-card-hover hover:border-line-emphasis"
  >
    <div class="flex py-16 px-16 pb-12 border-b border-line-default">
      <div
        class="flex flex-col gap-12 items-start w-full"
      >
        <div
          class="text-h6 text-content-secondary bg-surface-secondary py-4 px-12 rounded-8 border border-line-default"
        >
          Position {{ subAccountIndex }}
        </div>
        <div class="flex gap-12 w-full">
          <AssetAvatar
            :asset="[position.collateral.asset, position.borrow.asset]"
            size="40"
          />
          <div class="flex-grow min-w-0">
            <div class="text-content-tertiary text-p3 mb-4 flex items-center gap-4">
              <VaultDisplayName
                :name="pairName"
                :is-unverified="isAnyUnverified"
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
            <div class="text-h5 text-content-primary truncate">
              {{ pairSymbols }}
            </div>
          </div>
          <div class="flex gap-16 items-start shrink-0">
            <div class="flex flex-col items-end">
              <div class="text-content-tertiary text-p3 mb-4">
                Net APY
              </div>
              <div
                class="text-p2"
                :class="[netAPY >= 0 ? 'text-accent-600' : 'text-error-500']"
              >
                {{ Number.isFinite(netAPY) ? `${formatNumber(netAPY)}%` : '-' }}
              </div>
            </div>
            <div class="flex flex-col items-end">
              <div class="text-content-tertiary text-p3 mb-4">
                ROE
              </div>
              <div
                class="text-p2"
                :class="[roe >= 0 ? 'text-accent-600' : 'text-error-500']"
              >
                {{ Number.isFinite(roe) ? `${formatNumber(roe)}%` : '-' }}
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
    <div class="flex py-12 px-16 pb-16">
      <div
        class="flex flex-col gap-12 w-full"
      >
        <div
          v-if="hasQueryFailure"
          class="flex items-center gap-6 text-warning-500 text-p4"
        >
          <UiIcon
            name="info-circle"
            class="!w-14 !h-14 shrink-0"
          />
          Oracle pricing unavailable. Some details may be missing.
        </div>
        <div class="flex justify-between">
          <div class="text-content-tertiary text-p3">
            Net asset value
          </div>
          <div class="flex justify-between gap-8 text-right">
            <div class="text-content-primary text-p3">
              {{ netAssetValueDisplay }}
            </div>
          </div>
        </div>
        <div class="flex justify-between">
          <div class="text-content-tertiary text-p3">
            My Debt
          </div>
          <div class="flex justify-between gap-8 text-right">
            <div class="text-content-primary text-p3">
              {{ borrowedValueDisplay }}
            </div>
            <div
              v-if="borrowedValueInfo.hasPrice"
              class="text-content-tertiary text-p3"
            >
              ~ {{ roundAndCompactTokens(position.borrowed, position.borrow.decimals) }}
              {{ position.borrow.asset.symbol }}
            </div>
          </div>
        </div>
        <div class="flex justify-between">
          <div class="text-content-tertiary text-p3">
            Collateral value
          </div>
          <div class="flex justify-between gap-8 text-right">
            <div class="text-content-primary text-p3">
              {{ collateralValueDisplay }}
            </div>
            <div
              v-if="collateralValue.hasPrice"
              class="text-content-tertiary text-p3"
            >
              ~ {{ roundAndCompactTokens(collateralItems[0].assets, position.collateral.decimals) }}
              {{ position.collateral.asset.symbol }} {{ collateralItems.length > 1 ? '& others' : '' }}
            </div>
          </div>
        </div>
        <div class="flex justify-between">
          <div class="text-content-tertiary text-p3">
            Health score
            <VaultWarningIcon
              :warning="utilisationWarning"
              tooltip-placement="top-start"
            />
          </div>
          <div class="text-content-primary text-p3">
            <span
              v-if="hasQueryFailure"
              class="text-warning-500"
            >Unknown</span>
            <template v-else>
              {{ formatNumber(nanoToValue(position.health, 18)) }}
            </template>
          </div>
        </div>
        <div class="flex justify-between">
          <div class="text-content-tertiary text-p3">
            Your LTV
          </div>
          <template v-if="hasQueryFailure">
            <span class="text-warning-500 text-p3">Unknown</span>
          </template>
          <template v-else>
            <div class="flex justify-between items-center gap-16">
              <UiProgress
                style="width: 111px"
                :model-value="nanoToValue(position.userLTV, 18)"
                :max="nanoToValue(position.liquidationLTV, 2)"
                :color="nanoToValue(position.userLTV, 18) >= (nanoToValue(position.liquidationLTV, 2) - 2) ? 'danger' : undefined"
                size="small"
              />
              <div class="flex justify-between gap-8 text-right">
                <div class="text-content-primary text-p3">
                  {{ formatNumber(nanoToValue(position.userLTV, 18), 2) }}/{{ nanoToValue(position.liquidationLTV, 2) }}%
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </NuxtLink>
</template>
