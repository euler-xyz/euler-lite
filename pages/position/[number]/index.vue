<script setup lang="ts">
import { useAccount } from '@wagmi/vue'
import { getAddress, type Address, type Abi } from 'viem'
import { eulerAccountLensABI } from '~/entities/euler/abis'
import {
  getNetAPY,
  getRoe,
  type Vault,
  type SecuritizeVault,
} from '~/entities/vault'
import { getUtilisationWarning, getBorrowCapWarning } from '~/composables/useVaultWarnings'
import {
  getAssetUsdValue,
  getAssetUsdPrice,
  getCollateralUsdPrice,
  getCollateralUsdValue,
  getUnitOfAccountUsdRate,
  toUsdAmount,
  type UsdAmount,
} from '~/services/pricing/priceProvider'
import { type AccountBorrowPosition, isPositionEligibleForLiquidation } from '~/entities/account'
import type { TxPlan } from '~/entities/txPlan'
import { formatTtl, nanoToValue, roundAndCompactTokens } from '~/utils/crypto-utils'
import { formatNumber, formatHealthScore, formatUsdValue, formatCompactUsdValue } from '~/utils/string-utils'
import { isAnyVaultBlockedByCountry, isVaultRestrictedByCountry } from '~/composables/useGeoBlock'
import { getVaultNotice } from '~/utils/eulerLabelsUtils'
import { VaultOverviewModal, OperationReviewModal, VaultSupplyApyModal, VaultBorrowApyModal, VaultNetApyModal, PortfolioRoeModal } from '#components'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import { useVaultRegistry } from '~/composables/useVaultRegistry'

const _route = useRoute()
const router = useRouter()
const modal = useModal()
const { error } = useToast()
const { isConnected } = useAccount()
const { isSpyMode } = useSpyMode()
const { isPositionsLoaded, isPositionsLoading, getPositionBySubAccountIndex } = useEulerAccount()
const { withIntrinsicBorrowApy, withIntrinsicSupplyApy, getIntrinsicApy, getIntrinsicApyInfo } = useIntrinsicApy()
const { getSupplyRewardApy, getBorrowRewardApy, hasSupplyRewards, hasBorrowRewards, getSupplyRewardCampaigns, getBorrowRewardCampaigns } = useRewardsApy()
const { buildDisableCollateralPlan, executeTxPlan } = useEulerOperations()
const {
  runSimulation: runDisableCollateralSimulation,
  simulationError: disableCollateralSimulationError,
  clearSimulationError: clearDisableCollateralSimulationError,
} = useTxPlanSimulation()

const positionIndex = usePositionIndex()

type PositionCollateral = {
  vault: Vault | SecuritizeVault
  assets: bigint
}

const position: Ref<AccountBorrowPosition | undefined> = ref()
const isSubmitting = ref(false)
const isPreparing = ref(false)
const collateralItems = ref<PositionCollateral[]>([])
const isCollateralsLoading = ref(false)
const disableCollateralErrorVault = ref<string | null>(null)

const { isReady: isVaultsReady } = useVaults()
const { getOrFetch } = useVaultRegistry()
const { eulerLensAddresses, isReady: isEulerAddressesReady, loadEulerConfig } = useEulerAddresses()
const { client: rpcClient } = useRpcClient()

const borrowVault = computed(() => position.value?.borrow)
const collateralVault = computed(() => position.value?.collateral)
const primaryCollateralAddress = computed(() => position.value ? getAddress(position.value.collateral.address) : '')
const collateralCount = computed(() => position.value?.collaterals?.length ?? collateralItems.value.length)
const collateralSymbolLabel = computed(() => {
  if (!position.value) {
    return ''
  }
  const symbol = position.value.collateral.asset.symbol
  return collateralCount.value > 1 ? `${symbol} & others` : symbol
})
const pairAssetsLabel = computed(() => {
  if (!position.value) {
    return ''
  }
  return `${collateralSymbolLabel.value}/${position.value.borrow.asset.symbol}`
})
const pairAssets = computed(() => {
  if (!collateralVault.value || !borrowVault.value) return []
  return [collateralVault.value.asset, borrowVault.value.asset]
})
const hasNoBorrow = computed(() => position.value?.borrow.borrow === 0n)
const hasQueryFailure = computed(() => Boolean(position.value?.liquidityQueryFailure))
const isEligibleForLiquidation = computed(() => isPositionEligibleForLiquidation(position.value))
const isPositionGeoBlocked = computed(() => {
  if (!position.value) return false
  const addresses = [position.value.borrow.address]
  const collateralAddresses = position.value.collaterals?.length
    ? position.value.collaterals
    : [position.value.collateral.address]
  addresses.push(...collateralAddresses)
  return isAnyVaultBlockedByCountry(...addresses)
})

const isOverBorrowLTV = computed(() => {
  if (!position.value || hasNoBorrow.value) return false
  const userLtv = nanoToValue(position.value.userLTV, 18)
  const borrowLtv = nanoToValue(position.value.borrowLTV, 2)
  return borrowLtv > 0 && userLtv >= borrowLtv
})

const isBorrowRestricted = computed(() =>
  position.value ? isVaultRestrictedByCountry(position.value.borrow.address) : false)

const isMultiplyRestricted = computed(() => {
  if (!position.value) return false
  return isVaultRestrictedByCountry(position.value.borrow.address)
    || isVaultRestrictedByCountry(position.value.collateral.address)
})

