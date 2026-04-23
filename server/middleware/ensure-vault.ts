import { getRequestURL, sendRedirect } from 'h3'
import { isAddress } from 'viem'
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

  // Validate addresses are well-formed
  for (const addr of addresses) {
    if (!isAddress(addr)) {
      return sendRedirect(event, redirectUrl, 302)
    }
  }

  // Resolve chain from ?network= query param
  const networkParam = url.searchParams.get('network')
  const chainId = networkParam ? parseInt(networkParam, 10) : NaN
  if (!chainId || isNaN(chainId)) {
    return
  }

  // Check each vault address exists in the factory
  for (const addr of addresses) {
    const category = await getVaultCategory(chainId, addr)
    if (!category) {
      return sendRedirect(event, redirectUrl, 302)
    }
  }
})
