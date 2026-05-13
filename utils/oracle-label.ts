import type { Address } from 'viem'

export const parseOracleLabelPair = (labelPrimary: string | undefined): [string, string] | null => {
  if (!labelPrimary) return null
  const parts = labelPrimary.split('/').map(s => s.trim()).filter(Boolean)
  if (parts.length !== 2) return null
  return [parts[0], parts[1]]
}

// Each oracle adapter has its own on-chain (base, quote) wiring (from the
// oracle-checks metadata). Its `getQuote(amount, base, quote)` returns the
// natural feed direction when called in that wired order; calling it with the
// arguments swapped returns the inverse.
//
// The router resolves vault assets through ERC4626 unwraps, cross adapters,
// etc., and ends up calling each leaf adapter with the (base, quote) pair the
// router wants. That pair may match the adapter's wiring or be flipped — when
// it's flipped, the displayed rate is the inverse of the feed's natural number
// and we need to invert it back so the displayed price reads in the direction
// the label implies.
const sameDirection = (
  a: Address | string,
  b: Address | string,
  c: Address | string,
  d: Address | string,
): boolean => a.toLowerCase() === c.toLowerCase() && b.toLowerCase() === d.toLowerCase()

export const shouldInvertOraclePrice = (
  metaBase: Address | string | undefined,
  metaQuote: Address | string | undefined,
  callerBase: Address | string,
  callerQuote: Address | string,
): boolean => {
  if (!metaBase || !metaQuote) return false
  if (sameDirection(callerBase, callerQuote, metaBase, metaQuote)) return false
  if (sameDirection(callerBase, callerQuote, metaQuote, metaBase)) return true
  return false
}
