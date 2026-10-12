import { getAddress, zeroAddress, type Address } from 'viem'
import type { EulerSDK } from '@eulerxyz/euler-v2-sdk'
import { getChainById } from '~/entities/chainRegistry'

export const TOKEN_DECIMALS_TTL_MS = 5 * 60_000
export const TOKEN_DECIMALS_DEADLINE_MS = 5_000
export type ResolveTokenDecimals = (chainId: number, address: string) => Promise<number>

/** Request-driven, bounded metadata cache. Failed reads never authorize list decimals. */
export const createTokenDecimalsResolver = (
  read: (chainId: number, address: Address) => Promise<number>,
): ResolveTokenDecimals => {
  const cache = new Map<string, { decimals: number, expiresAt: number }>()
  const pending = new Map<string, Promise<number>>()

  return async (chainId, address) => {
    const normalized = getAddress(address)
    if (normalized === zeroAddress) {
      const native = getChainById(chainId)?.nativeCurrency
      if (!native) throw new Error(`Unknown native currency for chain ${chainId}`)
      return native.decimals
    }
    const key = `${chainId}:${normalized.toLowerCase()}`
    const cached = cache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.decimals
    cache.delete(key)
    let flight = pending.get(key)
    if (!flight) {
      flight = Promise.resolve().then(() => read(chainId, normalized)).then((decimals) => {
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
          throw new Error(`Invalid token decimals for ${normalized}`)
        }
        if (cache.size >= 20_000) cache.delete(cache.keys().next().value!)
        cache.set(key, { decimals, expiresAt: Date.now() + TOKEN_DECIMALS_TTL_MS })
        return decimals
      }).finally(() => {
        pending.delete(key)
      })
      pending.set(key, flight)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        flight,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Token decimals unavailable for ${normalized}`)), TOKEN_DECIMALS_DEADLINE_MS)
        }),
      ])
    }
    finally {
      clearTimeout(timer)
    }
  }
}

const resolvers = new WeakMap<EulerSDK, ResolveTokenDecimals>()
export const getSdkTokenDecimals = (sdk: EulerSDK): ResolveTokenDecimals => {
  let resolve = resolvers.get(sdk)
  if (!resolve) {
    resolve = createTokenDecimalsResolver(async (chainId, address) => {
      if (!sdk.tokenlistService.resolveTokenDecimals) throw new Error('SDK token decimals resolver unavailable')
      return sdk.tokenlistService.resolveTokenDecimals(chainId, address)
    })
    resolvers.set(sdk, resolve)
  }
  return resolve
}

interface TokenMetadata { address: string, decimals?: number }
interface AssetOracleQuote {
  amountIn: bigint | string
  amountOutMid: bigint | string
  amountOutBid: bigint | string
  amountOutAsk: bigint | string
}

// SDK asset-price consumers expect a quote for one whole underlying token.
// Preserve wire strings versus decoded bigints and every other oracle field.
const normalizeAssetOracleQuote = <T extends AssetOracleQuote>(quote: T, decimals: number): T => {
  const amountIn = BigInt(quote.amountIn)
  const unit = 10n ** BigInt(decimals)
  if (amountIn === unit) return quote
  const scale = (value: bigint | string, roundUp = false) => {
    const numerator = BigInt(value) * unit
    const result = amountIn > 0n ? (numerator + (roundUp ? amountIn - 1n : 0n)) / amountIn : 0n
    return typeof value === 'bigint' ? result : result.toString()
  }
  return {
    ...quote,
    amountIn: typeof quote.amountIn === 'bigint' ? unit : unit.toString(),
    amountOutMid: scale(quote.amountOutMid),
    amountOutBid: scale(quote.amountOutBid),
    amountOutAsk: scale(quote.amountOutAsk, true),
  }
}

/** Keep asset and share contracts independent; never mutate cached upstream objects. */
export const normalizeVaultTokenDecimals = async <T extends { asset: TokenMetadata, shares: TokenMetadata, oraclePriceRaw?: AssetOracleQuote }>(
  chainId: number,
  vault: T,
  resolve: ResolveTokenDecimals,
): Promise<T> => {
  const [assetDecimals, shareDecimals] = await Promise.all([
    resolve(chainId, vault.asset.address), resolve(chainId, vault.shares.address),
  ])
  return {
    ...vault,
    asset: { ...vault.asset, decimals: assetDecimals },
    shares: { ...vault.shares, decimals: shareDecimals },
    ...(vault.oraclePriceRaw ? { oraclePriceRaw: normalizeAssetOracleQuote(vault.oraclePriceRaw, assetDecimals) } : {}),
  }
}
