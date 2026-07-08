import { readonly, ref, type Ref } from 'vue'
import { erc20Abi, getAddress, type Address } from 'viem'
import { getEulerSdk } from '~/composables/useEulerSdk'
import { AAVE_CONNECTOR_ID, METAMORPHO_CONNECTOR_ID, MORPHO_CONNECTOR_ID, MORPHO_MIGRATION_SUPPORTED_CHAIN_IDS } from '~/entities/migration/constants'
import { nanoToValue } from '~/utils/crypto-utils'
import { logWarn } from '~/utils/errorHandling'

export interface ExternalMigrationAsset {
  address: Address
  symbol: string
  decimals: number
}

export type ExternalMigrationAssetAmount = ExternalMigrationAsset & {
  amount: bigint
  amountUsd: number | null
}

interface ExternalMigrationStateKey {
  owner?: Address
  chainId?: number
}

type BaseMigrationCandidate<
  TConnector extends string,
  TProtocol extends string,
  TRef,
  TDebt extends ExternalMigrationAssetAmount | null = ExternalMigrationAssetAmount,
> = {
  connectorId: TConnector
  protocol: TProtocol
  id: string
  chainId: number
  owner: Address
  ref: TRef
  debt: TDebt
  collateral: ExternalMigrationAssetAmount
  borrowApy: number | null
  lltv: number | null
  disabledReason?: string
}

export type MorphoMarketParams = {
  loanToken: Address
  collateralToken: Address
  oracle: Address
  irm: Address
  lltv: bigint
}

export type AavePositionRef = {
  collateralAsset: Address
  debtAsset?: Address
  pool: Address
}

export type MetamorphoVaultVersion = 'v1' | 'v2'

export type MetamorphoPositionRef = {
  vault: Address
  version: MetamorphoVaultVersion
}

export type MorphoMigrationCandidate = BaseMigrationCandidate<typeof MORPHO_CONNECTOR_ID, 'Morpho', MorphoMarketParams>
export type AaveMigrationCandidate = BaseMigrationCandidate<typeof AAVE_CONNECTOR_ID, 'Aave V3', AavePositionRef, ExternalMigrationAssetAmount | null> & {
  raw: {
    variableDebt: bigint
    stableDebt: bigint
  }
}
export type MetamorphoMigrationCandidate = BaseMigrationCandidate<typeof METAMORPHO_CONNECTOR_ID, 'Morpho Vaults', MetamorphoPositionRef, null> & {
  vaultName: string
  shares: bigint
}
export type ExternalMigrationCandidate = MorphoMigrationCandidate | AaveMigrationCandidate | MetamorphoMigrationCandidate

export const EXTERNAL_MIGRATION_DUST_USD = 0.01
export const POST_EXTERNAL_MIGRATION_REFRESH_DELAYS_MS = [0, 5_000, 15_000, 30_000] as const

const externalMigrationRefreshCounter = ref(0)

export const useExternalMigrationRefresh = () => {
  const triggerExternalMigrationRefresh = () => {
    externalMigrationRefreshCounter.value += 1
  }

  const scheduleExternalMigrationRefreshes = () => {
    for (const delay of POST_EXTERNAL_MIGRATION_REFRESH_DELAYS_MS) {
      setTimeout(triggerExternalMigrationRefresh, delay)
    }
  }

  return {
    externalMigrationRefreshCounter: readonly(externalMigrationRefreshCounter),
    triggerExternalMigrationRefresh,
    scheduleExternalMigrationRefreshes,
  }
}

const getMigrationPositionSortValue = (position: ExternalMigrationCandidate): number | null => {
  const collateralUsd = position.collateral.amountUsd
  if (collateralUsd === null) return null
  const debtUsd = position.debt?.amountUsd ?? null
  return debtUsd === null ? collateralUsd : collateralUsd - debtUsd
}

const compareMigrationPositions = (a: ExternalMigrationCandidate, b: ExternalMigrationCandidate) => {
  const aValue = getMigrationPositionSortValue(a)
  const bValue = getMigrationPositionSortValue(b)
  if (aValue !== null && bValue !== null && aValue !== bValue) return bValue - aValue
  if (aValue !== null && bValue === null) return -1
  if (aValue === null && bValue !== null) return 1
  const protocol = a.protocol.localeCompare(b.protocol)
  return protocol || a.id.localeCompare(b.id)
}

