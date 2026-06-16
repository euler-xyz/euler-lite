import type { Ref } from 'vue'
import { getAddress, type Address } from 'viem'
import { getMorphoMarketId, type MorphoMarketParams } from '@eulerxyz/euler-v2-sdk'
import { MORPHO_BLUE_ADDRESSES, MORPHO_CONNECTOR_ID, MORPHO_POSITION_FALLBACK_MARKET_IDS } from '~/entities/migration/protocols'
import { logWarn } from '~/utils/errorHandling'

export interface ExternalMigrationAsset {
  address: Address
  symbol: string
  decimals: number
}

export interface MorphoMigrationCandidate {
  connectorId: typeof MORPHO_CONNECTOR_ID
  protocol: 'Morpho'
  id: string
  chainId: number
  owner: Address
  ref: MorphoMarketParams
  debt: ExternalMigrationAsset & {
    amount: bigint
    amountUsd: number | null
  }
  collateral: ExternalMigrationAsset & {
    amount: bigint
    amountUsd: number | null
  }
  borrowApy: number | null
  lltv: number | null
}

interface MorphoApiAsset {
  address?: string
  symbol?: string
  decimals?: number | string
}

interface MorphoApiMarketPosition {
  market?: {
    marketId?: string
    lltv?: string | number
    irmAddress?: string
    oracle?: { address?: string } | null
    loanAsset?: MorphoApiAsset | null
    collateralAsset?: MorphoApiAsset | null
    state?: {
      borrowApy?: string | number | null
    } | null
  } | null
  state?: {
    collateral?: string | number | null
    collateralUsd?: string | number | null
    borrowAssets?: string | number | null
    borrowAssetsUsd?: string | number | null
  } | null
}

const MORPHO_USER_POSITIONS_QUERY = `#graphql
query LiteMorphoMigrationPositions($chainId: Int!, $address: String!) {
  userByAddress(chainId: $chainId, address: $address) {
    address
    marketPositions {
      market {
        marketId
        lltv
        irmAddress
        oracle { address }
        loanAsset { address symbol decimals }
        collateralAsset { address symbol decimals }
        state { borrowApy }
      }
      state {
        collateral
        collateralUsd
        borrowAssets
        borrowAssetsUsd
      }
    }
  }
}
`

const MORPHO_LISTED_MARKETS_QUERY = `#graphql
query LiteMorphoMigrationFallbackMarkets($chainIds: [Int!], $fallbackMarketIds: [String!]) {
  markets(first: 100, where: { chainId_in: $chainIds, listed: true, borrowAssets_gte: "1" }) {
    items {
      marketId
      lltv
      irmAddress
      oracle { address }
      loanAsset { address symbol decimals }
      collateralAsset { address symbol decimals }
      state { borrowApy }
    }
  }
  fallbackMarkets: markets(first: 20, where: { chainId_in: $chainIds, uniqueKey_in: $fallbackMarketIds }) {
    items {
      marketId
      lltv
      irmAddress
      oracle { address }
      loanAsset { address symbol decimals }
      collateralAsset { address symbol decimals }
      state { borrowApy }
    }
  }
}
`

const MORPHO_POSITION_ABI = [
  {
    type: 'function',
    name: 'position',
    stateMutability: 'view',
    inputs: [
      { name: 'id', type: 'bytes32' },
      { name: 'user', type: 'address' },
    ],
    outputs: [
      { name: 'supplyShares', type: 'uint256' },
      { name: 'borrowShares', type: 'uint128' },
      { name: 'collateral', type: 'uint128' },
    ],
  },
  {
    type: 'function',
    name: 'market',
    stateMutability: 'view',
    inputs: [
      { name: 'id', type: 'bytes32' },
    ],
    outputs: [
      { name: 'totalSupplyAssets', type: 'uint128' },
      { name: 'totalSupplyShares', type: 'uint128' },
      { name: 'totalBorrowAssets', type: 'uint128' },
      { name: 'totalBorrowShares', type: 'uint128' },
      { name: 'lastUpdate', type: 'uint128' },
      { name: 'fee', type: 'uint128' },
    ],
  },
] as const

type MorphoPositionTuple = readonly [bigint, bigint, bigint]
type MorphoMarketTuple = readonly [bigint, bigint, bigint, bigint, bigint, bigint]
type MorphoMarketRefEntry = {
  market: NonNullable<MorphoApiMarketPosition['market']>
  ref: MorphoMarketParams
  marketId: `0x${string}`
}

const parseBigIntAmount = (value: unknown): bigint => {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value !== 'string') return 0n
  const trimmed = value.trim()
  if (!trimmed) return 0n
  try {
    return BigInt(trimmed)
  }
  catch {
    return 0n
  }
}

