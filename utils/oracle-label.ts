// Label symbols frequently drop a trailing wrapper marker (e.g. "STRC" for
// ERC20 "STRCx"), so the resolved ERC20 symbol is allowed to be longer than
// the label symbol — never the other way, to avoid false positives between
// unrelated symbols that happen to share a prefix (e.g. "USDC" vs "USD").
const symbolsMatch = (labelSym: string, addressSym: string): boolean => {
  const a = labelSym.trim().toLowerCase()
  const b = addressSym.trim().toLowerCase()
  if (!a || !b) return false
  return a === b || b.startsWith(a)
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
