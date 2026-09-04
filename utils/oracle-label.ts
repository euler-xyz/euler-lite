import type { Address } from 'viem'

// Each oracle adapter has its own on-chain (base, quote) wiring (reported in
// the Data V3 assessment config as `meta.base` / `meta.quote`). Its
// `getQuote(amount, base, quote)` returns the natural feed direction when
// called in the wired order; the args swapped returns the inverse.
//
// The EulerRouter resolves vault assets through ERC-4626 unwraps and cross
// adapters and ends up calling each leaf adapter in the direction the router
// needs. That direction may match the adapter's wiring or be flipped — when
// it's flipped, the displayed rate is the inverse of the feed's natural
// number and we want to invert it so the price reads in the direction the
// label implies.
//
// We compare addresses (not symbols) because that is unambiguous; this also
// avoids depending on async ERC20 symbol() resolution for assets that aren't
// registered vault assets (e.g. STRCx underlying a wSTRCx vault).
type InvertArgs = {
  /** Adapter's on-chain base (from the V3 assessment config). */
  metaBase: Address | string | undefined
  /** Adapter's on-chain quote (from the V3 assessment config). */
  metaQuote: Address | string | undefined
  /** Direction the router actually calls the adapter with (`OracleAdapterEntry.base`). */
  callerBase: Address | string
  /** Direction the router actually calls the adapter with (`OracleAdapterEntry.quote`). */
  callerQuote: Address | string
}

const sameDirection = (
  a: Address | string,
  b: Address | string,
  c: Address | string,
  d: Address | string,
): boolean => a.toLowerCase() === c.toLowerCase() && b.toLowerCase() === d.toLowerCase()

export const shouldInvertOraclePrice = ({
  metaBase,
  metaQuote,
  callerBase,
  callerQuote,
}: InvertArgs): boolean => {
  if (!metaBase || !metaQuote) return false
  if (sameDirection(callerBase, callerQuote, metaBase, metaQuote)) return false
  if (sameDirection(callerBase, callerQuote, metaQuote, metaBase)) return true
  // Caller pair doesn't line up with the wiring in either direction —
  // unexpected (no-match fallback). Don't flip.
  return false
}
