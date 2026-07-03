/**
 * Per-chain vault snapshot cache.
 *
 * Single refresh path (`refreshChainVaults`) used by:
 *   - `server/plugins/warm-cache.ts` — every 5 min, force-refreshes each
 *     enabled chain's entry so steady-state reads always hit fresh cache.
 *   - `server/api/vaults.get.ts` — cold-path fallback when the cache is
 *     empty (before the first warm cycle completes). Steady state: the
 *     handler is a pure read.
 *
 * Snapshot semantics:
 *   - Snapshot is a wire-shape payload with bigints replaced by
 *     `{ __bi: "<decimal>" }` tags (see `utils/snapshot-codec.ts`). The
 *     browser hydrates by `new EVault(args)` etc., restoring class methods.
 *   - Cross-references (`collateral.vault`, `strategy.vault`) are NOT
 *     populated server-side. The client's two-pass hydrate restores them
 *     via a registry-backed `IVaultMetaService` stub, preserving object
 *     identity for Vue reactivity.
 *   - Stale ceiling 30 min: if the warm cycle stalls and a refresh fails,
 *     `vaultsCache.getStale` lets the handler serve the last-known good
 *     payload up to that ceiling; past that the cold path retries.
 */
import {
  StandardEVaultPerspectives,
  VaultType,
  type EulerSDK,
  type VaultFetchOptions,
} from '@eulerxyz/euler-v2-sdk'
import { getAddress, type Address } from 'viem'
import { createTtlCache } from './cache'
import { createInFlightDedup } from '~/utils/in-flight'
import { logger } from './logger'
import { reportStatus } from './log'
import { summarizeSdkIssue } from './observability'
import { getServerSdk } from './sdk-server'
import { isSdkErrorDiagnostic } from './sdk-diagnostics'
import {
  LABEL_FILES,
  refreshLabelFile,
  type LabelFile,
} from '~/server/api/labels/[file].get'
import { encodeBigints } from '~/utils/snapshot-codec'
import { readV3ApiUrl } from '~/utils/api-url-env'
import {
  EVAULT_FETCH_CHUNK_DELAY_MS,
  EVAULT_FETCH_CHUNK_SIZE,
  shouldChunkEVaultFetch,
} from '~/utils/eVaultFetchChunkConfig'
import type {
  SerialisedSnapshot,
  SerialisedVault,
  SerialisedVaultKind,
} from '~/utils/snapshot-types'

// With V3 configured the SDK falls back through V3's batched endpoints —
// each refresh is cheap, so we can afford a tighter cache TTL and rewarm
// cadence (see `server/plugins/warm-cache.ts:VAULTS_REWARM_INTERVAL_MS`).
// Without V3, the snapshot is built from onchain lens multicalls which
// are heavier; the 5-min TTL keeps the cost bounded.
const CACHE_TTL_MS = readV3ApiUrl() ? 2 * 60_000 : 5 * 60_000

export const SNAPSHOT_CACHE_TTL_MS = CACHE_TTL_MS

export type { SerialisedSnapshot, SerialisedVault, SerialisedVaultKind }

export const vaultsCache = createTtlCache<SerialisedSnapshot>({
  ttlMs: CACHE_TTL_MS,
  maxEntries: 64,
})

const inFlight = createInFlightDedup<number, SerialisedSnapshot>()

const waitForEVaultFetchChunkSlot = async () => {
  await new Promise(resolve => setTimeout(resolve, EVAULT_FETCH_CHUNK_DELAY_MS))
}

const tryChecksum = (addr: string): Address | undefined => {
  try {
    return getAddress(addr)
  }
  catch {
    return undefined
  }
}

const uniqueAddresses = (addresses: Iterable<string>): Address[] => {
  const result = new Map<string, Address>()
  for (const a of addresses) {
    const checksummed = tryChecksum(a)
    if (checksummed) result.set(checksummed.toLowerCase(), checksummed)
  }
  return [...result.values()]
}

