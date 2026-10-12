import type { BuildQueryFn } from '@eulerxyz/euler-v2-sdk'
import { normalizeVaultTokenDecimals, type ResolveTokenDecimals } from '~/utils/token-decimals'

/** Normalize indexed metadata before SDK hydration, pricing, and account population. */
export const withVerifiedVaultDecimals = (
  buildQuery: BuildQueryFn,
  resolve: ResolveTokenDecimals,
): BuildQueryFn => (queryName, fn, target, context) => {
  const query = buildQuery(queryName, fn, target, context)
  if (queryName === 'queryV3EVaultDetail') {
    return (async (...args: Parameters<typeof fn>) => {
      const detail = await query(...args)
      if (!detail) return detail
      return normalizeVaultTokenDecimals(args[0].chainId, detail, resolve)
    }) as typeof fn
  }
  if (queryName === 'queryV3EulerEarnDetail') {
    return (async (...args: Parameters<typeof fn>) => {
      const response = await query(...args)
      if (!response?.data) return response
      const detail = response.data
      const normalized = await normalizeVaultTokenDecimals(args[1], {
        asset: detail.asset,
        shares: { address: detail.address, decimals: detail.decimals },
      }, resolve)
      return { ...response, data: { ...detail, asset: normalized.asset, decimals: normalized.shares.decimals } }
    }) as typeof fn
  }
  // On-chain lens queries read ERC-20 metadata directly. List queries carry
  // discovery addresses only; their details pass through the cases above.
  return query
}