// Both vaults restricted = pair effectively blocked (no borrow, no multiply, no useful swaps)
const isPairFullyRestricted = computed(() => {
  if (!position.value) return false
  return isVaultRestrictedByCountry(position.value.borrow.address)
    && isVaultRestrictedByCountry(position.value.collateral.address)
})

const borrowVaultNotice = computed(() => {
  if (!position.value) return ''
  return getVaultNotice(position.value.borrow.address)
})

const getCollateralNotice = (vaultAddress: string): string => getVaultNotice(vaultAddress)

const supplyRewardAPY = computed(() => getSupplyRewardApy(collateralVault.value?.address || ''))
const borrowRewardAPY = computed(() => getBorrowRewardApy(borrowVault.value?.address || '', collateralVault.value?.address || ''))
const baseSupplyAPY = computed(() => {
  return nanoToValue(collateralVault.value?.interestRateInfo.supplyAPY || 0n, 25)
})
const baseBorrowAPY = computed(() => nanoToValue(borrowVault.value?.interestRateInfo.borrowAPY || 0n, 25))
const _intrinsicSupplyAPY = computed(() => getIntrinsicApy(collateralVault.value?.asset.address))
const intrinsicBorrowAPY = computed(() => getIntrinsicApy(borrowVault.value?.asset.address))
const collateralSupplyApy = computed(() => withIntrinsicSupplyApy(
  baseSupplyAPY.value,
  collateralVault.value?.asset.address,
))
const borrowApy = computed(() => withIntrinsicBorrowApy(
  baseBorrowAPY.value,
  borrowVault.value?.asset.address,
))
const borrowApyWithRewards = computed(() => borrowApy.value - borrowRewardAPY.value)

// Warnings for borrow vault
const positionWarnings = computed(() => {
  if (!borrowVault.value) return []
  return [
    getUtilisationWarning(borrowVault.value, 'borrow'),
    getBorrowCapWarning(borrowVault.value),
  ]
})

// Pre-computed collateral row data (USD values computed asynchronously)
const collateralRowsData = ref<{
  value: UsdAmount
  unitPriceUsd: number
  oraclePriceUsd: number
  supplyApy: number
  supplyApyWithRewards: number
}[]>([])

const collateralRows = computed(() => {
  return collateralItems.value.map((item, index) => {
    const data = collateralRowsData.value[index] || {
      value: { usd: 0, hasPrice: false },
      unitPriceUsd: 0,
      oraclePriceUsd: 0,
      supplyApy: 0,
      supplyApyWithRewards: 0,
    }
    return {
      ...item,
      ...data,
    }
  })
})

// Update collateral rows data when collateral items change
watchEffect(async () => {
  if (!position.value || !collateralItems.value.length) {
    collateralRowsData.value = []
    return
  }

  const results = await Promise.all(
    collateralItems.value.map(async (item) => {
      const rewardApy = getSupplyRewardApy(item.vault.address || '')
      const supplyApy = withIntrinsicSupplyApy(
        nanoToValue(item.vault.interestRateInfo.supplyAPY || 0n, 25),
        item.vault.asset.address,
      )

      // Collateral price ALWAYS comes from liability vault's oracle, converted to USD
      let unitPriceUsd = 0
      let oraclePriceUsd = 0

      const valueRaw = await getCollateralUsdValue(item.assets, position.value!.borrow, item.vault as Vault, 'off-chain')
      const priceInfo = await getCollateralUsdPrice(position.value!.borrow, item.vault as Vault, 'off-chain')
      if (priceInfo) {
        unitPriceUsd = nanoToValue(priceInfo.amountOutMid, 18)
      }

      const oraclePriceInfo = await getCollateralUsdPrice(position.value!.borrow, item.vault as Vault, 'on-chain')
      if (oraclePriceInfo) {
        oraclePriceUsd = nanoToValue(oraclePriceInfo.amountOutMid, 18)
      }

      return {
        value: toUsdAmount(valueRaw),
        unitPriceUsd,
        oraclePriceUsd,
        supplyApy,
        supplyApyWithRewards: supplyApy + rewardApy,
      }
    }),
  )

  collateralRowsData.value = results
})

// Pre-computed collateral USD value (async)
const collateralValue = ref<UsdAmount>({ usd: 0, hasPrice: false })

watchEffect(async () => {
  if (!position.value) {
    collateralValue.value = { usd: 0, hasPrice: false }
    return
  }

  // Collateral price ALWAYS comes from liability vault's oracle, converted to USD
  if (!collateralItems.value.length) {
    collateralValue.value = toUsdAmount(await getCollateralUsdValue(position.value.supplied, position.value.borrow, position.value.collateral as Vault, 'off-chain'))
    return
  }

  // For multiple collaterals, sum up using liability vault's oracle for each
  const totals = await Promise.all(
    collateralItems.value.map(item =>
      getCollateralUsdValue(item.assets, position.value!.borrow, item.vault as Vault, 'off-chain'),
    ),
  )
  const allHavePrice = totals.every(v => v !== undefined)
  collateralValue.value = {
    usd: totals.reduce<number>((sum, val) => sum + (val ?? 0), 0),
    hasPrice: allHavePrice,
  }
})

// Pre-computed borrow market value in USD (async)
const borrowMarketValue = ref<UsdAmount>({ usd: 0, hasPrice: false })

