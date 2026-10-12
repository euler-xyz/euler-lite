import { afterEach, describe, expect, it, vi } from 'vitest'
import { zeroAddress } from 'viem'
import { createTokenDecimalsResolver, normalizeVaultTokenDecimals, TOKEN_DECIMALS_TTL_MS } from '~/utils/token-decimals'
import { withVerifiedVaultDecimals } from '~/utils/sdk-token-decimals'
import { getAssetOraclePrice, type EVault, type BuildQueryFn } from '@eulerxyz/euler-v2-sdk'

const ASSET = '0x720CD16b011b987Da3518fbf38c3071d4F0D1495'
const VAULT = '0x0000000000000000000000000000000000000001'
const passthrough: BuildQueryFn = (_name, fn) => fn

afterEach(() => vi.useRealTimers())

describe('shared token decimals', () => {
  it('deduplicates concurrent reads by chain and address and accepts zero decimals', async () => {
    const read = vi.fn(async (chainId: number) => chainId === 1 ? 0 : 17)
    const resolve = createTokenDecimalsResolver(read)
    expect(await Promise.all([resolve(1, ASSET), resolve(1, ASSET.toLowerCase()), resolve(43114, ASSET)])).toEqual([0, 0, 17])
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('expires successful metadata and never serves the expired value on failure', async () => {
    vi.useFakeTimers()
    const read = vi.fn().mockResolvedValueOnce(17).mockRejectedValueOnce(new Error('RPC unavailable')).mockResolvedValue(16)
    const resolve = createTokenDecimalsResolver(read)
    expect(await resolve(1, ASSET)).toBe(17)
    await vi.advanceTimersByTimeAsync(TOKEN_DECIMALS_TTL_MS)
    await expect(resolve(1, ASSET)).rejects.toThrow('RPC unavailable')
    expect(await resolve(1, ASSET)).toBe(16)
  })

  it('times out closed, shares an outstanding read, and accepts its late result', async () => {
    vi.useFakeTimers()
    let finish!: (value: number) => void
    const read = vi.fn(() => new Promise<number>((resolve) => {
      finish = resolve
    }))
    const resolve = createTokenDecimalsResolver(read)
    const failed = expect(resolve(1, ASSET)).rejects.toThrow('unavailable')
    await vi.advanceTimersByTimeAsync(5_000)
    await failed
    const retry = resolve(1, ASSET)
    finish(8)
    expect(await retry).toBe(8)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it.each([-1, 256, 1.5, Number.NaN])('rejects invalid decimals %s', async (decimals) => {
    const resolve = createTokenDecimalsResolver(async () => decimals)
    await expect(resolve(1, ASSET)).rejects.toThrow('Invalid token decimals')
  })

  it('takes native decimals from the chain definition without ERC-20 reads', async () => {
    const read = vi.fn()
    expect(await createTokenDecimalsResolver(read)(1, zeroAddress)).toBe(18)
    expect(read).not.toHaveBeenCalled()
  })

  it('normalizes snapshot assets and shares independently without mutating the input', async () => {
    const vault = { asset: { address: ASSET, decimals: 18 }, shares: { address: VAULT, decimals: 18 } }
    const result = await normalizeVaultTokenDecimals(1, vault, async (_chain, address) => address === ASSET ? 8 : 6)
    expect(result.asset.decimals).toBe(8)
    expect(result.shares.decimals).toBe(6)
    expect(vault.asset.decimals).toBe(18)
  })
})

describe('SDK indexed vault boundary', () => {
  it('verifies cached EVault results on each hydration, before pricing', async () => {
    const detail = { asset: { address: ASSET, decimals: 18 }, shares: { address: VAULT, decimals: 18 } }
    const resolve = vi.fn().mockResolvedValueOnce(8).mockResolvedValueOnce(6).mockRejectedValue(new Error('unavailable'))
    const query = withVerifiedVaultDecimals(passthrough, resolve)('queryV3EVaultDetail', async (_key: { chainId: number }) => detail, {})
    expect(await query({ chainId: 1 })).toMatchObject({ asset: { decimals: 8 }, shares: { decimals: 6 } })
    await expect(query({ chainId: 1 })).rejects.toThrow('unavailable')
    expect(detail.asset.decimals).toBe(18)
  })

  it('keeps an indexed debt oracle quote denominated in one verified asset', async () => {
    const quote = {
      amountIn: 10n ** 18n,
      amountOutMid: 10n ** 30n,
      amountOutBid: 9n * 10n ** 29n,
      amountOutAsk: 11n * 10n ** 29n,
      timestamp: 123,
    }
    const vault = { asset: { address: ASSET, decimals: 18 }, shares: { address: VAULT, decimals: 18 }, oraclePriceRaw: quote }
    const verified = await normalizeVaultTokenDecimals(1, vault, async (_chain, address) => address === ASSET ? 6 : 18)
    expect(verified.oraclePriceRaw).toEqual({
      amountIn: 1_000_000n,
      amountOutMid: 10n ** 18n,
      amountOutBid: 9n * 10n ** 17n,
      amountOutAsk: 11n * 10n ** 17n,
      timestamp: 123,
    })
    expect(getAssetOraclePrice({ ...verified, unitOfAccount: { decimals: 18 } } as EVault)).toMatchObject({
      amountOutMid: 10n ** 18n, amountOutAsk: 11n * 10n ** 17n, amountOutBid: 9n * 10n ** 17n,
    })
    expect(quote.amountIn).toBe(10n ** 18n)
  })

  it('preserves wire strings and rounds the normalized ask conservatively', async () => {
    const quote = { amountIn: '3', amountOutMid: '10', amountOutBid: '10', amountOutAsk: '10' }
    const vault = { asset: { address: ASSET }, shares: { address: VAULT }, oraclePriceRaw: quote }
    const verified = await normalizeVaultTokenDecimals(1, vault, async () => 0)
    expect(verified.oraclePriceRaw).toEqual({ amountIn: '1', amountOutMid: '3', amountOutBid: '3', amountOutAsk: '4' })
  })

  it('normalizes Earn assets and the independently denominated share token', async () => {
    const query = withVerifiedVaultDecimals(passthrough, async (_chain, address) => address === ASSET ? 8 : 18)(
      'queryV3EulerEarnDetail', async (_url: string, _chain: number) => ({ data: { address: VAULT, decimals: 18, asset: { address: ASSET, decimals: 18 } } }), {},
    )
    expect(await query('v3', 1)).toMatchObject({ data: { decimals: 18, asset: { decimals: 8 } } })
  })
})
