import { getRequestURL, sendRedirect } from 'h3'
import { VaultType } from '@eulerxyz/euler-v2-sdk'
import { getAddress, isAddress, type Address } from 'viem'
import { withWallClock } from '../utils/fetchWithTimeout'
import { logger } from '../utils/logger'
import { getServerSdk } from '../utils/sdk-server'

/**
 * Vault route patterns:
 *   /lend/{address}[/...]
 *   /earn/{address}[/...]
 *   /borrow/{address}/{address}[/...]
 */
const LEND_EARN_RE = /^\/(lend|earn)\/([^/?#]+)/
const BORROW_RE = /^\/borrow\/([^/?#]+)\/([^/?#]+)/
const VAULT_ROUTE_VALIDATION_BUDGET_MS = 8_000

const resolveVaultTypes = async (
  chainId: number,
  addresses: Address[],
): Promise<Partial<Record<Address, string>> | undefined> => {
  try {
    return await withWallClock(
      async () => (await getServerSdk(chainId)).vaultMetaService.fetchVaultTypes(chainId, addresses),
      VAULT_ROUTE_VALIDATION_BUDGET_MS,
      'vault route validation',
    )
  }
  catch (err) {
    // Viem transport errors contain the raw provider URL in several fields.
    // The server logger's `err` serializer reduces it to a host-only summary.
    logger.warn({ ctx: 'ensure-vault', chainId, err }, 'failed to validate vault route')
    return undefined
  }
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

  // Validate route address segments before resolving vault types. Snapshot
  // membership is not exhaustive: unverified EVK vaults can still be valid
  // direct links when the SDK resolver recognizes them.
  const normalized: Address[] = []
  for (const addr of addresses) {
    if (!isAddress(addr, { strict: false })) {
      return sendRedirect(event, redirectUrl, 302)
    }
    normalized.push(getAddress(addr))
  }

  // Resolve chain from ?network= query param. If it is absent, keep the route
  // client-backed because we cannot pick the right chain resolver safely.
  const networkParam = url.searchParams.get('network')
  const chainId = networkParam ? parseInt(networkParam, 10) : NaN
  if (!chainId || isNaN(chainId)) {
    return
  }

  const types = await resolveVaultTypes(chainId, normalized)
  if (!types) {
    return
  }

  for (const addr of normalized) {
    const type = types[addr] ?? types[addr.toLowerCase() as Address]
    if (!type || type === VaultType.Unknown) {
      return sendRedirect(event, redirectUrl, 302)
    }
  }
})