watchEffect(async () => {
  if (!position.value || !borrowVault.value) {
    borrowMarketValue.value = { usd: 0, hasPrice: false }
    return
  }

  borrowMarketValue.value = toUsdAmount(await getAssetUsdValue(position.value.borrowed, borrowVault.value, 'off-chain'))
})

// Net asset value in USD: sync computed so it tracks both collateralValue and borrowMarketValue
const netAssetValue = computed<UsdAmount>(() => {
  if (!position.value) return { usd: 0, hasPrice: false }
  if (!collateralValue.value.hasPrice || !borrowMarketValue.value.hasPrice) {
    return { usd: 0, hasPrice: false }
  }
  return {
    usd: collateralValue.value.usd - borrowMarketValue.value.usd,
    hasPrice: true,
  }
})

// Pre-computed unit of account USD price (async)
const unitOfAccountUsdPrice = ref<number>(0)
watchEffect(async () => {
  if (!position.value) {
    unitOfAccountUsdPrice.value = 0
    return
  }
  const rate = await getUnitOfAccountUsdRate(borrowVault.value)
  unitOfAccountUsdPrice.value = rate ? nanoToValue(rate, 18) : 0
})

// Pre-computed liquidation price (depends on async unitOfAccountUsdPrice)
const liquidationPrice = computed(() => {
  if (!position.value) return undefined

  const price = position.value.price || 0n

  if (price <= 0n) {
    return undefined
  }

  const unitPrice = unitOfAccountUsdPrice.value
  if (!unitPrice) {
    return undefined
  }

  return nanoToValue(price, 18) * unitPrice
})
// Pre-computed borrow liquidation price (async)
const borrowLiquidationPrice = ref<number | undefined>(undefined)

watchEffect(async () => {
  if (!position.value) {
    borrowLiquidationPrice.value = undefined
    return
  }

  const collateralValueLiquidation = position.value.collateralValueLiquidation
  const liabilityValueBorrowing = position.value.liabilityValueBorrowing

  if (liabilityValueBorrowing === 0n || collateralValueLiquidation === 0n) {
    borrowLiquidationPrice.value = undefined
    return
  }

  const multiplier = nanoToValue(collateralValueLiquidation, 18) / nanoToValue(liabilityValueBorrowing, 18)
  const borrowPriceInfo = await getAssetUsdPrice(borrowVault.value, 'off-chain')
  const currentBorrowPrice = borrowPriceInfo ? nanoToValue(borrowPriceInfo.amountOutMid, 18) : 0

  if (!currentBorrowPrice) {
    borrowLiquidationPrice.value = undefined
    return
  }

  borrowLiquidationPrice.value = currentBorrowPrice * multiplier
})
const timeToLiquidationDisplay = computed(() => {
  if (!position.value) {
    return '-'
  }

  const result = formatTtl(position.value.timeToLiquidation)
  return result?.display || '-'
})
// Net APY: sync computed so it tracks collateralValue, borrowMarketValue, and APY values
const netAPY = computed(() => {
  if (!position.value || !borrowVault.value) return 0
  return getNetAPY(
    collateralValue.value.usd,
    collateralSupplyApy.value,
    borrowMarketValue.value.usd,
    borrowApy.value,
    supplyRewardAPY.value || null,
    borrowRewardAPY.value || null,
  )
})

const roe = computed(() => {
  if (!position.value || !borrowVault.value) return 0
  return getRoe(
    collateralValue.value.usd,
    collateralSupplyApy.value,
    borrowMarketValue.value.usd,
    borrowApy.value,
    supplyRewardAPY.value || null,
    borrowRewardAPY.value || null,
  )
})

const supplyCampaignsForModal = computed(() => getSupplyRewardCampaigns(collateralVault.value?.address || ''))
const borrowCampaignsForModal = computed(() => getBorrowRewardCampaigns(borrowVault.value?.address || '', collateralVault.value?.address || ''))

const positionMultiplier = computed(() => {
  const equity = collateralValue.value.usd - borrowMarketValue.value.usd
  if (equity <= 0) return 0
  return collateralValue.value.usd / equity
})

const onNetApyInfoClick = () => {
  modal.open(VaultNetApyModal, {
    props: {
      supplyUSD: collateralValue.value.usd,
      borrowUSD: borrowMarketValue.value.usd,
      baseSupplyAPY: baseSupplyAPY.value,
      baseBorrowAPY: baseBorrowAPY.value,
      intrinsicSupplyAPY: _intrinsicSupplyAPY.value,
      intrinsicBorrowAPY: intrinsicBorrowAPY.value,
      supplyRewardAPY: supplyRewardAPY.value || null,
      borrowRewardAPY: borrowRewardAPY.value || null,
      netAPY: netAPY.value,
      supplyCampaigns: supplyCampaignsForModal.value,
      borrowCampaigns: borrowCampaignsForModal.value,
    },
  })
}

const onRoeInfoClick = () => {
  modal.open(PortfolioRoeModal, {
    props: {
      roe: roe.value,
      multiplier: Number.isFinite(positionMultiplier.value) ? positionMultiplier.value : 0,
      supplyAPY: collateralSupplyApy.value,
      borrowAPY: borrowApy.value,
      supplyRewardAPY: supplyRewardAPY.value || null,
      borrowRewardAPY: borrowRewardAPY.value || null,
      userLTV: position.value ? nanoToValue(position.value.userLTV, 18) : 0,
      supplyCampaigns: supplyCampaignsForModal.value,
      borrowCampaigns: borrowCampaignsForModal.value,
    },
  })
}