const parseNumberOrNull = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const parseAsset = (asset: MorphoApiAsset | null | undefined): ExternalMigrationAsset | null => {
  if (!asset?.address || !asset.symbol || asset.decimals === undefined) return null
  const decimals = Number(asset.decimals)
  if (!Number.isInteger(decimals) || decimals < 0) return null
  return {
    address: getAddress(asset.address),
    symbol: asset.symbol,
    decimals,
  }
}

const toAssetsUp = (shares: bigint, totalAssets: bigint, totalShares: bigint): bigint => {
  if (shares === 0n || totalAssets === 0n || totalShares === 0n) return 0n
  return (shares * totalAssets + totalShares - 1n) / totalShares
}

const marketToRef = (market: MorphoApiMarketPosition['market']): MorphoMarketParams | null => {
  const loanAsset = parseAsset(market?.loanAsset)
  const collateralAsset = parseAsset(market?.collateralAsset)
  if (!loanAsset || !collateralAsset || !market?.oracle?.address || !market.irmAddress) return null
  return {
    loanToken: loanAsset.address,
    collateralToken: collateralAsset.address,
    oracle: getAddress(market.oracle.address),
    irm: getAddress(market.irmAddress),
    lltv: parseBigIntAmount(market.lltv),
  }
}

const toMorphoCandidate = (
  chainId: number,
  owner: Address,
  row: MorphoApiMarketPosition,
): MorphoMigrationCandidate | null => {
  const market = row.market
  const state = row.state
  const loanAsset = parseAsset(market?.loanAsset)
  const collateralAsset = parseAsset(market?.collateralAsset)
  if (!market?.marketId || !loanAsset || !collateralAsset || !market.oracle?.address || !market.irmAddress) return null

  const debtAmount = parseBigIntAmount(state?.borrowAssets)
  const collateralAmount = parseBigIntAmount(state?.collateral)
  if (debtAmount <= 0n || collateralAmount <= 0n) return null

  const lltvRaw = parseBigIntAmount(market.lltv)
  return {
    connectorId: MORPHO_CONNECTOR_ID,
    protocol: 'Morpho',
    id: market.marketId,
    chainId,
    owner,
    ref: {
      loanToken: loanAsset.address,
      collateralToken: collateralAsset.address,
      oracle: getAddress(market.oracle.address),
      irm: getAddress(market.irmAddress),
      lltv: lltvRaw,
    },
    debt: {
      ...loanAsset,
      amount: debtAmount,
      amountUsd: parseNumberOrNull(state?.borrowAssetsUsd),
    },
    collateral: {
      ...collateralAsset,
      amount: collateralAmount,
      amountUsd: parseNumberOrNull(state?.collateralUsd),
    },
    borrowApy: parseNumberOrNull(market.state?.borrowApy),
    lltv: lltvRaw > 0n ? Number(lltvRaw) / 1e16 : null,
  }
}

