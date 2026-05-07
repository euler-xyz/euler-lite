import type { SecuritizeCollateralVault, EVault, PortfolioBorrowPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { getAssetUsdValue } from '~/utils/sdk-prices'
import { SwapperMode } from '~/entities/swap'
import { useSwapRepayQuotes } from '~/composables/repay/useSwapRepayQuotes'
import { valueToNano } from '~/utils/crypto-utils'
import { trimTrailingZeros } from '~/utils/string-utils'
import { normalizeAddressOrEmpty } from '~/utils/accountPositionHelpers'
import { amountToPercent, percentToAmountNano } from '~/utils/repayUtils'
import { createRaceGuard } from '~/utils/race-guard'
import { type Address, formatUnits } from 'viem'
import type { Ref, ComputedRef } from 'vue'

interface QuoteAccounts {
  accountIn: Address
  accountOut: Address
}

export interface UseRepaySwapCoreOptions {
  position: Ref<PortfolioBorrowPosition<VaultEntity> | undefined>
  borrowVault: ComputedRef<EVault | undefined>
  sourceVault: Ref<EVault | undefined>
  sourceBalance: ComputedRef<bigint>
  formTab: Ref<string>
  formTabName: string
  slippage: Readonly<Ref<number>>
  clearSimulationError: () => void
  getCurrentDebt: () => bigint
  getQuoteAccounts: () => QuoteAccounts
  onQuoteReceived?: (amountOut: bigint, direction: SwapperMode) => boolean
}

export const useRepaySwapCore = (options: UseRepaySwapCoreOptions) => {
  const {
    position,
    borrowVault,
    sourceVault,
    sourceBalance,
    formTab,
    formTabName,
    slippage,
    clearSimulationError,
    getCurrentDebt,
    getQuoteAccounts,
    onQuoteReceived,
  } = options

  // --- State ---
  const amount = ref('')
  const debtAmount = ref('')
  const direction = ref(SwapperMode.EXACT_IN)
  const debtPercent = ref(0)

  // --- Quotes ---
  const quotes = useSwapRepayQuotes({ direction })

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

  watch([sourceVault, slippage], () => {
    clearSimulationError()
    if (amount.value || debtAmount.value) {
      requestQuote()
    }
  })

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
    requestQuote,
    resetCore,
  }
}