const isPrimaryCollateral = (vault: Vault | SecuritizeVault) => {
  if (!primaryCollateralAddress.value) {
    return false
  }

  return getAddress(vault.address) === primaryCollateralAddress.value
}

// Pre-computed borrow oracle price for display (always on-chain)
const borrowOraclePrice = ref(0)
const hasBorrowPrice = ref(false)

watchEffect(async () => {
  if (!borrowVault.value) {
    borrowOraclePrice.value = 0
    hasBorrowPrice.value = false
    return
  }

  // Oracle price MUST always use on-chain source
  const priceInfo = await getAssetUsdPrice(borrowVault.value, 'on-chain')
  if (priceInfo) {
    borrowOraclePrice.value = nanoToValue(priceInfo.amountOutMid, 18)
    hasBorrowPrice.value = true
  }
  else {
    borrowOraclePrice.value = 0
    hasBorrowPrice.value = false
  }
})

// Pre-computed borrow unit price (1 unit in USD) for display
const borrowUnitPrice = ref<UsdAmount>({ usd: 0, hasPrice: false })

watchEffect(async () => {
  if (!position.value?.borrow) {
    borrowUnitPrice.value = { usd: 0, hasPrice: false }
    return
  }

  const priceInfo = await getAssetUsdPrice(position.value.borrow, 'off-chain')
  borrowUnitPrice.value = priceInfo
    ? { usd: nanoToValue(priceInfo.amountOutMid, 18), hasPrice: true }
    : { usd: 0, hasPrice: false }
})

const isDisableCollateralError = (vault: Vault | SecuritizeVault) => {
  if (!disableCollateralErrorVault.value) {
    return false
  }
  try {
    return getAddress(vault.address) === disableCollateralErrorVault.value
  }
  catch {
    return false
  }
}

const loadCollaterals = async () => {
  if (!position.value) {
    collateralItems.value = []
    return
  }

  const collateralAddresses = position.value.collaterals?.length
    ? position.value.collaterals
    : [position.value.collateral.address]

  const normalized = collateralAddresses.reduce<string[]>((acc, address) => {
    try {
      acc.push(getAddress(address))
    }
    catch {
      return acc
    }
    return acc
  }, [])

  const primaryAddress = getAddress(position.value.collateral.address)
  const unique = Array.from(new Set(normalized))
  const orderedAddresses = [primaryAddress, ...unique.filter(address => address !== primaryAddress)]

  isCollateralsLoading.value = true

  try {
    if (!isEulerAddressesReady.value) {
      await loadEulerConfig()
    }

    await until(isVaultsReady).toBe(true)

    const lensAddress = eulerLensAddresses.value?.accountLens
    if (!lensAddress) {
      throw new Error('Account lens address is not available')
    }

    const client = rpcClient.value!

    const items = await Promise.all(
      orderedAddresses.map(async (address) => {
        try {
          const vault = await getOrFetch(address) as Vault | SecuritizeVault | undefined
          let assets = 0n

          try {
            const res = await client.readContract({
              address: lensAddress as Address,
              abi: eulerAccountLensABI as Abi,
              functionName: 'getAccountInfo',
              args: [position.value!.subAccount, address],
            }) as Record<string, Record<string, unknown>>
            assets = res.vaultAccountInfo.assets as bigint
          }
          catch {
            if (address === primaryAddress) {
              assets = position.value!.supplied
            }
          }

          return { vault, assets }
        }
        catch (e) {
          console.warn('[Position] failed to load collateral vault', address, e)
          return null
        }
      }),
    )

    collateralItems.value = items.filter((item): item is PositionCollateral => !!item)
  }
  catch (e) {
    console.warn('[Position] failed to load collaterals', e)
  }
  finally {
    isCollateralsLoading.value = false
  }
}

const disableCollateral = async (vault: Vault) => {
  if (isPreparing.value) return
  isPreparing.value = true
  try {
    clearDisableCollateralSimulationError()
    disableCollateralErrorVault.value = null
    let plan: TxPlan | null = null
    try {
      plan = await buildDisableCollateralPlan(
        position.value!.subAccount,
        vault.address,
        position.value!.borrow.address,
        position.value!.collaterals,
      )
    }
    catch (e) {
      console.warn('[OperationReviewModal] failed to build plan', e)
    }

    if (plan) {
      const ok = await runDisableCollateralSimulation(plan)
      if (!ok) {
        disableCollateralErrorVault.value = getAddress(vault.address)
        return
      }
    }

    modal.open(OperationReviewModal, {
      props: {
        type: 'disableCollateral',
        asset: position.value!.borrow.asset,
        amount: '0',
        plan: plan || undefined,
        subAccount: position.value?.subAccount,
        hasBorrows: (position.value?.borrowed || 0n) > 0n,
        submittingLabel: 'Submitting...',
        onConfirm: async () => {
          await send(vault.address)
        },
      },
    })
  }
  finally {
    isPreparing.value = false
  }
}
const send = async (collateralAddress: string) => {
  try {
    isSubmitting.value = true
    const txPlan = await buildDisableCollateralPlan(
      position.value!.subAccount,
      collateralAddress,
      position.value!.borrow.address,
      position.value!.collaterals,
    )
    await executeTxPlan(txPlan)

    modal.close()
    setTimeout(() => {
      router.replace('/portfolio')
    }, 400)
  }
  catch (e) {
    error('Transaction failed')
    console.warn(e)
  }
  finally {
    isSubmitting.value = false
  }
}
const load = async () => {
  // Redirect to portfolio if not connected and not in spy mode
  if (!isConnected.value && !isSpyMode.value) {
    router.replace('/portfolio')
    return
  }

  try {
    await until(isPositionsLoaded).toBe(true)
    position.value = getPositionBySubAccountIndex(+positionIndex)
    if (position.value) {
      collateralItems.value = [{
        vault: position.value.collateral as Vault,
        assets: position.value.supplied,
      }]
      // Load collaterals: always for multi-collateral, or when oracle failed (to get actual assets)
      if ((position.value.collaterals?.length && position.value.collaterals.length > 1) || position.value.liquidityQueryFailure) {
        await loadCollaterals()
      }
    }
    else {
      collateralItems.value = []
    }
  }
  catch (e) {
    showError('Unable to load Position')
    console.warn(e)
  }
}
const onBorrowInfoIconClick = (event: MouseEvent) => {
  event.preventDefault()
  event.stopPropagation()
  if (!borrowVault.value) return
  modal.open(VaultBorrowApyModal, {
    props: {
      borrowingAPY: baseBorrowAPY.value,
      intrinsicAPY: intrinsicBorrowAPY.value,
      intrinsicApyInfo: getIntrinsicApyInfo(borrowVault.value.asset.address),
      campaigns: getBorrowRewardCampaigns(borrowVault.value.address, collateralVault.value?.address),
    },
  })
}

