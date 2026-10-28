import { describe, expect, it } from 'vitest'
import { getRingBlocks, getRingSlots, type RingLink } from '~/utils/discovery-graph-layout'
import { getEnlargedDiagram, getLabelPosition } from '~/utils/discoveryCalculations'
import type { MiniDiagramData, MiniNode } from '~/entities/lend-discovery'

const link = (from: string, to: string): RingLink => ({ from, to })

const isolatedPairs = (count: number) => {
  const liabilities = Array.from({ length: count }, (_, i) => `0xu${i + 1}`)
  const collaterals = Array.from({ length: count }, (_, i) => `0xx${i + 1}`)
  return {
    addresses: [...liabilities, ...collaterals],
    links: collaterals.map((collateral, i) => link(collateral, liabilities[i])),
  }
}

const diagramOf = (addresses: string[], links: RingLink[]): MiniDiagramData => {
  const nodes: MiniNode[] = addresses.map(address => ({
    address,
    assetAddress: address,
    assetSymbol: address.slice(2).toUpperCase(),
    x: 0,
    y: 0,
  }))
  const byAddress = new Map(nodes.map(node => [node.address, node]))
  return {
    nodes,
    edges: links.map(({ from, to }) => ({ from: byAddress.get(from)!, to: byAddress.get(to)!, mutual: false })),
    pairCount: links.length,
    assetCount: nodes.length,
    viewWidth: 0,
  }
}

type Point = { x: number, y: number }

const side = (p: Point, q: Point, r: Point) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x))

const segmentsCross = (a: Point, b: Point, c: Point, d: Point) =>
  side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0

const countCrossings = (edges: Array<{ from: Point & { address: string }, to: Point & { address: string } }>) =>
  edges.flatMap((first, i) => edges.slice(i + 1).map(second => [first, second] as const))
    .filter(([first, second]) => {
      const shared = [first.from.address, first.to.address].some(address =>
        address === second.from.address || address === second.to.address)
      return !shared && segmentsCross(first.from, first.to, second.from, second.to)
    })
    .length

const angularOrder = (enlarged: ReturnType<typeof getEnlargedDiagram>) =>
  [...enlarged.nodes]
    .sort((a, b) => Math.atan2(a.y - enlarged.cy, a.x - enlarged.cx) - Math.atan2(b.y - enlarged.cy, b.x - enlarged.cx))
    .map(node => node.address)

const permutations = (items: string[]): string[][] =>
  items.length <= 1
    ? [items]
    : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(rest => [item, ...rest]))

const areRingNeighbours = (ring: string[], a: string, b: string) => {
  const distance = Math.abs(ring.indexOf(a) - ring.indexOf(b))
  return distance === 1 || distance === ring.length - 1
}

describe('getRingBlocks', () => {
  it('keeps each collateral next to its liability for isolated pairs', () => {
    const { addresses, links } = isolatedPairs(5)

    const blocks = getRingBlocks(addresses, links)

    expect(blocks).toHaveLength(5)
    for (const { from, to } of links) {
      expect(blocks.find(block => block.includes(from))?.slice().sort()).toEqual([from, to].sort())
    }
  })

  it('places a hub with its collaterals in one run, the hub first', () => {
    const addresses = ['0xc1', '0xl', '0xc2', '0xh', '0xc4', '0xc3']
    const links = [link('0xc1', '0xh'), link('0xc2', '0xh'), link('0xc3', '0xh'), link('0xc4', '0xl')]

    expect(getRingBlocks(addresses, links)).toEqual([
      ['0xh', '0xc1', '0xc2', '0xc3'],
      ['0xl', '0xc4'],
    ])
  })

  it('starts each group at its best-connected vault', () => {
    const addresses = ['0xl1', '0xa', '0xl2', '0xb', '0xl3']
    const links = [link('0xa', '0xl1'), link('0xb', '0xl2'), link('0xa', '0xl3')]

    expect(getRingBlocks(addresses, links)).toEqual([
      ['0xa', '0xl1', '0xl3'],
      ['0xl2', '0xb'],
    ])
  })

  it('puts isolated vaults last, in their existing order', () => {
    const addresses = ['0xiso2', '0xa', '0xiso1', '0xb']

    expect(getRingBlocks(addresses, [link('0xa', '0xb')])).toEqual([
      ['0xa', '0xb'],
      ['0xiso2', '0xiso1'],
    ])
  })

  it('orders equal-size groups by their lowest address, whatever the input order', () => {
    const addresses = ['0xd', '0xc', '0xb', '0xa']
    const links = [link('0xd', '0xb'), link('0xc', '0xa')]

    expect(getRingBlocks(addresses, links).map(block => block.slice().sort())).toEqual([
      ['0xa', '0xc'],
      ['0xb', '0xd'],
    ])
    expect(getRingBlocks([...addresses].reverse(), links).map(block => block.slice().sort())).toEqual([
      ['0xa', '0xc'],
      ['0xb', '0xd'],
    ])
  })

  it('is deterministic and stable when applied to its own output', () => {
    const graphs: Array<{ addresses: string[], links: RingLink[] }> = [
      {
        addresses: ['0xc1', '0xl', '0xc2', '0xiso', '0xh', '0xc4', '0xc3', '0xl2'],
        links: [link('0xc1', '0xh'), link('0xc2', '0xh'), link('0xc3', '0xh'), link('0xc4', '0xl'), link('0xc1', '0xl2')],
      },
      {
        addresses: ['0xb', '0xd', '0xa', '0xc'],
        links: [link('0xa', '0xb'), link('0xb', '0xc'), link('0xc', '0xd'), link('0xd', '0xa'), link('0xb', '0xd')],
      },
      {
        addresses: ['0xc3', '0xh2', '0xc1', '0xh1', '0xc2'],
        links: ['0xc1', '0xc2', '0xc3'].flatMap(c => [link(c, '0xh1'), link(c, '0xh2')]),
      },
      isolatedPairs(5),
    ]

    for (const { addresses, links } of graphs) {
      const blocks = getRingBlocks(addresses, links)

      expect(getRingBlocks(addresses, links)).toEqual(blocks)
      expect(getRingBlocks(blocks.flat(), links)).toEqual(blocks)
    }
  })

  it('ignores self links and links to addresses outside the graph', () => {
    const blocks = getRingBlocks(['0xa', '0xb'], [link('0xa', '0xa'), link('0xa', '0xmissing')])

    expect(blocks).toEqual([['0xa', '0xb']])
  })
})

