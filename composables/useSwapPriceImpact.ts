import type { SecuritizeCollateralVault, EulerEarn, EVault, SwapQuote } from '@eulerxyz/euler-v2-sdk'
import { getTokenUsdValue } from '~/utils/sdk-prices'
import { createRaceGuard } from '~/utils/race-guard'
import type { Ref } from 'vue'

type AnyVault = EVault | SecuritizeCollateralVault | EulerEarn

export const useSwapPriceImpact = (options: {
  quote: Ref<SwapQuote | null>
  fromVault?: Ref<AnyVault | null | undefined>
  toVault?: Ref<AnyVault | null | undefined>
}) => {
  const priceImpact = ref<number | null>(null)
  const guard = createRaceGuard()

  watchEffect(async () => {
    const q = options.quote.value
    if (!q) {
      priceImpact.value = null
      return
    }

    const amountIn = BigInt(q.amountIn || 0)
    const amountOut = BigInt(q.amountOut || 0)
    if (amountIn <= 0n || amountOut <= 0n) {
      priceImpact.value = null
      return
    }

    const tokenInAddr = q.tokenIn.address
    const tokenOutAddr = q.tokenOut.address

    const gen = guard.next()
    const [inUsd, outUsd] = await Promise.all([
      getTokenUsdValue(amountIn, q.tokenIn.decimals, tokenInAddr, options.fromVault?.value),
      getTokenUsdValue(amountOut, q.tokenOut.decimals, tokenOutAddr, options.toVault?.value),
    ])
    if (guard.isStale(gen)) return

    if (!inUsd || !outUsd) {
      priceImpact.value = null
      return
    }
    const impact = (outUsd / inUsd - 1) * 100
    priceImpact.value = Number.isFinite(impact) ? impact : null
  })

  return { priceImpact }
}
