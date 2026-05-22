import type { EulerSDKQueryName } from '@eulerxyz/euler-v2-sdk'

/**
 * Per-SDK-query cache + invalidation policy. One row per `query*` name; this
 * file is the single source of truth.
 *
 * Three axes per entry:
 *
 *   - `staleTimeMs` (required): the QueryClient stale time used by the
 *     browsing SDK instance (`getEulerSdk()`). Entries younger than this are
 *     served from cache; older ones trigger a re-fetch. Matches TanStack
 *     Query's `staleTime` semantics. Current SDK query names are listed here;
 *     future unlisted names fall through to `DEFAULT_STALE_TIME_MS`.
 *
 *   - `formStaleTimeMs` (optional): override on the plan-time/form SDK
 *     instance (`getEulerSdkFresh()`). When forms construct a transaction
 *     plan they want the latest chain state; setting this to 0 forces the
 *     plan-time SDK to re-fetch regardless of the cache age. Non-listed
 *     queries inherit `staleTimeMs`.
 *
 *   - `invalidateAfterTx` (optional, boolean): evict matching cache entries
 *     at form mount and after every successful transaction. Used by display
 *     surfaces (vault list, portfolio etc.) that read via the browsing SDK
 *     with a long staleTime — without explicit eviction they would serve
 *     pre-tx data for up to `staleTimeMs`.
 *
 * Stale-time classes (organising the rows below):
 *
 *   - **Default / low-volatility reads** (deployments, labels, oracle adapter
 *     lists, verified-vault arrays, reward campaign metadata, V3 list pages):
 *     5 min.
 *   - **Plan-critical chain reads** (vault info, account info, vault
 *     factory/type lookups): 5 min on the browsing SDK + 1 min on the plan-time
 *     SDK + invalidate-after-tx. The bumped 5-min stale lets the Pyth
 *     plugin's `populateCollaterals` and simulate's `fetchVaultTypes` hit
 *     cache on Review-clicks; the post-tx invalidation makes display refresh
 *     after a deposit/borrow.
 *   - **Pricing / APY** (assetPriceInfo, rewards breakdown, intrinsicApy):
 *     1 min. `queryV3Price` uses 30 s.
 *   - **Time-sensitive** (block reads, swap quotes, Pyth update data + fee,
 *     simulate batch): short cache windows. Pyth payloads have a real on-chain
 *     validity window (~60 s); caching longer would make tx revert at
 *     execute.
 *   - **Balances / allowances**: short plan-time windows so external wallet
 *     changes are picked up without explicit invalidation.
 */
export interface SdkQueryPolicyEntry {
  staleTimeMs: number
  formStaleTimeMs?: number
  invalidateAfterTx?: boolean
}

const SECOND = 1_000
const MINUTE = 60 * SECOND

export const DEFAULT_STALE_TIME_MS = 5 * MINUTE