interface LabelProduct { vaults?: string[], deprecatedVaults?: string[] }
interface EarnVaultEntry { address?: string }

const fetchLabel = async <T>(scope: number | 'all', file: LabelFile, fallback: T): Promise<T> => {
  try {
    return (await refreshLabelFile(scope, file)) as T
  }
  catch (err) {
    logger.warn({ ctx: 'vaults-cache', scope, file, err }, 'failed to fetch label')
    return fallback
  }
}

const getLabels = async (chainId: number) => {
  const [products, earn] = await Promise.all([
    fetchLabel<Record<string, LabelProduct>>(chainId, 'products.json', {}),
    fetchLabel<Array<string | EarnVaultEntry>>(chainId, 'earn-vaults.json', []),
  ])
  const verified = new Set<string>()
  for (const product of Object.values(products)) {
    product.vaults?.forEach(addr => verified.add(addr))
    product.deprecatedVaults?.forEach(addr => verified.add(addr))
  }
  const earnVaults: string[] = earn.flatMap((entry) => {
    if (typeof entry === 'string') return [entry]
    return typeof entry?.address === 'string' ? [entry.address] : []
  })
  return {
    verifiedVaultAddresses: uniqueAddresses(verified),
    earnVaults: uniqueAddresses(earnVaults),
  }
}

const partitionVerified = async (
  sdk: EulerSDK,
  chainId: number,
  verifiedAddrs: Address[],
  earnAddrs: Address[],
): Promise<{ evkAddrs: Address[], securitizeAddrs: Address[], earnAddrs: Address[] }> => {
  const candidates = uniqueAddresses([...verifiedAddrs, ...earnAddrs])
  const types = candidates.length
    ? await sdk.vaultMetaService.fetchVaultTypes(chainId, candidates)
    : {}
  const earnSet = new Set(earnAddrs.map(a => a.toLowerCase()))
  const evkAddrs: Address[] = []
  const securitizeAddrs: Address[] = []
  const earnAddrsOut: Address[] = []
  for (const address of candidates) {
    const lower = address.toLowerCase()
    const type = types[address] ?? types[address.toLowerCase() as Address]
    if (type === VaultType.SecuritizeCollateral) securitizeAddrs.push(address)
    else if (type === VaultType.EulerEarn || earnSet.has(lower)) earnAddrsOut.push(address)
    else evkAddrs.push(address)
  }
  return { evkAddrs, securitizeAddrs, earnAddrs: earnAddrsOut }
}

const fetchEscrowAddrs = async (sdk: EulerSDK, chainId: number): Promise<Address[]> => {
  try {
    const list = await sdk.eVaultService.fetchVerifiedVaultAddresses(
      chainId,
      [StandardEVaultPerspectives.ESCROW],
    )
    return uniqueAddresses(list)
  }
  catch (err) {
    logger.warn({ ctx: 'vaults-cache', chainId, err }, 'failed to fetch escrow addresses')
    return []
  }
}

const wrapVault = (kind: SerialisedVaultKind) => (v: unknown): SerialisedVault => ({
  kind,
  data: v,
})

const fetchEVaultsForSnapshot = async (
  sdk: EulerSDK,
  chainId: number,
  addresses: Address[],
  opts: VaultFetchOptions,
): Promise<{ result: unknown[], errors: unknown[] }> => {
  if (!shouldChunkEVaultFetch(chainId) || addresses.length <= EVAULT_FETCH_CHUNK_SIZE) {
    const fetched = await sdk.eVaultService.fetchVaults(chainId, addresses, opts)
    return {
      result: fetched.result as unknown[],
      errors: fetched.errors as unknown[],
    }
  }

  const result: unknown[] = []
  const errors: unknown[] = []
  for (let i = 0; i < addresses.length; i += EVAULT_FETCH_CHUNK_SIZE) {
    const chunk = addresses.slice(i, i + EVAULT_FETCH_CHUNK_SIZE)
    try {
      const fetched = await sdk.eVaultService.fetchVaults(chainId, chunk, opts)
      result.push(...(fetched.result as unknown[]))
      errors.push(...(fetched.errors as unknown[]))
    }
    catch (err) {
      logger.warn({
        ctx: 'vaults-cache',
        chainId,
        chunkIndex: i / EVAULT_FETCH_CHUNK_SIZE,
        chunkSize: chunk.length,
        err,
      }, 'eVault chunk fetch failed')
      throw err
    }

    if (i + EVAULT_FETCH_CHUNK_SIZE < addresses.length) {
      await waitForEVaultFetchChunkSlot()
    }
  }

  return { result, errors }
}