describe('getRingSlots', () => {
  it('leaves one empty slot after each block when there is more than one', () => {
    const slots = getRingSlots([['0xa', '0xb'], ['0xc', '0xd']], true)

    expect(Object.fromEntries(slots.slotByAddress)).toEqual({ '0xa': 0, '0xb': 1, '0xc': 3, '0xd': 4 })
    expect(slots.slotCount).toBe(6)
  })

  it('adds no gap around a single block', () => {
    const slots = getRingSlots([['0xa', '0xb', '0xc']], true)

    expect(Object.fromEntries(slots.slotByAddress)).toEqual({ '0xa': 0, '0xb': 1, '0xc': 2 })
    expect(slots.slotCount).toBe(3)
  })

  it('packs blocks without gaps when asked to', () => {
    const slots = getRingSlots([['0xa', '0xb'], ['0xc']], false)

    expect(Object.fromEntries(slots.slotByAddress)).toEqual({ '0xa': 0, '0xb': 1, '0xc': 2 })
    expect(slots.slotCount).toBe(3)
  })
})

describe('getEnlargedDiagram ring layout', () => {
  it('draws five isolated pairs listed in market order without crossing edges', () => {
    const { addresses, links } = isolatedPairs(5)

    const enlarged = getEnlargedDiagram(diagramOf(addresses, links))
    const ring = angularOrder(enlarged)

    expect(countCrossings(enlarged.edges)).toBe(0)
    for (const { from, to } of links) {
      expect(areRingNeighbours(ring, from, to)).toBe(true)
    }
  })

  it('leaves a one-slot gap between groups', () => {
    const { addresses, links } = isolatedPairs(5)

    expect(getEnlargedDiagram(diagramOf(addresses, links)).slotCount).toBe(15)
  })

  it('drops the gaps when they would crowd the ring', () => {
    const { addresses, links } = isolatedPairs(12)

    const enlarged = getEnlargedDiagram(diagramOf(addresses, links))

    expect(enlarged.slotCount).toBe(24)
    expect(countCrossings(enlarged.edges)).toBe(0)
  })

  it('keeps a hub and its collaterals together next to a separate pair', () => {
    const addresses = ['0xc1', '0xl', '0xc2', '0xh', '0xc4', '0xc3']
    const links = [link('0xc1', '0xh'), link('0xc2', '0xh'), link('0xc3', '0xh'), link('0xc4', '0xl')]

    const enlarged = getEnlargedDiagram(diagramOf(addresses, links))
    const ring = angularOrder(enlarged)

    expect(countCrossings(enlarged.edges)).toBe(0)
    expect(areRingNeighbours(ring, '0xl', '0xc4')).toBe(true)
    const fromHub = [...ring.slice(ring.indexOf('0xh')), ...ring.slice(0, ring.indexOf('0xh'))]
    expect(new Set(fromHub.slice(0, 4))).toEqual(new Set(['0xh', '0xc1', '0xc2', '0xc3']))
  })

  it('draws four vaults with five links without crossing edges, whatever the input order', () => {
    const links = [link('0xa', '0xb'), link('0xb', '0xc'), link('0xc', '0xd'), link('0xd', '0xa'), link('0xb', '0xd')]

    for (const addresses of permutations(['0xa', '0xb', '0xc', '0xd'])) {
      expect(countCrossings(getEnlargedDiagram(diagramOf(addresses, links)).edges)).toBe(0)
    }
  })

  it('keeps every label outside the ring, anchored away from the centre', () => {
    const { addresses, links } = isolatedPairs(5)

    const enlarged = getEnlargedDiagram(diagramOf(addresses, links))

    for (const node of enlarged.nodes) {
      const label = getLabelPosition(node, enlarged.cx, enlarged.cy)
      const nodeDistance = Math.hypot(node.x - enlarged.cx, node.y - enlarged.cy)
      expect(Math.hypot(label.x - enlarged.cx, label.y - 4 - enlarged.cy)).toBeGreaterThan(nodeDistance)
      if (label.anchor === 'end') expect(node.x).toBeLessThan(enlarged.cx)
      if (label.anchor === 'start') expect(node.x).toBeGreaterThan(enlarged.cx)
    }
  })
})
