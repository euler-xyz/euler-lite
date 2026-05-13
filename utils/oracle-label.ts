// Wrapped ERC20s usually keep the underlying asset's symbol as a contiguous
// core, padded by a short prefix and/or suffix marker — e.g. "STRC" → "STRCx"
// (suffix "x"), "STRC" → "wSTRCx" (prefix "w" + suffix "x"), "ETH" → "WETH"
// (prefix "W"), "ETH" → "wstETH" (prefix "wst").
//
// Match if one symbol contains the other as such a core, but reject matches
// where a 3-letter symbol bleeds into a longer one without a leading marker
// — that's the "USD" ⊂ "USDC" / "BTC" ⊂ "BTCB" case, which should not match.
const symbolsMatch = (labelSym: string, addressSym: string): boolean => {
  const a = labelSym.trim().toLowerCase()
  const b = addressSym.trim().toLowerCase()
  if (!a || !b) return false
  if (a === b) return true

  const core = a.length <= b.length ? a : b
  const wrapped = a.length <= b.length ? b : a
  const idx = wrapped.indexOf(core)
  if (idx === -1) return false

  const prefixLen = idx
  const suffixLen = wrapped.length - idx - core.length

  // Cap the wrapping markers — without an upper bound, "ETH" would match
  // anything that happens to contain it as a substring.
  if (prefixLen > 3 || suffixLen > 3) return false

  // Designator-like 3-letter symbols (USD, EUR, BTC, ETH, ...) need a real
  // leading marker to disambiguate from longer tickers built on the same
  // letters. "USDC" starts with "USD" with no marker → reject. "WETH" / "stETH"
  // have a leading w/st marker → accept.
  if (core.length < 4 && prefixLen === 0) return false

  return true
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
export const shouldInvertOraclePrice = (
  labelPrimary: string | undefined,
  baseSymbol: string,
  quoteSymbol: string,
): boolean => {
  const pair = parseOracleLabelPair(labelPrimary)
  if (!pair) return false
  const [left, right] = pair
  const directMatch = symbolsMatch(left, baseSymbol) && symbolsMatch(right, quoteSymbol)
  if (directMatch) return false
  return symbolsMatch(left, quoteSymbol) && symbolsMatch(right, baseSymbol)
}