const onSupplyInfoIconClick = (event: MouseEvent, vault: Vault | SecuritizeVault) => {
  event.preventDefault()
  event.stopPropagation()
  modal.open(VaultSupplyApyModal, {
    props: {
      lendingAPY: nanoToValue(vault.interestRateInfo.supplyAPY, 25),
      intrinsicAPY: getIntrinsicApy(vault.asset.address),
      intrinsicApyInfo: getIntrinsicApyInfo(vault.asset.address),
      campaigns: getSupplyRewardCampaigns(vault.address),
    },
  })
}

const openCollateralInfoModal = (vault: Vault | SecuritizeVault) => {
  const isSecuritize = 'type' in vault && vault.type === 'securitize'
  modal.open(VaultOverviewModal, {
    props: isSecuritize
      ? { title: 'Position information', securitizeVault: vault as SecuritizeVault }
      : { title: 'Position information', vault: vault as Vault },
  })
}
const openPairInfoModal = () => {
  const allCollateralVaults = collateralItems.value.map(item => item.vault)
  modal.open(VaultOverviewModal, {
    props: {
      title: 'Position information',
      pair: position.value,
      collateralVaults: allCollateralVaults,
    },
  })
}
watch([isConnected, isSpyMode], () => {
  load()
}, { immediate: true })
</script>

