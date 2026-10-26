export interface RingLink {
  from: string
  to: string
}

export interface RingSlots {
  slotByAddress: ReadonlyMap<string, number>
  slotCount: number
}

type Adjacency = ReadonlyMap<string, readonly string[]>
type Compare = (a: string, b: string) => number

const compareAddresses: Compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

const buildAdjacency = (addresses: readonly string[], links: readonly RingLink[]): Adjacency => {
  const known = new Set(addresses)
  const usable = links.filter(({ from, to }) => from !== to && known.has(from) && known.has(to))
  return new Map(addresses.map(address => [
    address,
    [...new Set(usable.flatMap(({ from, to }) =>
      from === address ? [to] : to === address ? [from] : [],
    ))],
  ]))
}

// Depth-first, taking the neighbour with the fewest unvisited links first, so two
// well-connected vaults land across the ring rather than side by side and chords cross less.
const walkDepthFirst = (
  address: string,
  visited: ReadonlySet<string>,
  adjacency: Adjacency,
  byRank: Compare,
): string[] => {
  const extend = (order: readonly string[]): string[] => {
    const seen = new Set([...visited, ...order])
    const unvisitedLinks = (candidate: string) =>
      (adjacency.get(candidate) ?? []).filter(neighbour => !seen.has(neighbour)).length
    const [next] = (adjacency.get(address) ?? [])
      .filter(neighbour => !seen.has(neighbour))
      .sort((a, b) => unvisitedLinks(a) - unvisitedLinks(b) || byRank(a, b))
    return next === undefined
      ? [...order]
      : extend([...order, ...walkDepthFirst(next, seen, adjacency, byRank)])
  }
  return extend([address])
}

const orderGroup = (members: readonly string[], adjacency: Adjacency, byRank: Compare): string[] => {
  const degree = (address: string) => adjacency.get(address)?.length ?? 0
  const [start] = [...members].sort((a, b) => degree(b) - degree(a) || byRank(a, b))
  return walkDepthFirst(start, new Set(), adjacency, byRank)
}

const lowestAddress = (group: readonly string[]) => [...group].sort(compareAddresses)[0]

// Feeding the flattened result back in must return it unchanged: the mini preview
// orders its nodes with this, and the enlarged graph calls it again on that order.
export const getRingBlocks = (addresses: readonly string[], links: readonly RingLink[]): string[][] => {
  const unique = [...new Set(addresses)]
  const adjacency = buildAdjacency(unique, links)
  const rank = new Map(unique.map((address, index) => [address, index]))
  const byRank: Compare = (a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0)
  const isIsolated = (address: string) => (adjacency.get(address)?.length ?? 0) === 0

  const groups = unique.reduce<string[][]>((found, address) => {
    if (isIsolated(address) || found.some(group => group.includes(address))) return found
    const members = walkDepthFirst(address, new Set(), adjacency, byRank)
    return [...found, orderGroup(members, adjacency, byRank)]
  }, [])
  const sortedGroups = [...groups].sort((a, b) =>
    b.length - a.length || compareAddresses(lowestAddress(a), lowestAddress(b)))
  const isolated = unique.filter(isIsolated)

  return isolated.length > 0 ? [...sortedGroups, isolated] : sortedGroups
}

// The gap after the last block is the one between it and the first block across the ring's start.
export const getRingSlots = (blocks: readonly (readonly string[])[], withGaps: boolean): RingSlots => {
  const gap = withGaps && blocks.length > 1 ? 1 : 0
  const { entries, slotCount } = blocks.reduce<{ entries: Array<[string, number]>, slotCount: number }>(
    (placed, block) => ({
      entries: [...placed.entries, ...block.map((address, index): [string, number] => [address, placed.slotCount + index])],
      slotCount: placed.slotCount + block.length + gap,
    }),
    { entries: [], slotCount: 0 },
  )
  return { slotByAddress: new Map(entries), slotCount }
}
