import type { SecuritizeCollateralVault, EVault, PluginPrefetchData, PortfolioBorrowPosition, SwapQuote, TransactionPlan, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { getAssetUsdValue } from '~/utils/sdk-prices'
import { SwapperMode } from '@eulerxyz/euler-v2-sdk'
import { COWSWAP_ORDER_DEADLINE_SECONDS, COWSWAP_PROVIDER_EXTRA_DATA, buildClosePositionQuoteAppData, getCowSwapChainConfig } from '~/entities/cowswap'
import { useSwapRepayQuotes } from '~/composables/repay/useSwapRepayQuotes'
import type { SwapQuotePlanAccount } from '~/composables/useSwapQuotesParallel'
import { valueToNano } from '~/utils/crypto-utils'
import { trimTrailingZeros } from '~/utils/string-utils'
import { normalizeAddressOrEmpty } from '~/utils/accountPositionHelpers'
import { amountToPercent, percentToAmountNano } from '~/utils/repayUtils'
import { createRaceGuard } from '~/utils/race-guard'
import { type Address, formatUnits, zeroAddress } from 'viem'
import type { Ref, ComputedRef } from 'vue'

interface QuoteAccounts {
  accountIn: Address
  accountOut: Address
}

export interface UseRepaySwapCoreOptions {
  position: Ref<PortfolioBorrowPosition<VaultEntity> | undefined>
  borrowVault: ComputedRef<EVault | undefined>
  sourceVault: Ref<EVault | undefined>
  sourceAssets?: Readonly<Ref<bigint>>
  sourceShares?: Readonly<Ref<bigint>>
  sourceBalance: ComputedRef<bigint>
  formTab: Ref<string>
  formTabName: string
  slippage: Readonly<Ref<number>>
  clearSimulationError: () => void
  getCurrentDebt: () => bigint
  getQuoteAccounts: () => QuoteAccounts
  onQuoteReceived?: (amountOut: bigint, direction: SwapperMode) => boolean
  includeCowSwap?: boolean
  buildTxPlanForQuote?: (quote: SwapQuote, provider: string) => Promise<TransactionPlan>
  prefetchPluginData?: (plan: TransactionPlan, account: SwapQuotePlanAccount) => Promise<PluginPrefetchData>
}

export const useRepaySwapCore = (options: UseRepaySwapCoreOptions) => {
  const {
    position,
    borrowVault,
    sourceVault,
    sourceAssets,
    sourceShares,
    sourceBalance,
    formTab,
    formTabName,
    slippage,
    clearSimulationError,
    getCurrentDebt,
    getQuoteAccounts,
    onQuoteReceived,
  } = options
  const { address } = useWagmi()
  const { chainId } = useEulerAddresses()

  // --- State ---
  const amount = ref('')
  const debtAmount = ref('')
  const direction = ref(SwapperMode.EXACT_IN)
  const debtPercent = ref(0)

  // --- Quotes ---
  const quotes = useSwapRepayQuotes({
    direction,
    includeCowSwap: options.includeCowSwap,
    buildTxPlanForQuote: options.buildTxPlanForQuote,
    prefetchPluginData: options.prefetchPluginData,
  })

  // --- Derived ---
  const isSameAsset = computed(() => {
    if (!sourceVault.value || !borrowVault.value) return false
    return normalizeAddressOrEmpty(sourceVault.value.asset.address) === normalizeAddressOrEmpty(borrowVault.value.asset.address)
  })

  const spent = computed(() => {
    if (isSameAsset.value && sourceVault.value) {
      if (amount.value) {
        try {
          return valueToNano(amount.value, sourceVault.value.asset.decimals)
        }
        catch { return null }
      }
      if (debtAmount.value && borrowVault.value) {
        try {
          return valueToNano(debtAmount.value, borrowVault.value.asset.decimals)
        }
        catch { return null }
      }
      return null
    }
    if (!quotes.quote.value) return null
    try {
      return BigInt(quotes.quote.value.amountIn || 0)
    }
    catch { return null }
  })

  const debtRepaid = computed(() => {
    if (isSameAsset.value && borrowVault.value) {
      if (debtAmount.value) {
        try {
          return valueToNano(debtAmount.value, borrowVault.value.asset.decimals)
        }
        catch { return null }
      }
      if (amount.value && sourceVault.value) {
        try {
          return valueToNano(amount.value, sourceVault.value.asset.decimals)
        }
        catch { return null }
      }
      return null
    }
    if (!quotes.quote.value) return null
    try {
      return BigInt(quotes.quote.value.amountOut || 0)
    }
    catch { return null }
  })

  const isRepayExceedsDebt = computed(() => {
    if (isSameAsset.value) return false
    if (!position.value || position.value.borrowed <= 0n) return false
    if (direction.value === SwapperMode.EXACT_IN) {
      if (debtRepaid.value === null) return false
      return debtRepaid.value > position.value.borrowed
    }
    if (direction.value === SwapperMode.TARGET_DEBT && debtAmount.value && borrowVault.value) {
      try {
        const inputNano = valueToNano(debtAmount.value, borrowVault.value.asset.decimals)
        return inputNano > position.value.borrowed
      }
      catch { return false }
    }
    return false
  })

  // --- Async USD values ---
  const sourceUsdGuard = createRaceGuard()
  const sourceValueUsd = ref<number | null>(null)

  watchEffect(async () => {
    if (!sourceVault.value) {
      sourceValueUsd.value = null
      return
    }
    const gen = sourceUsdGuard.next()
    const result = (await getAssetUsdValue(sourceBalance.value, sourceVault.value, 'off-chain')) ?? null
    if (sourceUsdGuard.isStale(gen)) return
    sourceValueUsd.value = result
  })

  const borrowUsdGuard = createRaceGuard()
  const borrowValueUsd = ref<number | null>(null)

  watchEffect(async () => {
    if (!borrowVault.value || !position.value) {
      borrowValueUsd.value = null
      return
    }
    const gen = borrowUsdGuard.next()
    const result = (await getAssetUsdValue(position.value.borrowed, borrowVault.value, 'off-chain')) ?? null
    if (borrowUsdGuard.isStale(gen)) return
    borrowValueUsd.value = result
  })

  const nextBorrowUsdGuard = createRaceGuard()
  const nextBorrowValueUsd = ref<number | null>(null)

  watchEffect(async () => {
    if (!borrowVault.value || !position.value || debtRepaid.value === null) {
      nextBorrowValueUsd.value = null
      return
    }
    const gen = nextBorrowUsdGuard.next()
    const nextBorrow = position.value.borrowed - debtRepaid.value
    const result = (await getAssetUsdValue(nextBorrow > 0n ? nextBorrow : 0n, borrowVault.value, 'off-chain')) ?? null
    if (nextBorrowUsdGuard.isStale(gen)) return
    nextBorrowValueUsd.value = result
  })

  // --- Input handlers ---
  const onAmountInput = () => {
    clearSimulationError()
    debtAmount.value = ''
    direction.value = SwapperMode.EXACT_IN
    requestQuote()
  }

  const onDebtInput = () => {
    clearSimulationError()
    amount.value = ''
    direction.value = SwapperMode.TARGET_DEBT
    const currentDebt = getCurrentDebt()
    let amountNano = 0n
    try {
      amountNano = valueToNano(debtAmount.value || '0', borrowVault.value?.asset.decimals)
    }
    catch {
      amountNano = 0n
    }
    debtPercent.value = amountToPercent(amountNano, currentDebt)
    requestQuote()
  }

  const onPercentInput = () => {
    clearSimulationError()
    amount.value = ''
    direction.value = SwapperMode.TARGET_DEBT
    const currentDebt = getCurrentDebt()
    if (!borrowVault.value || currentDebt <= 0n) {
      debtAmount.value = ''
      debtPercent.value = 0
      quotes.reset()
      return
    }
    const amountNano = percentToAmountNano(debtPercent.value, currentDebt)
    debtAmount.value = trimTrailingZeros(formatUnits(amountNano, Number(borrowVault.value.asset.decimals)))
    requestQuote()
  }

  const onSourceVaultChange = (selectedIndex: number, vaultList: Ref<(EVault | SecuritizeCollateralVault)[]>) => {
    clearSimulationError()
    const nextVault = vaultList.value[selectedIndex]
    if (!nextVault) return
    if (!sourceVault.value || normalizeAddressOrEmpty(sourceVault.value.address) !== normalizeAddressOrEmpty(nextVault.address)) {
      sourceVault.value = nextVault as EVault
      amount.value = ''
      debtAmount.value = ''
      quotes.reset()
    }
  }

  const onRefreshQuotes = () => {
    quotes.reset()
    const activeQuotes = direction.value === SwapperMode.EXACT_IN
      ? quotes.exactInQuotes
      : quotes.targetDebtQuotes
    activeQuotes.isLoading.value = true
    requestQuote()
  }

  // Max on source input: if source is worth at least as much as the debt,
  // behave like Max on debt (TARGET_DEBT with full debt). Otherwise default
  // to EXACT_IN with full source balance. Prevents accidental over-repay.
  const onSourceMax = () => {
    clearSimulationError()
    if (!sourceVault.value || !borrowVault.value) return
    const currentDebt = getCurrentDebt()
    if (currentDebt <= 0n) return

    const sourceDecimals = Number(sourceVault.value.asset.decimals)
    const borrowDecimals = Number(borrowVault.value.asset.decimals)

    if (isSameAsset.value) {
      if (sourceBalance.value >= currentDebt) {
        direction.value = SwapperMode.TARGET_DEBT
        debtAmount.value = trimTrailingZeros(formatUnits(currentDebt, borrowDecimals))
        amount.value = ''
        debtPercent.value = 100
        requestQuote()
        return
      }
      direction.value = SwapperMode.EXACT_IN
      amount.value = trimTrailingZeros(formatUnits(sourceBalance.value, sourceDecimals))
      debtAmount.value = ''
      requestQuote()
      return
    }

    const srcUsd = sourceValueUsd.value
    const debtUsd = borrowValueUsd.value
    if (srcUsd !== null && debtUsd !== null && srcUsd > debtUsd) {
      direction.value = SwapperMode.TARGET_DEBT
      debtAmount.value = trimTrailingZeros(formatUnits(currentDebt, borrowDecimals))
      amount.value = ''
      debtPercent.value = 100
      requestQuote()
      return
    }
    direction.value = SwapperMode.EXACT_IN
    amount.value = trimTrailingZeros(formatUnits(sourceBalance.value, sourceDecimals))
    debtAmount.value = ''
    requestQuote()
  }

  const onProviderSelect = (provider: string) => {
    clearSimulationError()
    quotes.selectProvider(provider)
  }

  // Compute the source-vault shares amount we expect to spend for the CoW
  // close-position appData. Falls back to a preview-withdraw if our cached
  // sourceShares value is missing.
  const getClosePositionQuoteCollateralAmount = async (): Promise<bigint> => {
    if (!sourceVault.value || sourceBalance.value <= 0n) return 0n

    const sharesValue = sourceShares?.value ?? 0n
    const assetsValue = sourceAssets?.value ?? 0n

    if (sourceBalance.value < assetsValue) {
      // Cash-limited withdraw — need to convert the balance to shares.
      const previewWithdraw = (sourceVault.value as EVault).previewWithdraw?.bind(sourceVault.value)
      const withdrawShares = previewWithdraw ? previewWithdraw(sourceBalance.value) : sourceBalance.value
      return sharesValue > 0n && withdrawShares > sharesValue
        ? sharesValue
        : withdrawShares
    }

    if (sharesValue > 0n) return sharesValue
    const previewWithdraw = (sourceVault.value as EVault).previewWithdraw?.bind(sourceVault.value)
    return previewWithdraw ? previewWithdraw(sourceBalance.value) : sourceBalance.value
  }

  // --- Quote request ---
  const requestQuote = useDebounceFn(async () => {
    if (!position.value || !sourceVault.value || !borrowVault.value) {
      quotes.reset()
      return
    }

    if (isSameAsset.value) {
      const currentDebt = position.value.borrowed || 0n
      if (direction.value === SwapperMode.EXACT_IN && amount.value) {
        try {
          const sourceNano = valueToNano(amount.value, sourceVault.value.asset.decimals)
          if (sourceNano > currentDebt && currentDebt > 0n) {
            amount.value = trimTrailingZeros(formatUnits(currentDebt, Number(borrowVault.value.asset.decimals)))
          }
        }
        catch { /* ignore parse errors */ }
        debtAmount.value = amount.value
      }
      if (direction.value === SwapperMode.TARGET_DEBT && debtAmount.value) {
        amount.value = debtAmount.value
      }
      quotes.reset()
      return
    }

    const currentDebt = position.value.borrowed || 0n
    const { accountIn, accountOut } = getQuoteAccounts()

    if (direction.value === SwapperMode.EXACT_IN) {
      if (!amount.value) {
        quotes.reset()
        return
      }
      let parsedAmount: bigint
      try {
        parsedAmount = valueToNano(amount.value, sourceVault.value.asset.decimals)
      }
      catch {
        quotes.reset()
        return
      }
      if (!parsedAmount || parsedAmount <= 0n) {
        quotes.reset()
        return
      }
      await quotes.exactInQuotes.requestQuotes({
        tokenIn: sourceVault.value.asset.address as Address,
        tokenOut: borrowVault.value.asset.address as Address,
        accountIn,
        accountOut,
        amount: parsedAmount,
        vaultIn: sourceVault.value.address as Address,
        receiver: borrowVault.value.address as Address,
        slippage: slippage.value,
        swapperMode: SwapperMode.EXACT_IN,
        isRepay: true,
        targetDebt: 0n,
        currentDebt,
      })
      return
    }

    if (!debtAmount.value) {
      quotes.reset()
      return
    }
    let parsedAmount: bigint
    try {
      parsedAmount = valueToNano(debtAmount.value, borrowVault.value.asset.decimals)
    }
    catch {
      quotes.reset()
      return
    }
    if (!parsedAmount || parsedAmount <= 0n) {
      quotes.reset()
      return
    }
    const targetDebt = parsedAmount >= currentDebt ? 0n : currentDebt - parsedAmount
    // For the CoW close-position path the quote API needs the wrapper-encoded
    // appData hash so the CoW order can be tied to the EVC permit at execution
    // time. Stamp it here only when the chain has CoW deployed; the parallel
    // quote engine forwards it as `providerExtraData` for CoW providers.
    const quoteDeadline = Math.floor(Date.now() / 1000) + COWSWAP_ORDER_DEADLINE_SECONDS
    const cowProviderExtraData = { ...COWSWAP_PROVIDER_EXTRA_DATA.closePosition }
    const chainConfig = options.includeCowSwap ? getCowSwapChainConfig(chainId.value ?? 0) : undefined
    if (chainConfig) {
      const sourceSharesAmount = await getClosePositionQuoteCollateralAmount()
      cowProviderExtraData.appData = buildClosePositionQuoteAppData(
        {
          owner: (address.value || zeroAddress) as Address,
          account: accountIn,
          deadline: quoteDeadline,
          borrowVault: borrowVault.value.address as Address,
          collateralVault: sourceVault.value.address as Address,
          collateralAmount: sourceSharesAmount,
        },
        chainConfig.closePositionWrapper,
        Math.round(slippage.value * 100),
      )
    }
    await quotes.targetDebtQuotes.requestQuotes({
      tokenIn: sourceVault.value.asset.address as Address,
      tokenOut: borrowVault.value.asset.address as Address,
      accountIn,
      accountOut,
      amount: parsedAmount,
      vaultIn: sourceVault.value.address as Address,
      receiver: borrowVault.value.address as Address,
      slippage: slippage.value,
      swapperMode: SwapperMode.TARGET_DEBT,
      isRepay: true,
      targetDebt,
      currentDebt,
      providerExtraData: cowProviderExtraData,
    })
  }, 500)

  // --- Watchers ---
  watch([quotes.effectiveQuote, direction], () => {
    if (!quotes.effectiveQuote.value || !sourceVault.value || !borrowVault.value) return

    if (onQuoteReceived) {
      const amountOut = BigInt(quotes.effectiveQuote.value.amountOut || 0)
      const intercepted = onQuoteReceived(amountOut, direction.value)
      if (intercepted) return
    }

    if (direction.value === SwapperMode.EXACT_IN) {
      debtAmount.value = trimTrailingZeros(formatUnits(
        BigInt(quotes.effectiveQuote.value.amountOut || 0),
        Number(borrowVault.value.asset.decimals),
      ))
    }
    else {
      amount.value = trimTrailingZeros(formatUnits(
        BigInt(quotes.effectiveQuote.value.amountIn || 0),
        Number(sourceVault.value.asset.decimals),
      ))
    }
  })

  watch(
    [sourceVault, sourceBalance, () => sourceShares?.value, slippage],
    () => {
      clearSimulationError()
      if (amount.value || debtAmount.value) {
        requestQuote()
      }
    },
  )

  watch(debtAmount, () => {
    if (formTab.value !== formTabName) return
    const currentDebt = getCurrentDebt()
    if (!borrowVault.value || currentDebt <= 0n) {
      debtPercent.value = 0
      return
    }
    let amountNano = 0n
    try {
      amountNano = valueToNano(debtAmount.value || '0', borrowVault.value.asset.decimals)
    }
    catch {
      amountNano = 0n
    }
    debtPercent.value = amountToPercent(amountNano, currentDebt)
  })

  // --- Reset ---
  const resetCore = () => {
    amount.value = ''
    debtAmount.value = ''
    debtPercent.value = 0
    quotes.reset()
  }

  return {
    amount,
    debtAmount,
    direction,
    debtPercent,
    quotes,
    isSameAsset,
    spent,
    debtRepaid,
    isRepayExceedsDebt,
    sourceValueUsd,
    borrowValueUsd,
    nextBorrowValueUsd,
    onAmountInput,
    onDebtInput,
    onPercentInput,
    onSourceVaultChange,
    onRefreshQuotes,
    onSourceMax,
    onProviderSelect,
    requestQuote,
    resetCore,
  }
}