<template>
  <section class="flex flex-col gap-16 min-h-[calc(100dvh-178px)]">
    <template v-if="isPositionsLoading">
      <div class="h-[calc(100dvh-178px)] flex items-center justify-center">
        <UiLoader class="text-neutral-500" />
      </div>
    </template>
    <template v-else-if="position">
      <div class="flex items-center gap-12">
        <NuxtLink
          to="/portfolio"
          aria-label="Back to portfolio"
          class="flex items-center justify-center self-stretch px-8 rounded-8 border border-line-default bg-surface-elevated hover:bg-card-hover transition-colors text-content-secondary hover:text-content-primary flex-shrink-0"
        >
          <UiIcon
            name="arrow-left"
            class="!w-16 !h-16"
          />
        </NuxtLink>
        <div class="text-h6 text-content-secondary bg-surface-elevated py-4 px-12 rounded-8 border border-line-default">
          Position {{ positionIndex }}
        </div>
      </div>

      <VaultLabelsAndAssets
        :vault="position.collateral"
        :assets="pairAssets"
        :assets-label="pairAssetsLabel"
      />

      <UiToast
        v-if="hasQueryFailure"
        title="Oracle unavailable"
        description="Oracle pricing is currently unavailable. Some position details cannot be displayed. You can still repay debt and supply collateral."
        variant="warning"
        size="compact"
      />

      <div
        v-if="!hasNoBorrow"
        class="flex flex-col gap-16 laptop:flex-row laptop:items-stretch"
      >
        <div class="flex flex-col gap-16 p-16 rounded-12 border border-line-default bg-card shadow-card laptop:flex-1">
          <div class="text-h4 text-content-primary">
            Position summary
          </div>
          <div class="flex justify-between items-center">
            <div class="flex items-center gap-4 text-p2 text-content-secondary">
              Net APY
              <SvgIcon
                class="!w-16 !h-16 text-content-muted cursor-pointer hover:text-content-secondary"
                name="info-circle"
                @click="onNetApyInfoClick"
              />
            </div>
            <div
              class="text-h5 flex items-center gap-4"
              :class="[netAPY >= 0 ? 'text-accent-600' : 'text-error-500']"
            >
              <SvgIcon
                v-if="hasSupplyRewards(collateralVault?.address || '') || hasBorrowRewards(borrowVault?.address || '', collateralVault?.address || '')"
                class="!w-20 !h-20 text-accent-500 cursor-pointer"
                name="sparks"
                @click="onNetApyInfoClick"
              />
              {{ Number.isFinite(netAPY) ? `${formatNumber(netAPY)}%` : '-' }}
            </div>
          </div>
          <div class="flex justify-between items-center">
            <div class="flex items-center gap-4 text-p2 text-content-secondary">
              ROE
              <SvgIcon
                class="!w-16 !h-16 text-content-muted cursor-pointer hover:text-content-secondary"
                name="info-circle"
                @click="onRoeInfoClick"
              />
            </div>
            <div
              class="text-h5 flex items-center gap-4"
              :class="[roe >= 0 ? 'text-accent-600' : 'text-error-500']"
            >
              <SvgIcon
                v-if="hasSupplyRewards(collateralVault?.address || '') || hasBorrowRewards(borrowVault?.address || '', collateralVault?.address || '')"
                class="!w-20 !h-20 text-accent-500 cursor-pointer"
                name="sparks"
                @click="onRoeInfoClick"
              />
              {{ Number.isFinite(roe) ? `${formatNumber(roe)}%` : '-' }}
            </div>
          </div>
          <div class="flex justify-between items-center">
            <div class="text-p2 text-content-secondary">
              Net asset value
            </div>
            <div class="text-h5 text-content-primary">
              {{ isCollateralsLoading ? '-' : netAssetValue.hasPrice ? formatCompactUsdValue(netAssetValue.usd) : '-' }}
            </div>
          </div>
        </div>
        <div class="flex flex-col gap-16 rounded-12 bg-card border border-line-default shadow-card p-16 laptop:flex-1">
          <div class="text-h4 text-content-primary">
            Position risk
          </div>
          <div class="flex justify-between gap-8 flex-wrap">
            <div class="text-content-secondary text-p3">
              Health score
            </div>
            <div class="text-content-primary text-p3">
              <span
                v-if="hasQueryFailure"
                class="text-warning-500"
              >Unknown</span>
              <template v-else>
                {{ formatHealthScore(nanoToValue(position.health, 18)) }}
              </template>
            </div>
          </div>
          <div class="flex justify-between gap-8 flex-wrap">
            <div class="text-content-secondary text-p3">
              Time to liquidation
            </div>
            <div class="text-content-primary text-p3">
              <span
                v-if="hasQueryFailure"
                class="text-warning-500"
              >Unknown</span>
              <template v-else>
                {{ timeToLiquidationDisplay }}
              </template>
            </div>
          </div>
          <div class="flex justify-between gap-8 flex-wrap">
            <div class="text-content-secondary text-p3">
              Liquidation LTV
            </div>
            <div class="text-content-primary text-p3">
              <span
                v-if="hasQueryFailure"
                class="text-warning-500"
              >Unknown</span>
              <template v-else>
                {{ formatNumber(nanoToValue(position.userLTV, 18), 2) }}/{{ nanoToValue(position.liquidationLTV, 2) }}%
              </template>
            </div>
          </div>
          <UiProgress
            v-if="!hasQueryFailure"
            :model-value="nanoToValue(position.userLTV, 18)"
            :max="nanoToValue(position.liquidationLTV, 2)"
            :color="nanoToValue(position.userLTV, 18) >= (nanoToValue(position.liquidationLTV, 2) - 2) ? 'danger' : undefined"
            size="small"
          />
        </div>
      </div>
      <div
        v-if="!hasNoBorrow"
        class="cursor-pointer"
        @click="openPairInfoModal"
      >
        <div class="mb-12 text-h4 text-neutral-800">
          Borrow
        </div>
        <div class="rounded-12 bg-card border border-line-default shadow-card">
          <div class="flex justify-between items-center p-16 pb-12 border-b border-line-default">
            <VaultLabelsAndAssets
              :vault="position.borrow"
              :assets="[position.borrow.asset]"
            />
            <div class="flex flex-col items-end">
              <div class="text-content-tertiary text-p3 mb-4 flex items-center gap-4">
                Borrow APY
                <SvgIcon
                  class="!w-16 !h-16 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
                  name="info-circle"
                  @click.stop="onBorrowInfoIconClick"
                />
              </div>
              <div class="text-p2 flex items-center text-accent-600 font-semibold">
                <SvgIcon
                  v-if="hasBorrowRewards(borrowVault?.address || '', collateralVault?.address || '')"
                  class="!w-20 !h-20 text-accent-500 mr-4 cursor-pointer"
                  name="sparks"
                  @click.stop="onBorrowInfoIconClick"
                />
                {{ formatNumber(borrowApyWithRewards) }}%
              </div>
            </div>
          </div>
          <div class="pt-12 px-16 pb-16">
            <PortfolioNotice
              v-if="borrowVaultNotice"
              :notice="borrowVaultNotice"
              class="mb-16"
            />
            <div class="flex justify-between gap-8 flex-wrap mb-16">
              <div class="text-content-secondary text-p3">
                Market value
              </div>
              <div class="flex justify-between gap-8 justify-self-end">
                <div class="text-neutral-800 text-p3">
                  {{ borrowMarketValue.hasPrice
                    ? formatCompactUsdValue(borrowMarketValue.usd)
                    : `${roundAndCompactTokens(position.borrowed, borrowVault?.decimals ?? 0n)} ${borrowVault?.asset?.symbol}`
                  }}
                </div>
                <div
                  v-if="borrowMarketValue.hasPrice"
                  class="text-neutral-500 text-p3"
                >
                  ~ {{ roundAndCompactTokens(position.borrowed, borrowVault?.decimals ?? 0n) }} {{ borrowVault?.asset?.symbol }}
                </div>
              </div>
            </div>
            <div class="flex justify-between gap-8 flex-wrap mb-12">
              <div class="text-neutral-500 text-p3">
                Current price
              </div>
              <div class="text-neutral-800 text-p3">
                {{ borrowUnitPrice.hasPrice ? formatUsdValue(borrowUnitPrice.usd) : '-' }}
              </div>
            </div>
            <div class="flex justify-between gap-8 flex-wrap mb-12">
              <div class="text-neutral-500 text-p3">
                Oracle price
              </div>
              <div class="text-neutral-800 text-p3">
                {{
                  borrowOraclePrice
                    ? formatUsdValue(borrowOraclePrice)
                    : '-'
                }}
              </div>
            </div>
            <div class="flex justify-between gap-8 flex-wrap mb-12">
              <div class="text-neutral-500 text-p3">
                Liq. price
              </div>
              <div class="text-neutral-800 text-p3">
                {{ borrowLiquidationPrice ? `$${formatNumber(borrowLiquidationPrice)}` : '-' }}
              </div>
            </div>
            <VaultWarningBanner :warnings="positionWarnings" />
            <UiToast
              v-if="isEligibleForLiquidation"
              class="my-12"
              title="Liquidation risk"
              description="This position is eligible for liquidation. Multiply and borrow are disabled."
              variant="error"
              size="compact"
            />
            <UiToast
              v-if="isOverBorrowLTV && !isEligibleForLiquidation"
              class="my-12"
              title="LTV limit reached"
              description="Your current LTV exceeds the borrow limit. Repay debt or supply more collateral to borrow again."
              variant="warning"
              size="compact"
            />
            <UiToast
              v-if="isPositionGeoBlocked || isPairFullyRestricted"
              class="my-12"
              title="Region restricted"
              description="This pair is not available in your region. You can still repay existing debt."
              variant="warning"
              size="compact"
            />
            <UiToast
              v-if="!isPositionGeoBlocked && !isPairFullyRestricted && (isBorrowRestricted || isMultiplyRestricted)"
              class="my-12"
              title="Asset restricted"
              description="Some operations on this pair are restricted in your region. Supply, withdraw, and repay remain available."
              variant="warning"
              size="compact"
            />
            <div
              class="flex justify-between gap-8 mt-4"
              @click.stop
            >
              <UiButton
                size="medium"
                variant="primary"
                rounded
                :disabled="isEligibleForLiquidation || isOverBorrowLTV || isPositionGeoBlocked || isMultiplyRestricted || hasQueryFailure"
                :to="isEligibleForLiquidation || isOverBorrowLTV || isPositionGeoBlocked || isMultiplyRestricted || hasQueryFailure ? undefined : `/position/${positionIndex}/multiply`"
              >
                Multiply
              </UiButton>
              <UiButton
                size="medium"
                variant="primary-stroke"
                rounded
                :disabled="isEligibleForLiquidation || isOverBorrowLTV || isPositionGeoBlocked || isBorrowRestricted || hasQueryFailure"
                :to="isEligibleForLiquidation || isOverBorrowLTV || isPositionGeoBlocked || isBorrowRestricted || hasQueryFailure ? undefined : `/position/${positionIndex}/borrow`"
              >
                Borrow
              </UiButton>
              <UiButton
                size="medium"
                variant="primary-stroke"
                rounded
                :to="`/position/${positionIndex}/repay`"
              >
                Repay
              </UiButton>
              <UiButton
                size="medium"
                variant="primary-stroke"
                rounded
                :disabled="isPositionGeoBlocked || isPairFullyRestricted || hasQueryFailure"
                :to="isPositionGeoBlocked || isPairFullyRestricted || hasQueryFailure ? undefined : `/position/${positionIndex}/borrow/swap`"
              >
                Refinance debt
              </UiButton>
            </div>
          </div>
        </div>
      </div>
      <div>
        <div class="mb-12 text-h4 text-neutral-800">
          {{ !hasNoBorrow ? 'Collateral' : 'Supply' }}
        </div>
        <div class="flex flex-col gap-12">
          <div
            v-for="collateral in collateralRows"
            :key="collateral.vault.address"
            class="rounded-12 bg-card border border-line-default shadow-card cursor-pointer"
            @click="openCollateralInfoModal(collateral.vault)"
          >
            <div class="flex justify-between items-center p-16 pb-12 border-b border-line-default">
              <VaultLabelsAndAssets
                :vault="collateral.vault"
                :assets="[collateral.vault.asset]"
              />
              <div class="flex flex-col items-end">
                <div class="text-content-tertiary text-p3 mb-4 flex items-center gap-4">
                  Supply APY
                  <SvgIcon
                    class="!w-16 !h-16 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
                    name="info-circle"
                    @click.stop="(e: MouseEvent) => onSupplyInfoIconClick(e, collateral.vault)"
                  />
                </div>
                <div class="text-p2 flex items-center text-accent-600 font-semibold">
                  <SvgIcon
                    v-if="hasSupplyRewards(collateral.vault.address)"
                    class="!w-20 !h-20 text-accent-500 mr-4 cursor-pointer"
                    name="sparks"
                    @click.stop="(e: MouseEvent) => onSupplyInfoIconClick(e, collateral.vault)"
                  />
                  {{ formatNumber(collateral.supplyApyWithRewards) }}%
                </div>
              </div>
            </div>
            <div class="pt-12 px-16 pb-16">
              <PortfolioNotice
                v-if="getCollateralNotice(collateral.vault.address)"
                :notice="getCollateralNotice(collateral.vault.address)"
                class="mb-16"
              />
              <div class="flex justify-between gap-8 flex-wrap mb-16">
                <div class="text-content-secondary text-p3">
                  {{ !hasNoBorrow ? 'Market value' : 'Supply value' }}
                </div>
                <div class="flex justify-between gap-8 justify-self-end">
                  <div class="text-content-primary text-p3">
                    {{ collateral.value.hasPrice
                      ? formatCompactUsdValue(collateral.value.usd)
                      : `${roundAndCompactTokens(collateral.assets, collateral.vault.decimals)} ${collateral.vault.asset.symbol}`
                    }}
                  </div>
                  <div
                    v-if="collateral.value.hasPrice"
                    class="text-content-tertiary text-p3"
                  >
                    ~ {{ roundAndCompactTokens(collateral.assets, collateral.vault.decimals) }}
                    {{ collateral.vault.asset.symbol }}
                  </div>
                </div>
              </div>
              <div class="flex justify-between gap-8 flex-wrap mb-16">
                <div class="text-neutral-500 text-p3">
                  Current price
                </div>
                <div class="text-neutral-800 text-p3">
                  {{ collateral.unitPriceUsd > 0 ? formatUsdValue(collateral.unitPriceUsd) : '-' }}
                </div>
              </div>
              <div class="flex justify-between gap-8 flex-wrap mb-16">
                <div class="text-neutral-500 text-p3">
                  Oracle price
                </div>
                <div class="text-neutral-800 text-p3">
                  {{ collateral.oraclePriceUsd > 0
                    ? formatUsdValue(collateral.oraclePriceUsd)
                    : '-' }}
                </div>
              </div>
              <div
                v-if="!hasNoBorrow && isPrimaryCollateral(collateral.vault)"
                class="flex justify-between gap-8 flex-wrap mb-16"
              >
                <div class="text-neutral-500 text-p3">
                  Liq. price
                </div>
                <div class="text-neutral-800 text-p3">
                  {{ liquidationPrice ? `$${formatNumber(liquidationPrice)}` : '-' }}
                </div>
              </div>
              <div
                v-if="!hasNoBorrow && isPrimaryCollateral(collateral.vault)"
                class="flex justify-between gap-8 flex-wrap mb-16"
              >
                <div class="text-neutral-500 text-p3">
                  Liquidation LTV
                </div>
                <div class="text-neutral-800 text-p3">
                  {{ formatNumber(nanoToValue(position.liquidationLTV, 2)) }}%
                </div>
              </div>
              <UiToast
                v-if="!hasNoBorrow && isEligibleForLiquidation"
                class="my-12"
                title="Liquidation risk"
                description="Withdraw is disabled while this position is eligible for liquidation."
                variant="error"
                size="compact"
              />
              <div
                v-if="!hasNoBorrow"
                class="flex gap-8 mt-4"
                @click.stop
              >
                <UiButton
                  size="medium"
                  variant="primary"
                  rounded
                  :disabled="isPositionGeoBlocked || isPairFullyRestricted"
                  :to="isPositionGeoBlocked || isPairFullyRestricted ? undefined : `/position/${positionIndex}/supply?collateral=${collateral.vault.address}`"
                >
                  Supply
                </UiButton>
                <UiButton
                  size="medium"
                  variant="primary-stroke"
                  rounded
                  :disabled="isEligibleForLiquidation || isPositionGeoBlocked || isPairFullyRestricted || hasQueryFailure"
                  :to="isEligibleForLiquidation || isPositionGeoBlocked || isPairFullyRestricted || hasQueryFailure ? undefined : `/position/${positionIndex}/withdraw?collateral=${collateral.vault.address}`"
                >
                  Withdraw
                </UiButton>
                <UiButton
                  size="medium"
                  variant="primary-stroke"
                  rounded
                  :disabled="isPositionGeoBlocked || isPairFullyRestricted || hasQueryFailure"
                  :to="isPositionGeoBlocked || isPairFullyRestricted || hasQueryFailure ? undefined : `/position/${positionIndex}/collateral/swap?collateral=${collateral.vault.address}`"
                >
                  Swap collateral
                </UiButton>
              </div>
              <div
                v-else
                @click.stop
              >
                <UiButton
                  size="medium"
                  variant="primary"
                  rounded
                  :loading="isSubmitting || isPreparing"
                  @click="disableCollateral(collateral.vault as Vault)"
                >
                  Disable collateral
                </UiButton>
                <UiToast
                  v-if="disableCollateralSimulationError && isDisableCollateralError(collateral.vault)"
                  class="mt-12"
                  title="Error"
                  variant="error"
                  :description="disableCollateralSimulationError"
                  size="compact"
                />
              </div>
            </div>
          </div>
          <div
            v-if="!collateralRows.length && isCollateralsLoading"
            class="flex items-center justify-center rounded-12 bg-card border border-line-default p-16"
          >
            <UiLoader class="text-neutral-500" />
          </div>
        </div>
      </div>

      <div class="mt-auto flex flex-col gap-8">
        <UiButton
          size="large"
          variant="primary-stroke"
          @click="openPairInfoModal"
        >
          Position information
        </UiButton>
      </div>
    </template>
    <template v-else>
      Position not found
    </template>
  </section>
</template>
