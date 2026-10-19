// Ordering + narrowing for the asset selector.
//
// The merged token list (Euler SDK + DefiLlama + Uniswap + Merkl) contains many
// thousands of tokens. Rather than hiding the long tail, we bubble the relevant
// tokens to the top and leave the rest reachable by scrolling / searching. The
// picker also renders rows incrementally, so the full list never fires a
// token-icon request per row up front.

export type SelectableToken = {
  balance: bigint
  // Decimal-adjusted balance — used to order held tokens by actual amount
  // (raw `balance` is not comparable across tokens with different decimals).
  balanceFormatted: number
  source: 'vault' | 'tokenList'
  asset: { symbol: string, name: string, address: string }
}

// Relevance buckets: tokens the user holds first, then Euler vault assets, then
// everything else.
const selectableRank = (token: SelectableToken): number =>
  token.balance > 0n ? 0 : token.source === 'vault' ? 1 : 2

// Sorts so relevant tokens bubble to the top — held (by amount, desc), then
// Euler vault assets, then the rest — alphabetical within each bucket. Returns a
// new array (does not mutate the input).
export function sortSelectableTokens<T extends SelectableToken>(options: T[]): T[] {
  return [...options].sort((a, b) => {
    const rankA = selectableRank(a)
    const rankB = selectableRank(b)
    if (rankA !== rankB) return rankA - rankB
    if (rankA === 0 && a.balanceFormatted !== b.balanceFormatted) {
      return b.balanceFormatted - a.balanceFormatted
    }
    return a.asset.symbol.localeCompare(b.asset.symbol)
  })
}

// Narrows the list for the picker:
// - any mode + search: match symbol / name / address, with stronger matches first.
// - input ("Pay with") + no search: only tokens the user holds.
// - output ("Receive as") + no search: the full list, unchanged — relevant
//   tokens are bubbled to the top by sortSelectableTokens, nothing is hidden.
export function filterSelectableTokens<T extends SelectableToken>(
  options: T[],
  mode: 'input' | 'output',
  searchQuery: string,
): T[] {
  const query = searchQuery.trim().toLowerCase()
  if (query) {
    const matchRank = (opt: T): number => {
      const symbol = opt.asset.symbol.toLowerCase()
      const name = opt.asset.name.toLowerCase()
      const address = opt.asset.address.toLowerCase()
      if (symbol === query || address === query) return 0
      if (symbol.startsWith(query)) return 1
      if (name === query) return 2
      if (name.startsWith(query)) return 3
      if (symbol.includes(query) || name.includes(query) || address.includes(query)) return 4
      return 5
    }
    return options
      .map((option, index) => ({ option, index, rank: matchRank(option) }))
      .filter(({ rank }) => rank < 5)
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map(({ option }) => option)
  }
  if (mode === 'input') {
    return options.filter(opt => opt.balance > 0n)
  }
  return options
}
