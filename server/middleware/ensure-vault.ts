import { getRequestURL, sendRedirect } from 'h3'
import { getAddress, isAddress } from 'viem'
import { withWallClock } from '../utils/fetchWithTimeout'
import {
  refreshChainVaults,
  vaultsCache,
  type SerialisedSnapshot,
  type SerialisedVault,
} from '../utils/vaults-cache'

/**
 * Vault route patterns:
 *   /lend/{address}[/...]
 *   /earn/{address}[/...]
 *   /borrow/{address}/{address}[/...]
 */
const LEND_EARN_RE = /^\/(lend|earn)\/([^/?#]+)/
const BORROW_RE = /^\/borrow\/([^/?#]+)\/([^/?#]+)/
const VAULT_ROUTE_VALIDATION_BUDGET_MS = 8_000

const getSnapshot = async (chainId: number): Promise<SerialisedSnapshot | undefined> => {
  const cacheKey = String(chainId)
  const cached = vaultsCache.get(cacheKey) ?? vaultsCache.getStale(cacheKey)
  if (cached) return cached

  try {
    return await withWallClock(
      () => refreshChainVaults(chainId),
      VAULT_ROUTE_VALIDATION_BUDGET_MS,
      'vault route validation',
    )
  }
  catch (err) {
    console.warn('[ensure-vault] failed to validate vault route', err)
    return undefined
  }
}

const getVaultAddress = (vault: SerialisedVault): string | undefined => {
  const data = vault.data as { address?: unknown }
  return typeof data.address === 'string' ? data.address : undefined
}

const snapshotHasVault = (snapshot: SerialisedSnapshot, address: string): boolean => {
  const normalized = address.toLowerCase()
  return [
    ...snapshot.evkVaults,
    ...snapshot.earnVaults,
    ...snapshot.securitizeVaults,
    ...snapshot.escrowVaults,
  ].some(vault => getVaultAddress(vault)?.toLowerCase() === normalized)
}

export default defineEventHandler(async (event) => {
  const url = getRequestURL(event)
  const path = url.pathname

  // Only intercept page navigations, not API/asset requests
  if (path.startsWith('/api/') || path.startsWith('/_nuxt/') || path.startsWith('/__nuxt')) {
    return
  }

  // Extract vault addresses and the base route section from the URL path
  const addresses: string[] = []
  let section = ''

  const lendEarnMatch = path.match(LEND_EARN_RE)
  if (lendEarnMatch) {
    section = lendEarnMatch[1] // 'lend' or 'earn'
    addresses.push(lendEarnMatch[2])
  }

  const borrowMatch = path.match(BORROW_RE)
  if (borrowMatch) {
    section = 'borrow'
    addresses.push(borrowMatch[1], borrowMatch[2])
  }

  if (!addresses.length) {
    return
  }

  const query = url.searchParams.toString()
  const redirectUrl = `/${section}${query ? `?${query}` : ''}`

  // Validate addresses are well-formed and normalize them. Use the non-strict
  // check so valid addresses with non-canonical checksum casing do not get
  // bounced; getAddress() canonicalizes casing for snapshot membership checks.
  const normalized: string[] = []
  for (const addr of addresses) {
    if (!isAddress(addr, { strict: false })) {
      return sendRedirect(event, redirectUrl, 302)
    }
    normalized.push(getAddress(addr))
  }

  // Resolve chain from ?network= query param. If it is absent, keep the route
  // client-backed because we cannot pick the right chain snapshot safely.
  const networkParam = url.searchParams.get('network')
  const chainId = networkParam ? parseInt(networkParam, 10) : NaN
  if (!chainId || isNaN(chainId)) {
    return
  }

  const snapshot = await getSnapshot(chainId)
  if (!snapshot) {
    return
  }

  for (const addr of normalized) {
    if (!snapshotHasVault(snapshot, addr)) {
      return sendRedirect(event, redirectUrl, 302)
    }
  }
})
