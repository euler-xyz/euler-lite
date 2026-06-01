import { getRequestURL, sendRedirect } from 'h3'
import { isAddress } from 'viem'

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

  // Validate addresses are well-formed. Use the non-strict check so valid
  // addresses with non-canonical checksum casing do not get bounced.
  for (const addr of addresses) {
    if (!isAddress(addr, { strict: false })) {
      return sendRedirect(event, redirectUrl, 302)
    }
  }

  // Existence/type validation is SDK-backed on the client. Server middleware
  // only rejects malformed route addresses so direct navigation does not keep
  // a duplicate vault-classification fetch path alive.
})