export const useExternalMigrationPositions = (options: {
  enabled?: Readonly<Ref<boolean>>
} = {}) => {
  const { address } = useWagmi()
  const { isSpyMode, spyAddress } = useSpyMode()
  const { chainId } = useEulerAddresses()
  const { client: rpcClient } = useRpcClient()

  const positions = ref<MorphoMigrationCandidate[]>([])
  const isLoading = ref(false)
  const error = ref('')

  const owner = computed<Address | undefined>(() => {
    const raw = isSpyMode.value ? spyAddress.value : address.value
    if (!raw) return undefined
    try {
      return getAddress(raw)
    }
    catch {
      return undefined
    }
  })

  const fetchOnchainFallbackPositions = async (targetChainId: number, targetOwner: Address): Promise<MorphoMigrationCandidate[]> => {
    const client = rpcClient.value
    const morpho = MORPHO_BLUE_ADDRESSES[targetChainId]
    if (!client || !morpho) return []

    const res = await fetch('/api/proxy/morpho', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: MORPHO_LISTED_MARKETS_QUERY,
        variables: {
          chainIds: [targetChainId],
          fallbackMarketIds: MORPHO_POSITION_FALLBACK_MARKET_IDS[targetChainId] ?? [],
        },
      }),
    })
    if (!res.ok) throw new Error(`Morpho markets request failed: ${res.status}`)
    const body = await res.json()
    if (body.errors?.length) throw new Error(body.errors[0]?.message || 'Morpho markets returned an error')

    const marketsById = new Map<string, NonNullable<MorphoApiMarketPosition['market']>>()
    ;([
      ...(body.data?.markets?.items ?? []),
      ...(body.data?.fallbackMarkets?.items ?? []),
    ] as NonNullable<MorphoApiMarketPosition['market']>[]).forEach((market) => {
      if (market.marketId) marketsById.set(market.marketId, market)
    })
    const markets = [...marketsById.values()]
    const refs = markets
      .map((market) => {
        const ref = marketToRef(market)
        return ref ? { market, ref, marketId: getMorphoMarketId(ref) } : null
      })
      .filter((entry): entry is MorphoMarketRefEntry => !!entry)

    if (!refs.length) return []

    const readSnapshots = async (): Promise<({ position: MorphoPositionTuple, market: MorphoMarketTuple } | null)[]> => {
      const contracts = refs.flatMap(entry => [
        {
          address: morpho,
          abi: MORPHO_POSITION_ABI,
          functionName: 'position',
          args: [entry.marketId, targetOwner],
        },
        {
          address: morpho,
          abi: MORPHO_POSITION_ABI,
          functionName: 'market',
          args: [entry.marketId],
        },
      ] as const)

      try {
        const results = await client.multicall({
          contracts,
          allowFailure: true,
        })

        return refs.map((_, index) => {
          const positionResult = results[index * 2]
          const marketResult = results[index * 2 + 1]
          if (positionResult?.status !== 'success' || marketResult?.status !== 'success') return null
          return {
            position: positionResult.result as MorphoPositionTuple,
            market: marketResult.result as MorphoMarketTuple,
          }
        })
      }
      catch (err) {
        // Local same-origin RPC clients do not always carry viem chain metadata,
        // so multicall can be unavailable even though direct reads work.
        logWarn('externalMigration/morphoFallbackMulticall', err)
        return Promise.all(refs.map(async (entry) => {
          try {
            const [position, market] = await Promise.all([
              client.readContract({
                address: morpho,
                abi: MORPHO_POSITION_ABI,
                functionName: 'position',
                args: [entry.marketId, targetOwner],
              }),
              client.readContract({
                address: morpho,
                abi: MORPHO_POSITION_ABI,
                functionName: 'market',
                args: [entry.marketId],
              }),
            ])
            return {
              position: position as MorphoPositionTuple,
              market: market as MorphoMarketTuple,
            }
          }
          catch (readErr) {
            logWarn('externalMigration/morphoFallbackRead', readErr)
            return null
          }
        }))
      }
    }

    const snapshots = await readSnapshots()

    const candidates: MorphoMigrationCandidate[] = []
    refs.forEach((entry, index) => {
      const snapshot = snapshots[index]
      if (!snapshot) return

      const { position, market } = snapshot
      const debtAmount = toAssetsUp(position[1], market[2], market[3])
      const collateralAmount = position[2]
      if (debtAmount <= 0n || collateralAmount <= 0n) return

      const loanAsset = parseAsset(entry.market.loanAsset)
      const collateralAsset = parseAsset(entry.market.collateralAsset)
      if (!loanAsset || !collateralAsset) return

      candidates.push({
        connectorId: MORPHO_CONNECTOR_ID,
        protocol: 'Morpho',
        id: entry.marketId,
        chainId: targetChainId,
        owner: targetOwner,
        ref: entry.ref,
        debt: {
          ...loanAsset,
          amount: debtAmount,
          amountUsd: null,
        },
        collateral: {
          ...collateralAsset,
          amount: collateralAmount,
          amountUsd: null,
        },
        borrowApy: parseNumberOrNull(entry.market.state?.borrowApy),
        lltv: entry.ref.lltv > 0n ? Number(entry.ref.lltv) / 1e16 : null,
      })
    })

    return candidates
  }

  const load = async () => {
    if (options.enabled && !options.enabled.value) {
      positions.value = []
      error.value = ''
      isLoading.value = false
      return
    }
    if (!owner.value || !chainId.value) {
      positions.value = []
      return
    }

    isLoading.value = true
    error.value = ''
    try {
      const res = await fetch('/api/proxy/morpho', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: MORPHO_USER_POSITIONS_QUERY,
          variables: { chainId: chainId.value, address: owner.value },
        }),
      })
      if (!res.ok) throw new Error(`Morpho API request failed: ${res.status}`)
      const body = await res.json()
      if (body.errors?.length) throw new Error(body.errors[0]?.message || 'Morpho API returned an error')
      const rows = (body.data?.userByAddress?.marketPositions ?? []) as MorphoApiMarketPosition[]
      const indexedPositions = rows
        .map((row: MorphoApiMarketPosition) => toMorphoCandidate(chainId.value, owner.value!, row))
        .filter((row: MorphoMigrationCandidate | null): row is MorphoMigrationCandidate => !!row)
      const byId = new Map<string, MorphoMigrationCandidate>(indexedPositions.map(position => [position.id, position]))
      const fallbackPositions = await fetchOnchainFallbackPositions(chainId.value, owner.value)
      fallbackPositions.forEach((position) => {
        if (!byId.has(position.id)) byId.set(position.id, position)
      })
      positions.value = [...byId.values()]
    }
    catch (err) {
      positions.value = []
      error.value = err instanceof Error ? err.message : 'Failed to load Morpho positions'
      logWarn('externalMigration/morphoPositions', err)
    }
    finally {
      isLoading.value = false
    }
  }

  watch([owner, chainId, computed(() => options.enabled?.value ?? true)], () => {
    void load()
  }, { immediate: true })

  return {
    owner,
    positions,
    isLoading,
    error,
    load,
  }
}