const getExternalProtocolAddress = async (
  connectorId: string,
  targetChainId: number,
): Promise<Address | undefined> => {
  try {
    const sdk = await getEulerSdk()
    return sdk.positionMigrationService.getConnectorProtocolAddress(connectorId, targetChainId)
  }
  catch (err) {
    logWarn(`externalMigration/${connectorId}ProtocolAddress`, err)
    return undefined
  }
}

export const isExternalMigrationDustPosition = (position: ExternalMigrationCandidate): boolean => {
  const collateralUsd = position.collateral.amountUsd
  if (collateralUsd === null) return false
  if (!position.debt) return collateralUsd <= EXTERNAL_MIGRATION_DUST_USD

  const debtUsd = position.debt.amountUsd
  if (debtUsd === null) return false
  return collateralUsd <= EXTERNAL_MIGRATION_DUST_USD && debtUsd <= EXTERNAL_MIGRATION_DUST_USD
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

interface MorphoApiVault {
  address?: string
  name?: string | null
  symbol?: string | null
  asset?: MorphoApiAsset | null
}

interface MorphoApiVaultAmounts {
  shares?: string | number | null
  assets?: string | number | null
  assetsUsd?: string | number | null
}

interface MorphoApiVaultPosition {
  vault?: MorphoApiVault | null
  state?: MorphoApiVaultAmounts | null
}

interface MorphoApiVaultV2Position extends MorphoApiVaultAmounts {
  vault?: MorphoApiVault | null
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
    vaultPositions {
      vault {
        address
        name
        symbol
        asset { address symbol decimals }
      }
      state {
        shares
        assets
        assetsUsd
      }
    }
    vaultV2Positions {
      vault {
        address
        name
        symbol
        asset { address symbol decimals }
      }
      shares
      assets
      assetsUsd
    }
  }
}
`

const AAVE_POOL_DISCOVERY_ABI = [
  {
    type: 'function',
    name: 'getUserConfiguration',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [{ name: 'data', type: 'uint256' }],
      },
    ],
  },
  {
    type: 'function',
    name: 'getReservesList',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address[]' }],
  },
  {
    type: 'function',
    name: 'getReserveData',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          {
            name: 'configuration',
            type: 'tuple',
            components: [{ name: 'data', type: 'uint256' }],
          },
          { name: 'liquidityIndex', type: 'uint128' },
          { name: 'currentLiquidityRate', type: 'uint128' },
          { name: 'variableBorrowIndex', type: 'uint128' },
          { name: 'currentVariableBorrowRate', type: 'uint128' },
          { name: 'currentStableBorrowRate', type: 'uint128' },
          { name: 'lastUpdateTimestamp', type: 'uint40' },
          { name: 'id', type: 'uint16' },
          { name: 'aTokenAddress', type: 'address' },
          { name: 'stableDebtTokenAddress', type: 'address' },
          { name: 'variableDebtTokenAddress', type: 'address' },
          { name: 'interestRateStrategyAddress', type: 'address' },
          { name: 'accruedToTreasury', type: 'uint128' },
          { name: 'unbacked', type: 'uint128' },
          { name: 'isolationModeTotalDebt', type: 'uint128' },
        ],
      },
    ],
  },
] as const

const ERC20_METADATA_ABI = [
  ...erc20Abi,
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const

type AaveReserveTokens = {
  aTokenAddress: Address
  stableDebtTokenAddress: Address
  variableDebtTokenAddress: Address
}
type ContractRead = {
  address: Address
  abi: readonly unknown[]
  functionName: string
  args?: readonly unknown[]
}
type ContractReadResult
  = | { status: 'success', result: unknown }
    | { status: 'failure', error: unknown }

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

const parseUsdUnitPrice = (price: unknown): number | null => {
  if (typeof price === 'number') return Number.isFinite(price) ? price : null
  if (!price || typeof price !== 'object' || !('amountOutMid' in price)) return null

  const amountOutMid = (price as { amountOutMid?: unknown }).amountOutMid
  try {
    if (typeof amountOutMid === 'bigint') return nanoToValue(amountOutMid, 18)
    if (typeof amountOutMid === 'string') return nanoToValue(BigInt(amountOutMid), 18)
    if (typeof amountOutMid === 'number' && Number.isFinite(amountOutMid)) return amountOutMid / 1e18
  }
  catch {
    return null
  }
  return null
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

const readContractsAllowFailure = async (
  client: NonNullable<ReturnType<typeof useRpcClient>['client']['value']>,
  contracts: readonly ContractRead[],
  context: string,
): Promise<ContractReadResult[]> => {
  try {
    type MulticallArgs = Parameters<typeof client.multicall>[0]
    return await client.multicall({
      contracts: contracts as MulticallArgs['contracts'],
      allowFailure: true,
    } as MulticallArgs) as ContractReadResult[]
  }
  catch (err) {
    logWarn(context, err)
    return Promise.all(contracts.map(async (contract) => {
      try {
        return {
          status: 'success',
          result: await client.readContract(contract as Parameters<typeof client.readContract>[0]),
        } satisfies ContractReadResult
      }
      catch (readErr) {
        return {
          status: 'failure',
          error: readErr,
        } satisfies ContractReadResult
      }
    }))
  }
}

// Failed reads must reject the whole Aave fetch (mirroring the Morpho fetch)
// rather than decode as "no balance" — otherwise an RPC blip silently makes a
// real position disappear from discovery with zero observability.
const requireReadResult = (result: ContractReadResult | undefined, label: string): unknown => {
  if (result?.status === 'success') return result.result
  const cause = result?.status === 'failure' ? result.error : undefined
  throw new Error(`Aave discovery read failed: ${label}`, cause instanceof Error ? { cause } : undefined)
}

const getAavePositionId = (positionRef: AavePositionRef): string =>
  positionRef.debtAsset
    ? [
        AAVE_CONNECTOR_ID,
        getAddress(positionRef.pool),
        getAddress(positionRef.collateralAsset),
        getAddress(positionRef.debtAsset),
        'variable',
      ].join(':')
    : [
        AAVE_CONNECTOR_ID,
        getAddress(positionRef.pool),
        getAddress(positionRef.collateralAsset),
        'supply',
      ].join(':')

const parseAaveUserConfigurationData = (result: unknown): bigint => {
  if (typeof result === 'bigint') return result
  if (Array.isArray(result)) return parseBigIntAmount(result[0])
  if (result && typeof result === 'object' && 'data' in result) {
    return parseBigIntAmount((result as { data?: unknown }).data)
  }
  return 0n
}

const hasAaveBorrowBit = (data: bigint, reserveIndex: number) =>
  ((data >> BigInt(reserveIndex * 2)) & 1n) === 1n

const hasAaveCollateralBit = (data: bigint, reserveIndex: number) =>
  ((data >> BigInt(reserveIndex * 2 + 1)) & 1n) === 1n

const parseAaveReserveTokens = (result: unknown): AaveReserveTokens | null => {
  const reserve = result as {
    aTokenAddress?: Address
    stableDebtTokenAddress?: Address
    variableDebtTokenAddress?: Address
    [index: number]: unknown
  } | null | undefined
  if (!reserve) return null
  try {
    return {
      aTokenAddress: getAddress((reserve.aTokenAddress ?? reserve[8]) as Address),
      stableDebtTokenAddress: getAddress((reserve.stableDebtTokenAddress ?? reserve[9]) as Address),
      variableDebtTokenAddress: getAddress((reserve.variableDebtTokenAddress ?? reserve[10]) as Address),
    }
  }
  catch {
    return null
  }
}

const parseAaveAsset = (
  address: Address,
  symbolResult: unknown,
  decimalsResult: unknown,
): ExternalMigrationAsset => {
  const symbol = typeof symbolResult === 'string' && symbolResult ? symbolResult : `${address.slice(0, 6)}...${address.slice(-4)}`
  const decimals = typeof decimalsResult === 'number'
    ? decimalsResult
    : typeof decimalsResult === 'bigint'
      ? Number(decimalsResult)
      : 18
  return {
    address,
    symbol,
    decimals: Number.isInteger(decimals) && decimals >= 0 ? decimals : 18,
  }
}

const fetchAaveAssetUsdPrices = async (
  targetChainId: number,
  assets: readonly Address[],
): Promise<Map<string, number | null>> => {
  const uniqueAssets = [...new Set(assets.map(asset => asset.toLowerCase()))].map(asset => getAddress(asset))
  const prices = new Map<string, number | null>()
  if (!uniqueAssets.length) return prices

  let sdk: Awaited<ReturnType<typeof getEulerSdk>>
  try {
    sdk = await getEulerSdk()
  }
  catch (err) {
    logWarn('externalMigration/aavePriceService', err)
    uniqueAssets.forEach(asset => prices.set(asset.toLowerCase(), null))
    return prices
  }

  await Promise.all(uniqueAssets.map(async (asset) => {
    try {
      const price = await sdk.priceService.fetchAssetUsdPriceByAddress(targetChainId, asset)
      prices.set(asset.toLowerCase(), parseUsdUnitPrice(price))
    }
    catch (err) {
      logWarn('externalMigration/aavePrice', err)
      prices.set(asset.toLowerCase(), null)
    }
  }))
  return prices
}

const getAaveAmountUsd = (
  amount: bigint,
  asset: ExternalMigrationAsset,
  usdPricesByAsset: Map<string, number | null>,
): number | null => {
  const unitPrice = usdPricesByAsset.get(asset.address.toLowerCase())
  if (unitPrice === undefined || unitPrice === null) return null
  return nanoToValue(amount, asset.decimals) * unitPrice
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

const getMetamorphoPositionId = (vault: Address): string =>
  [METAMORPHO_CONNECTOR_ID, getAddress(vault), 'supply'].join(':')

const toMetamorphoCandidate = (
  chainId: number,
  owner: Address,
  vault: MorphoApiVault | null | undefined,
  amounts: MorphoApiVaultAmounts | null | undefined,
  version: MetamorphoVaultVersion,
): MetamorphoMigrationCandidate | null => {
  const underlying = parseAsset(vault?.asset)
  if (!vault?.address || !underlying) return null

  const assets = parseBigIntAmount(amounts?.assets)
  const shares = parseBigIntAmount(amounts?.shares)
  if (assets <= 0n || shares <= 0n) return null

  const vaultAddress = getAddress(vault.address)
  const vaultName = (typeof vault.name === 'string' && vault.name)
    || (typeof vault.symbol === 'string' && vault.symbol)
    || `${underlying.symbol} vault`
  return {
    connectorId: METAMORPHO_CONNECTOR_ID,
    protocol: 'Morpho Vaults',
    id: getMetamorphoPositionId(vaultAddress),
    chainId,
    owner,
    ref: {
      vault: vaultAddress,
      version,
    },
    debt: null,
    collateral: {
      ...underlying,
      amount: assets,
      amountUsd: parseNumberOrNull(amounts?.assetsUsd),
    },
    borrowApy: null,
    lltv: null,
    vaultName,
    shares,
  }
}

export const useExternalMigrationPositions = (options: {
  enabled?: Readonly<Ref<boolean>>
} = {}) => {
  const { address } = useWagmi()
  const { isSpyMode, spyAddress } = useSpyMode()
  const { chainId } = useEulerAddresses()
  const { client: rpcClient } = useRpcClient()

  const positions = useState<ExternalMigrationCandidate[]>('external-migration:positions', () => [])
  const isLoading = useState('external-migration:is-loading', () => false)
  const error = useState('external-migration:error', () => '')
  const hasLoaded = useState('external-migration:has-loaded', () => false)
  const lastLoadedAt = useState<number | null>('external-migration:last-loaded-at', () => null)
  const loadedFor = useState<ExternalMigrationStateKey>('external-migration:loaded-for', () => ({}))
  const { externalMigrationRefreshCounter } = useExternalMigrationRefresh()

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

  const fetchAaveMigrationPositions = async (targetChainId: number, targetOwner: Address): Promise<AaveMigrationCandidate[]> => {
    const client = rpcClient.value
    const pool = await getExternalProtocolAddress(AAVE_CONNECTOR_ID, targetChainId)
    if (!client || !pool) return []

    const [configurationResult, reservesResult] = await readContractsAllowFailure(client, [
      {
        address: pool,
        abi: AAVE_POOL_DISCOVERY_ABI,
        functionName: 'getUserConfiguration',
        args: [targetOwner],
      },
      {
        address: pool,
        abi: AAVE_POOL_DISCOVERY_ABI,
        functionName: 'getReservesList',
      },
    ], 'externalMigration/aaveDiscoveryRootMulticall')

    const userConfiguration = parseAaveUserConfigurationData(requireReadResult(configurationResult, 'getUserConfiguration'))
    const reservesRaw = requireReadResult(reservesResult, 'getReservesList')
    const reserves = Array.isArray(reservesRaw)
      ? reservesRaw.flatMap((asset) => {
          try {
            return [getAddress(asset as Address)]
          }
          catch {
            return []
          }
        })
      : []
    if (userConfiguration === 0n || reserves.length === 0) return []

    const collateralAssets = reserves.filter((_, index) => hasAaveCollateralBit(userConfiguration, index))
    const debtAssets = reserves.filter((_, index) => hasAaveBorrowBit(userConfiguration, index))
    if (!collateralAssets.length) return []

    const activeAssets = [...new Set([...collateralAssets, ...debtAssets].map(asset => asset.toLowerCase()))]
      .map(asset => getAddress(asset))

    const reserveDataResults = await readContractsAllowFailure(
      client,
      activeAssets.map(asset => ({
        address: pool,
        abi: AAVE_POOL_DISCOVERY_ABI,
        functionName: 'getReserveData',
        args: [asset],
      })),
      'externalMigration/aaveReserveMulticall',
    )
    const reserveTokensByAsset = new Map<Address, AaveReserveTokens>()
    activeAssets.forEach((asset, index) => {
      const tokens = parseAaveReserveTokens(requireReadResult(reserveDataResults[index], `getReserveData(${asset})`))
      if (tokens) reserveTokensByAsset.set(asset, tokens)
    })

    const metadataResults = await readContractsAllowFailure(
      client,
      activeAssets.flatMap(asset => [
        {
          address: asset,
          abi: ERC20_METADATA_ABI,
          functionName: 'symbol',
        },
        {
          address: asset,
          abi: ERC20_METADATA_ABI,
          functionName: 'decimals',
        },
      ]),
      'externalMigration/aaveMetadataMulticall',
    )
    const assetsByAddress = new Map<Address, ExternalMigrationAsset>()
    activeAssets.forEach((asset, index) => {
      assetsByAddress.set(asset, parseAaveAsset(
        asset,
        requireReadResult(metadataResults[index * 2], `symbol(${asset})`),
        requireReadResult(metadataResults[index * 2 + 1], `decimals(${asset})`),
      ))
    })

    const balanceReadEntries: { kind: 'collateral' | 'variableDebt' | 'stableDebt', asset: Address }[] = [
      ...collateralAssets.map(asset => ({ kind: 'collateral' as const, asset })),
      ...debtAssets.flatMap(asset => [
        { kind: 'variableDebt' as const, asset },
        { kind: 'stableDebt' as const, asset },
      ]),
    ]
    const balanceResults = await readContractsAllowFailure(
      client,
      balanceReadEntries.flatMap((entry) => {
        const tokens = reserveTokensByAsset.get(entry.asset)
        if (!tokens) return []
        const address = entry.kind === 'collateral'
          ? tokens.aTokenAddress
          : entry.kind === 'variableDebt'
            ? tokens.variableDebtTokenAddress
            : tokens.stableDebtTokenAddress
        return [{
          address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [targetOwner],
        }]
      }),
      'externalMigration/aaveBalancesMulticall',
    )

    let resultIndex = 0
    const collateralAmounts = new Map<Address, bigint>()
    const debtAmounts = new Map<Address, { variableDebt: bigint, stableDebt: bigint }>()
    for (const entry of balanceReadEntries) {
      if (!reserveTokensByAsset.has(entry.asset)) continue
      const amount = parseBigIntAmount(requireReadResult(balanceResults[resultIndex], `balanceOf(${entry.kind}:${entry.asset})`))
      resultIndex += 1
      if (entry.kind === 'collateral') {
        collateralAmounts.set(entry.asset, amount)
        continue
      }
      const debt = debtAmounts.get(entry.asset) ?? { variableDebt: 0n, stableDebt: 0n }
      if (entry.kind === 'variableDebt') debt.variableDebt = amount
      else debt.stableDebt = amount
      debtAmounts.set(entry.asset, debt)
    }

    const usdPricesByAsset = await fetchAaveAssetUsdPrices(targetChainId, activeAssets)

    const candidates: AaveMigrationCandidate[] = []
    for (const collateralAsset of collateralAssets) {
      const collateralAmount = collateralAmounts.get(collateralAsset) ?? 0n
      const collateral = assetsByAddress.get(collateralAsset)
      if (collateralAmount <= 0n || !collateral) continue

      if (!debtAssets.length) {
        const ref: AavePositionRef = {
          collateralAsset,
          pool,
        }
        candidates.push({
          connectorId: AAVE_CONNECTOR_ID,
          protocol: 'Aave V3',
          id: getAavePositionId(ref),
          chainId: targetChainId,
          owner: targetOwner,
          ref,
          debt: null,
          collateral: {
            ...collateral,
            amount: collateralAmount,
            amountUsd: getAaveAmountUsd(collateralAmount, collateral, usdPricesByAsset),
          },
          borrowApy: null,
          lltv: null,
          raw: {
            variableDebt: 0n,
            stableDebt: 0n,
          },
        })
        continue
      }

      for (const debtAsset of debtAssets) {
        const debt = debtAmounts.get(debtAsset) ?? { variableDebt: 0n, stableDebt: 0n }
        const debtAmount = debt.variableDebt + debt.stableDebt
        const debtMeta = assetsByAddress.get(debtAsset)
        if (debtAmount <= 0n || !debtMeta) continue

        const ref: AavePositionRef = {
          collateralAsset,
          debtAsset,
          pool,
        }
        candidates.push({
          connectorId: AAVE_CONNECTOR_ID,
          protocol: 'Aave V3',
          id: getAavePositionId(ref),
          chainId: targetChainId,
          owner: targetOwner,
          ref,
          debt: {
            ...debtMeta,
            amount: debtAmount,
            amountUsd: getAaveAmountUsd(debtAmount, debtMeta, usdPricesByAsset),
          },
          collateral: {
            ...collateral,
            amount: collateralAmount,
            amountUsd: getAaveAmountUsd(collateralAmount, collateral, usdPricesByAsset),
          },
          borrowApy: null,
          lltv: null,
          raw: debt,
          ...(debt.stableDebt > 0n ? { disabledReason: 'Aave stable debt migration is not supported yet.' } : {}),
        })
      }
    }

    return candidates
  }

  const fetchMorphoMigrationPositions = async (targetChainId: number, targetOwner: Address): Promise<(MorphoMigrationCandidate | MetamorphoMigrationCandidate)[]> => {
    // Morpho's indexer only covers a fixed set of chains. Querying an unindexed
    // chain (e.g. BSC) returns an "unsupported chainId" error that would surface
    // as a scan failure, so treat those chains as "nothing to migrate" instead.
    if (!MORPHO_MIGRATION_SUPPORTED_CHAIN_IDS.has(targetChainId)) return []
    try {
      const res = await fetch('/api/internal/proxy/morpho', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: MORPHO_USER_POSITIONS_QUERY,
          variables: { chainId: targetChainId, address: targetOwner },
        }),
      })
      if (!res.ok) throw new Error(`Morpho API request failed: ${res.status}`)
      const body = await res.json()
      if (body.errors?.length) throw new Error(body.errors[0]?.message || 'Morpho API returned an error')
      const user = body.data?.userByAddress
      const marketRows = (user?.marketPositions ?? []) as MorphoApiMarketPosition[]
      const vaultRows = (user?.vaultPositions ?? []) as MorphoApiVaultPosition[]
      const vaultV2Rows = (user?.vaultV2Positions ?? []) as MorphoApiVaultV2Position[]
      return [
        ...marketRows.map((row: MorphoApiMarketPosition) => toMorphoCandidate(targetChainId, targetOwner, row)),
        ...vaultRows.map((row: MorphoApiVaultPosition) => toMetamorphoCandidate(targetChainId, targetOwner, row.vault, row.state, 'v1')),
        ...vaultV2Rows.map((row: MorphoApiVaultV2Position) => toMetamorphoCandidate(targetChainId, targetOwner, row.vault, row, 'v2')),
      ].filter((row): row is MorphoMigrationCandidate | MetamorphoMigrationCandidate => !!row)
    }
    catch (err) {
      logWarn('externalMigration/morphoIndexedPositions', err)
      throw err
    }
  }

  const resetForMissingOwner = () => {
    positions.value = []
    error.value = ''
    hasLoaded.value = false
    lastLoadedAt.value = null
    loadedFor.value = {}
    isLoading.value = false
  }

  const load = async (loadOptions: { force?: boolean } = {}) => {
    if (options.enabled && !options.enabled.value) {
      return
    }
    if (!owner.value || !chainId.value) {
      resetForMissingOwner()
      return
    }

    const targetOwner = owner.value
    const targetChainId = chainId.value
    const loadedKeyMatches = loadedFor.value.owner === targetOwner && loadedFor.value.chainId === targetChainId
    if (!loadOptions.force && loadedKeyMatches && (hasLoaded.value || isLoading.value)) {
      return
    }

    if (!loadedKeyMatches) {
      positions.value = []
      error.value = ''
      hasLoaded.value = false
      lastLoadedAt.value = null
      loadedFor.value = { owner: targetOwner, chainId: targetChainId }
    }

    isLoading.value = true
    error.value = ''
    try {
      const [morphoResult, aaveResult] = await Promise.allSettled([
        fetchMorphoMigrationPositions(targetChainId, targetOwner),
        fetchAaveMigrationPositions(targetChainId, targetOwner),
      ])
      const nextPositions = [
        ...(aaveResult.status === 'fulfilled' ? aaveResult.value : []),
        ...(morphoResult.status === 'fulfilled' ? morphoResult.value : []),
      ].sort(compareMigrationPositions)
      const firstError = morphoResult.status === 'rejected'
        ? morphoResult.reason
        : aaveResult.status === 'rejected'
          ? aaveResult.reason
          : undefined
      if (morphoResult.status === 'rejected') logWarn('externalMigration/morphoPositions', morphoResult.reason)
      if (aaveResult.status === 'rejected') logWarn('externalMigration/aavePositions', aaveResult.reason)
      if (firstError && nextPositions.length === 0) {
        throw firstError
      }
      if (loadedFor.value.owner !== targetOwner || loadedFor.value.chainId !== targetChainId) return
      positions.value = nextPositions
      hasLoaded.value = true
      lastLoadedAt.value = Date.now()
    }
    catch (err) {
      if (loadedFor.value.owner !== targetOwner || loadedFor.value.chainId !== targetChainId) return
      positions.value = []
      error.value = err instanceof Error ? err.message : 'Failed to load external positions'
      hasLoaded.value = true
      lastLoadedAt.value = Date.now()
      logWarn('externalMigration/positions', err)
    }
    finally {
      if (loadedFor.value.owner === targetOwner && loadedFor.value.chainId === targetChainId) {
        isLoading.value = false
      }
    }
  }

  watch([owner, chainId, computed(() => options.enabled?.value ?? true)], () => {
    void load()
  }, { immediate: true })
  watch(externalMigrationRefreshCounter, () => {
    void load({ force: true })
  })

  return {
    owner,
    positions,
    isLoading,
    error,
    hasLoaded,
    lastLoadedAt,
    load,
  }
}
