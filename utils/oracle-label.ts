import type { Address } from 'viem'
import { USD_ADDRESS, EUR_ADDRESS, BTC_ADDRESS, ETH_ADDRESS } from '~/entities/constants'

// Special designator addresses that stand for an FX-style denomination unit
// (USD, EUR, BTC, ETH) rather than a real ERC20. When the adapter is wired
// with one of these on one side, that side is the "currency" and the other
// is the asset being priced — giving us an unambiguous direction without
// having to parse symbols out of the label.
const DESIGNATOR_ADDRESSES = new Set<string>([
  USD_ADDRESS.toLowerCase(),
  EUR_ADDRESS.toLowerCase(),
  BTC_ADDRESS.toLowerCase(),
  ETH_ADDRESS.toLowerCase(),
])

const isDesignator = (address: Address | string): boolean =>
  DESIGNATOR_ADDRESSES.has(address.toLowerCase())

// Symbol comparison scores (higher is more confident):
//   2 = exact match
//   1 = loose match — one symbol is a wrapped variant of the other
//   0 = no match
//
// Wrapped ERC20s usually keep the underlying asset's symbol as a contiguous
// core, padded by a short prefix and/or suffix marker — e.g. "STRC" → "STRCx",
// "STRC" → "wSTRCx", "ETH" → "WETH", "ETH" → "wstETH". The score lets a caller
// break a tie when both label sides loosely match both wirings (stETH ↔ ETH,
// wSTRCx ↔ STRCx) — exact matches outrank loose ones.
const symbolMatchScore = (labelSym: string, addressSym: string): 0 | 1 | 2 => {
  const a = labelSym.trim().toLowerCase()
  const b = addressSym.trim().toLowerCase()
  if (!a || !b) return 0
  if (a === b) return 2

  const core = a.length <= b.length ? a : b
  const wrapped = a.length <= b.length ? b : a
  const idx = wrapped.indexOf(core)
  if (idx === -1) return 0

  const prefixLen = idx
  const suffixLen = wrapped.length - idx - core.length

  // Cap the wrapping markers — without an upper bound, "ETH" would match
  // anything that happens to contain it as a substring.
  if (prefixLen > 3 || suffixLen > 3) return 0

  // Designator-length 3-letter symbols (USD, EUR, BTC, ETH, ...) need a real
  // leading marker to disambiguate from longer tickers built on the same
  // letters. "USDC" starts with "USD" with no marker → reject. "WETH" / "stETH"
  // have a leading w/st marker → accept.
  if (core.length < 4 && prefixLen === 0) return 0

  return 1
}

export const parseOracleLabelPair = (labelPrimary: string | undefined): [string, string] | null => {
  if (!labelPrimary) return null
  const parts = labelPrimary.split('/').map(s => s.trim()).filter(Boolean)
  if (parts.length !== 2) return null
  return [parts[0], parts[1]]
}

// The adapter's getQuote returns "quote per base" for the wiring the UI calls.
// We want the displayed price to read in the natural human direction (asset
// priced in its denomination), so we may need to invert.
//
// Decision flow:
//  1. If exactly one wiring side is an FX designator (USD/EUR/BTC/ETH), use it
//     as an anchor — the designator is always the denomination. Invert when
//     the denomination is on the BASE side. This requires no label parsing
//     and works even if the ERC20 symbol hasn't been resolved yet.
//  2. Otherwise (both designators or both ERC20s) fall back to scoring the
//     label symbols against the resolved wiring symbols.
export const shouldInvertOraclePrice = (
  labelPrimary: string | undefined,
  baseAddress: Address | string,
  quoteAddress: Address | string,
  baseSymbol: string,
  quoteSymbol: string,
): boolean => {
  const baseIsDesignator = isDesignator(baseAddress)
  const quoteIsDesignator = isDesignator(quoteAddress)

  if (baseIsDesignator !== quoteIsDesignator) {
    return baseIsDesignator
  }

  const pair = parseOracleLabelPair(labelPrimary)
  if (!pair) return false
  const [left, right] = pair

  // A direction only counts when BOTH sides have a non-zero score —
  // otherwise a single accidental exact match (e.g. only the quote side)
  // would flip the price on weak evidence.
  const directLeft = symbolMatchScore(left, baseSymbol)
  const directRight = symbolMatchScore(right, quoteSymbol)
  const flippedLeft = symbolMatchScore(left, quoteSymbol)
  const flippedRight = symbolMatchScore(right, baseSymbol)
  const directScore = directLeft && directRight ? directLeft + directRight : 0
  const flippedScore = flippedLeft && flippedRight ? flippedLeft + flippedRight : 0

  return flippedScore > directScore
}