/**
 * Single refresh path. Force-runs by warm-cache; falls back as cold path
 * for the handler when the cache is genuinely empty. Concurrent calls
 * collapse via in-flight dedup so a warm-cycle refresh and a cold-path
 * request arriving together share one upstream pass.
 */
export const refreshChainVaults = (chainId: number): Promise<SerialisedSnapshot> =>
  inFlight.run(chainId, async () => {
    const sdk = await getServerSdk(chainId)
    const labels = await getLabels(chainId)
    const escrowAddrs = await fetchEscrowAddrs(sdk, chainId)
    const { evkAddrs, securitizeAddrs, earnAddrs } = await partitionVerified(
      sdk,
      chainId,
      labels.verifiedVaultAddresses,
      labels.earnVaults,
    )

    // populateCollaterals / populateStrategyVaults DISABLED — deferred to
    // the client's two-pass hydrate so we don't ship duplicated EVault
    // instances inlined per collateral.
    const opts: VaultFetchOptions = {
      populateMarketPrices: true,
      populateRewards: true,
      populateIntrinsicApy: true,
      populateCollaterals: false,
      populateStrategyVaults: false,
    }

    const empty = { result: [] as unknown[], errors: [] as unknown[] }
    const [evk, earn, securitize, escrow] = await Promise.all([
      evkAddrs.length
        ? fetchEVaultsForSnapshot(sdk, chainId, evkAddrs, opts)
        : empty,
      earnAddrs.length
        ? sdk.eulerEarnService.fetchVaults(chainId, earnAddrs, opts)
        : empty,
      securitizeAddrs.length
        ? sdk.securitizeVaultService.fetchVaults(chainId, securitizeAddrs, {
            populateMarketPrices: true,
            populateRewards: true,
            populateIntrinsicApy: true,
          })
        : empty,
      escrowAddrs.length
        ? fetchEVaultsForSnapshot(sdk, chainId, escrowAddrs, opts)
        : empty,
    ])

    for (const { errors, ctx } of [
      { errors: evk.errors, ctx: 'evk' },
      { errors: earn.errors, ctx: 'earn' },
      { errors: securitize.errors, ctx: 'securitize' },
      { errors: escrow.errors, ctx: 'escrow' },
    ] as const) {
      for (const issue of errors as unknown[]) {
        if (isSdkErrorDiagnostic(issue)) {
          logger.error({ ctx: 'vaults-cache', chainId, kind: ctx, issue: summarizeSdkIssue(issue) }, 'sdk fetch issue')
        }
      }
    }

    const payload: SerialisedSnapshot = encodeBigints({
      chainId,
      fetchedAt: Date.now(),
      evkVaults: (evk.result as unknown[]).filter(Boolean).map(wrapVault('evk')),
      earnVaults: (earn.result as unknown[]).filter(Boolean).map(wrapVault('earn')),
      securitizeVaults: (securitize.result as unknown[]).filter(Boolean).map(wrapVault('securitize')),
      escrowVaults: (escrow.result as unknown[]).filter(Boolean).map(wrapVault('escrow')),
    }) as SerialisedSnapshot

    vaultsCache.set(String(chainId), payload)
    reportStatus('vaults-cache', `chain=${chainId}`, 'ok')
    return payload
  })

// silence unused: LABEL_FILES is re-exported by callers via the labels
// endpoint module, importing here keeps the file dependency edge explicit.
void LABEL_FILES
