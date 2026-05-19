import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { formatUnits } from 'viem'
import type { Ref, ComputedRef } from 'vue'

import { getAssetUsdValue } from '~/utils/sdk-prices'
import { SwapperMode } from '@eulerxyz/euler-v2-sdk'
import { buildSwapRouteItems } from '~/utils/swapRouteItems'
import { createRaceGuard } from '~/utils/race-guard'
import type { useSwapRepayQuotes } from '~/composables/repay/useSwapRepayQuotes'

interface UseRepaySwapDetailsOptions {
  quotes: ReturnType<typeof useSwapRepayQuotes>
  sourceVault: Ref<EVault | undefined>
  borrowVault: ComputedRef<EVault | undefined>
  direction: Ref<SwapperMode>
}

export const useRepaySwapDetails = (options: UseRepaySwapDetailsOptions) => {
  const { quotes, sourceVault, borrowVault, direction } = options

  const currentPrice = computed(() => {
    if (!quotes.quote.value || !sourceVault.value || !borrowVault.value) return null
    const amountOut = Number(formatUnits(BigInt(quotes.quote.value.amountOut), Number(borrowVault.value.asset.decimals)))
    const amountIn = Number(formatUnits(BigInt(quotes.quote.value.amountIn), Number(sourceVault.value.asset.decimals)))
    if (!amountOut || !amountIn) return null
    return {
      value: amountOut / amountIn,
      symbol: `${borrowVault.value.asset.symbol}/${sourceVault.value.asset.symbol}`,
    }
  })

  const summary = computed(() => {
    if (!quotes.quote.value || !sourceVault.value || !borrowVault.value) return null
    const amountIn = formatUnits(BigInt(quotes.quote.value.amountIn), Number(sourceVault.value.asset.decimals))
    const amountOut = formatUnits(BigInt(quotes.quote.value.amountOut), Number(borrowVault.value.asset.decimals))
    return {
      from: `${formatSmartAmount(amountIn)} ${sourceVault.value.asset.symbol}`,
      to: `${formatSmartAmount(amountOut)} ${borrowVault.value.asset.symbol}`,
      fromExact: `${amountIn} ${sourceVault.value.asset.symbol}`,
      toExact: `${amountOut} ${borrowVault.value.asset.symbol}`,
    }
  })

  const priceImpactGuard = createRaceGuard()
  const priceImpact = ref<number | null>(null)

  watchEffect(async () => {
    if (!quotes.quote.value || !sourceVault.value || !borrowVault.value) {
      priceImpact.value = null
      return
    }
    const gen = priceImpactGuard.next()
    const [amountInUsd, amountOutUsd] = await Promise.all([
      getAssetUsdValue(BigInt(quotes.quote.value.amountIn), sourceVault.value, 'off-chain'),
      getAssetUsdValue(BigInt(quotes.quote.value.amountOut), borrowVault.value, 'off-chain'),
    ])
    if (priceImpactGuard.isStale(gen)) return
    if (!amountInUsd || !amountOutUsd) {
      priceImpact.value = null
      return
    }
    const impact = (amountOutUsd / amountInUsd - 1) * 100
    priceImpact.value = Number.isFinite(impact) ? impact : null
  })

  const leveragedPriceImpact = computed(() => priceImpact.value)

  const routedVia = computed(() => {
    if (!quotes.selectedProvider.value) return 'Not selected'
    if (!quotes.quote.value?.route?.length) return null
    return quotes.quote.value.route.map(route => route.providerName).join(', ')
  })

  const routeEmptyMessage = computed(() => {
    if (!quotes.providersCount.value) return 'Enter amount to fetch quotes'
    return 'No quotes found'
  })

  const routeItems = computed(() => {
    if (!borrowVault.value || !sourceVault.value) return []
    const isExactIn = direction.value === SwapperMode.EXACT_IN
    const asset = isExactIn ? borrowVault.value.asset : sourceVault.value.asset
    return buildSwapRouteItems({
      quoteCards: quotes.sortedQuoteCards.value,
      getQuoteDiffPct: quotes.getQuoteDiffPct,
      decimals: Number(asset.decimals),
      symbol: asset.symbol,
      formatAmount: formatSmartAmount,
      amountField: isExactIn ? 'amountOut' : 'amountIn',
      compare: isExactIn ? 'max' : 'min',
    })
  })

  return {
    currentPrice,
    summary,
    priceImpact,
    leveragedPriceImpact,
    routedVia,
    routeEmptyMessage,
    routeItems,
  }
}