export const SDK_QUERY_POLICY: Partial<Record<EulerSDKQueryName, SdkQueryPolicyEntry>> = {
  // === Catalogue / metadata: nearly static ===
  queryDeployments: { staleTimeMs: 5 * MINUTE },
  queryABI: { staleTimeMs: Infinity },
  queryTokenList: { staleTimeMs: Infinity },
  queryEulerLabelsEntities: { staleTimeMs: 5 * MINUTE },
  queryEulerLabelsProducts: { staleTimeMs: 5 * MINUTE },
  queryEulerLabelsPoints: { staleTimeMs: 5 * MINUTE },
  queryEulerLabelsEarnVaults: { staleTimeMs: 5 * MINUTE },
  queryEulerLabelsAssets: { staleTimeMs: 5 * MINUTE },
  queryOracleAdapters: { staleTimeMs: 5 * MINUTE },
  queryV3VaultResolve: { staleTimeMs: 5 * MINUTE },

  // === Default / low-volatility reads: 5-minute cache ===
  queryAccountVaults: { staleTimeMs: DEFAULT_STALE_TIME_MS, formStaleTimeMs: 0, invalidateAfterTx: true },
  queryBrevisCampaigns: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  queryBrevisUserProofs: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  queryEVaultVerifiedArray: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  queryEulerEarnConvertToAssets: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  queryEulerEarnVerifiedArray: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  queryFuulClaimChecks: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  queryFuulIncentives: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  queryFuulTotals: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  queryKeyringAddress: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  queryKeyringCheckCredential: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  queryKeyringPolicyId: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  queryMerklOpportunities: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  queryMerklUserRewards: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  querySecuritizeVaultGovernorAdmin: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  querySecuritizeVaultSupplyCapResolved: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  querySwapProviders: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  queryV3EVaultList: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  queryV3EulerEarnList: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  queryV3IntrinsicApysPage: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  queryV3RewardsApyPage: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  queryVaultInfoERC4626: { staleTimeMs: DEFAULT_STALE_TIME_MS },

  // === Plan-critical chain reads ===
  queryEVaultInfoFull: { staleTimeMs: 5 * MINUTE, formStaleTimeMs: MINUTE, invalidateAfterTx: true },
  queryEulerEarnVaultInfoFull: { staleTimeMs: 5 * MINUTE, formStaleTimeMs: MINUTE, invalidateAfterTx: true },
  queryV3AccountPositions: { staleTimeMs: DEFAULT_STALE_TIME_MS, invalidateAfterTx: true },
  queryV3EVaultDetail: { staleTimeMs: 5 * MINUTE, invalidateAfterTx: true },
  queryV3EulerEarnDetail: { staleTimeMs: 5 * MINUTE, invalidateAfterTx: true },
  queryEVCAccountInfo: { staleTimeMs: 5 * MINUTE, formStaleTimeMs: MINUTE, invalidateAfterTx: true },
  queryVaultAccountInfo: { staleTimeMs: 5 * MINUTE, formStaleTimeMs: MINUTE, invalidateAfterTx: true },
  queryVaultFactories: { staleTimeMs: 5 * MINUTE, invalidateAfterTx: true },

  // === Pricing / APY: display-side, 1-min cache ===
  queryAssetPriceInfo: { staleTimeMs: MINUTE },
  queryV3RewardsBreakdown: { staleTimeMs: MINUTE },
  queryV3IntrinsicApy: { staleTimeMs: MINUTE },
  queryV3Price: { staleTimeMs: 30 * SECOND },

  // === Time-sensitive (Pyth + simulation): short cache ===
  queryBlock: { staleTimeMs: 5 * SECOND },
  queryBlockNumber: { staleTimeMs: 5 * SECOND },
  querySwapQuotes: { staleTimeMs: 5 * SECOND },
  queryBatchSimulation: { staleTimeMs: 15 * SECOND },
  queryPythUpdateData: { staleTimeMs: 15 * SECOND },
  queryPythUpdateFee: { staleTimeMs: 15 * SECOND },

  // === Balances / allowances: short cache, always-fresh in form context ===
  queryNativeBalance: { staleTimeMs: MINUTE, formStaleTimeMs: 15 * SECOND },
  queryTokenBalances: { staleTimeMs: MINUTE * SECOND, formStaleTimeMs: 15 * SECOND },
  queryBalanceOf: { staleTimeMs: MINUTE, formStaleTimeMs: 15 * SECOND },
  queryAllowance: { staleTimeMs: MINUTE, formStaleTimeMs: 15 * SECOND },
  queryPermit2Allowance: { staleTimeMs: MINUTE, formStaleTimeMs: 15 * SECOND },
}

const policyEntries = (): [EulerSDKQueryName, SdkQueryPolicyEntry][] =>
  Object.entries(SDK_QUERY_POLICY) as [EulerSDKQueryName, SdkQueryPolicyEntry][]

/** Names where `invalidateAfterTx === true` — used by post-tx and form-mount eviction. */
export const INVALIDATE_AFTER_TX: readonly EulerSDKQueryName[]
  = policyEntries()
    .filter(([, p]) => p.invalidateAfterTx === true)
    .map(([name]) => name)

/** staleTime applied by the browsing SDK's QueryClient wrapper. */
export const STALE_TIMES: Partial<Record<EulerSDKQueryName, number>> = Object.fromEntries(
  policyEntries().map(([name, p]) => [name, p.staleTimeMs]),
)

/**
 * staleTime applied by the plan-time/form SDK's QueryClient wrapper. Pre-resolved
 * so callers don't need a two-table lookup: `formStaleTimeMs ?? staleTimeMs`.
 */
export const FORM_STALE_TIMES: Partial<Record<EulerSDKQueryName, number>> = Object.fromEntries(
  policyEntries().map(([name, p]) => [name, p.formStaleTimeMs ?? p.staleTimeMs]),
)
