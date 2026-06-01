import { getRequestURL, sendRedirect } from 'h3'
import { getAddress, isAddress } from 'viem'
import { getVaultCategory } from '../utils/vault-categories-store'

/**
 * Vault route patterns:
 *   /lend/{address}[/...]
 *   /earn/{address}[/...]
 *   /borrow/{address}/{address}[/...]
 */
const LEND_EARN_RE = /^\/(lend|earn)\/([^/?#]+)/
const BORROW_RE = /^\/borrow\/([^/?#]+)\/([^/?#]+)/

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
  // check so addresses with non-canonical EIP-55 checksum casing (e.g. a
  // hand-edited or lowercased URL) are still accepted — strict mode would
  // reject a valid vault address purely on checksum casing and bounce the user
  // to the section list. getAddress() canonicalizes the casing for the
  // downstream category lookup (which itself validates strictly).
  const normalized: string[] = []
  for (const addr of addresses) {
    if (!isAddress(addr, { strict: false })) {
      return sendRedirect(event, redirectUrl, 302)
    }
    normalized.push(getAddress(addr))
  }

  // Resolve chain from ?network= query param
  const networkParam = url.searchParams.get('network')
  const chainId = networkParam ? parseInt(networkParam, 10) : NaN
  if (!chainId || isNaN(chainId)) {
    return
  }

  // Check each vault address exists in the factory
  for (const addr of normalized) {
    const category = await getVaultCategory(chainId, addr)
    if (!category) {
      return sendRedirect(event, redirectUrl, 302)
    }
  }
})
