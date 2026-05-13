// Symbol comparison scores (higher is more confident):
//   2 = exact match (e.g. "USD" ↔ "USD")
//   1 = loose match — one symbol is a wrapped variant of the other
//       (e.g. "STRC" ↔ "STRCx", "ETH" ↔ "wstETH")
//   0 = no match
//
// Wrapped ERC20s usually keep the underlying asset's symbol as a contiguous
// core, padded by a short prefix and/or suffix marker — e.g. "STRC" → "STRCx",
// "STRC" → "wSTRCx", "ETH" → "WETH", "ETH" → "wstETH".
//
// The score lets a caller choose between competing directions: when the
// adapter's base and quote are aliases of each other (stETH vs ETH, wSTRCx vs
// STRCx), both label sides can match both wirings loosely, and a boolean
// "matches?" check would tie. Preferring the higher-score direction breaks
// the tie correctly because exact matches outrank loose ones.
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

// The adapter's getQuote returns "quote per base" given the on-chain wiring,
// but oracle-checks labels follow the "X / Y = Y per X" FX convention regardless
// of which side was assigned as base. When the label flips the symbols relative
// to the wiring, invert the rate so the displayed number matches the displayed name.
//
// Direction is decided by scoring both pairings of label symbols against adapter
// (base, quote) symbols and picking the higher-scoring one. This handles cases
// where each label side could loosely match either wiring side (e.g. "stETH /
// ETH" with adapter base=ETH, quote=stETH) — the exact-match pairing wins.
export const shouldInvertOraclePrice = (
  labelPrimary: string | undefined,
  baseSymbol: string,
  quoteSymbol: string,
): boolean => {
  const pair = parseOracleLabelPair(labelPrimary)
  if (!pair) return false
  const [left, right] = pair

  // A direction only counts when BOTH sides have a non-zero score —
  // otherwise a single exact match (e.g. only the quote side matches)
  // would flip the price on weak evidence.
  const directLeft = symbolMatchScore(left, baseSymbol)
  const directRight = symbolMatchScore(right, quoteSymbol)
  const flippedLeft = symbolMatchScore(left, quoteSymbol)
  const flippedRight = symbolMatchScore(right, baseSymbol)
  const directScore = directLeft && directRight ? directLeft + directRight : 0
  const flippedScore = flippedLeft && flippedRight ? flippedLeft + flippedRight : 0

  return flippedScore > directScore
}
