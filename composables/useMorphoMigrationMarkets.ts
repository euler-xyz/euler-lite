import { getAddress, type Address } from 'viem'
import type { MaybeRefOrGetter } from 'vue'
import { MORPHO_CONNECTOR_ID, type MorphoMarketParams } from '@eulerxyz/euler-v2-sdk'
import { logWarn } from '~/utils/errorHandling'

export interface MorphoMigrationMarket {
  connectorId: typeof MORPHO_CONNECTOR_ID
  protocol: 'Morpho'
  id: string
  chainId: number
  ref: MorphoMarketParams
  loanAsset: {
    address: Address
    symbol: string
    decimals: number
  }
  collateralAsset: {
    address: Address
    symbol: string
    decimals: number
  }
  borrowApy: number | null
  netBorrowApy: number | null
  supplyApy: number | null
  lltv: number | null
  liquidityAssets: bigint
  liquidityAssetsUsd: number | null
  listed: boolean
}

interface UseMorphoMigrationMarketsInput {
  loanAsset: MaybeRefOrGetter<string | undefined>
  collateralAsset: MaybeRefOrGetter<string | undefined>
  enabled?: MaybeRefOrGetter<boolean>
  minLiquidity?: MaybeRefOrGetter<bigint | null | undefined>
}

interface MorphoApiAsset {
  address?: string
  symbol?: string
  decimals?: number | string
}

interface MorphoApiMarket {
  marketId?: string
  listed?: boolean
  lltv?: string | number
  irmAddress?: string
  oracle?: { address?: string } | null
  loanAsset?: MorphoApiAsset | null
  collateralAsset?: MorphoApiAsset | null
  state?: {
    borrowApy?: string | number | null
    netBorrowApy?: string | number | null
    supplyApy?: string | number | null
    liquidityAssets?: string | number | null
    liquidityAssetsUsd?: string | number | null
  } | null
}

const MORPHO_MARKETS_QUERY = `#graphql
query LiteMorphoMigrationMarkets($chainIds: [Int!], $loanAssets: [String!], $collateralAssets: [String!]) {
  markets(
    first: 100
    where: {
      chainId_in: $chainIds
      loanAssetAddress_in: $loanAssets
      collateralAssetAddress_in: $collateralAssets
      listed: true
    }
  ) {
    items {
      marketId
      listed
      lltv
      irmAddress
      oracle { address }
      loanAsset { address symbol decimals }
      collateralAsset { address symbol decimals }
      state {
        borrowApy
        netBorrowApy
        supplyApy
        liquidityAssets
        liquidityAssetsUsd
      }
    }
  }
}
`

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

const parseAsset = (asset: MorphoApiAsset | null | undefined): MorphoMigrationMarket['loanAsset'] | null => {
  if (!asset?.address || !asset.symbol || asset.decimals === undefined) return null
  const decimals = Number(asset.decimals)
  if (!Number.isInteger(decimals) || decimals < 0) return null
  return {
    address: getAddress(asset.address),
    symbol: asset.symbol,
    decimals,
  }
}

const toMorphoMarket = (chainId: number, row: MorphoApiMarket): MorphoMigrationMarket | null => {
  const loanAsset = parseAsset(row.loanAsset)
  const collateralAsset = parseAsset(row.collateralAsset)
  if (!row.marketId || !loanAsset || !collateralAsset || !row.oracle?.address || !row.irmAddress) return null

  const lltvRaw = parseBigIntAmount(row.lltv)
  const liquidityAssets = parseBigIntAmount(row.state?.liquidityAssets)
  return {
    connectorId: MORPHO_CONNECTOR_ID,
    protocol: 'Morpho',
    id: row.marketId,
    chainId,
    ref: {
      loanToken: loanAsset.address,
      collateralToken: collateralAsset.address,
      oracle: getAddress(row.oracle.address),
      irm: getAddress(row.irmAddress),
      lltv: lltvRaw,
    },
    loanAsset,
    collateralAsset,
    borrowApy: parseNumberOrNull(row.state?.borrowApy),
    netBorrowApy: parseNumberOrNull(row.state?.netBorrowApy),
    supplyApy: parseNumberOrNull(row.state?.supplyApy),
    lltv: lltvRaw > 0n ? Number(lltvRaw) / 1e16 : null,
    liquidityAssets,
    liquidityAssetsUsd: parseNumberOrNull(row.state?.liquidityAssetsUsd),
    listed: row.listed !== false,
  }
}

export const useMorphoMigrationMarkets = (input: UseMorphoMigrationMarketsInput) => {
  const { chainId } = useEulerAddresses()
  const markets = ref<MorphoMigrationMarket[]>([])
  const isLoading = ref(false)
  const error = ref('')

  const normalizedLoanAsset = computed(() => {
    const raw = toValue(input.loanAsset)
    if (!raw) return undefined
    try {
      return getAddress(raw)
    }
    catch {
      return undefined
    }
  })
  const normalizedCollateralAsset = computed(() => {
    const raw = toValue(input.collateralAsset)
    if (!raw) return undefined
    try {
      return getAddress(raw)
    }
    catch {
      return undefined
    }
  })
  const enabled = computed(() => input.enabled === undefined ? true : !!toValue(input.enabled))
  const minLiquidity = computed(() => toValue(input.minLiquidity) ?? 0n)

  const load = async () => {
    if (!enabled.value || !chainId.value || !normalizedLoanAsset.value || !normalizedCollateralAsset.value) {
      markets.value = []
      return
    }

    isLoading.value = true
    error.value = ''
    try {
      const res = await fetch('/api/proxy/morpho', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: MORPHO_MARKETS_QUERY,
          variables: {
            chainIds: [chainId.value],
            loanAssets: [normalizedLoanAsset.value],
            collateralAssets: [normalizedCollateralAsset.value],
          },
        }),
      })
      if (!res.ok) throw new Error(`Morpho API request failed: ${res.status}`)
      const body = await res.json()
      if (body.errors?.length) throw new Error(body.errors[0]?.message || 'Morpho API returned an error')

      const rows = (body.data?.markets?.items ?? []) as MorphoApiMarket[]
      markets.value = rows
        .map((row: MorphoApiMarket) => toMorphoMarket(chainId.value!, row))
        .filter((market: MorphoMigrationMarket | null): market is MorphoMigrationMarket => {
          if (!market) return false
          if (!market.listed) return false
          if (market.liquidityAssets < minLiquidity.value) return false
          return market.lltv !== null && market.lltv > 0
        })
        .sort((a, b) => {
          if (a.liquidityAssets === b.liquidityAssets) return 0
          return a.liquidityAssets > b.liquidityAssets ? -1 : 1
        })
    }
    catch (err) {
      markets.value = []
      error.value = err instanceof Error ? err.message : 'Failed to load Morpho markets'
      logWarn('externalMigration/morphoMarkets', err)
    }
    finally {
      isLoading.value = false
    }
  }

  watch(
    [enabled, chainId, normalizedLoanAsset, normalizedCollateralAsset, minLiquidity],
    () => {
      void load()
    },
    { immediate: true },
  )

  return {
    markets,
    isLoading,
    error,
    load,
  }
}
