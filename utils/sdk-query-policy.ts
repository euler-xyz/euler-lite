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
 *     Query's `staleTime` semantics. Every query name the SDK routes through
 *     `buildQuery` must have an explicit row — the completeness test in
 *     `tests/utils/sdk-query-policy.test.ts` builds the SDK with a recording
 *     `buildQuery` and fails on unclassified names, so a new SDK query cannot
 *     silently inherit `DEFAULT_STALE_TIME_MS`.
 *
 *   - `formStaleTimeMs` (optional): override on the plan-time/form SDK
 *     instance (`getEulerSdkFresh()`). Forms want recent chain state, so
 *     plan-critical rows carry a shorter window here than they do for
 *     browsing — currently 1 min or 15 s. It is still a stale time, not a
 *     forced refetch: only `0` would bypass the plan-time cache on every
 *     call, and no row uses that today. Non-listed queries inherit
 *     `staleTimeMs`.
 *
 *   - `invalidateAfterTx` (optional, boolean): mark matching cache entries
 *     stale after plan finalization (`finalizeExecution`), the post-tx
 *     subgraph sync, and the CoW permit hard-cancellation that writes the
 *     EVC nonce — not CoW settlement, and not standalone migration
 *     authorization grants/revokes sent through `sendPlainTransactions()`.
 *     Those grant/revoke receipts confirm without `invalidateSdkQueries`, so
 *     rows such as `queryGetAuthorization` stay reusable inside their 15 s
 *     form window until a later `finalizeExecution`. `invalidateSdkQueries`
 *     calls TanStack's `invalidateQueries`, so data entries are flagged stale
 *     and active observers refetch — they are not removed from the query cache
 *     (the short-lived failure cache is a separate map and is cleared). SDK
 *     queries run through `fetchQuery` and have no standing observers, so a
 *     later idle read re-fetches instead of reusing the entry. Invalidation
 *     does not cancel or version an in-flight `fetchQuery` for the same key:
 *     TanStack joins that pending promise, and when it resolves it clears the
 *     invalidated flag, so concurrent callers can still receive the
 *     pre-invalidation value. Nothing is invalidated at form mount — a form
 *     opened inside a row's window reads the cached value. Used by display
 *     surfaces (vault list, portfolio etc.) that read via the browsing SDK
 *     with a long staleTime — without this they would serve pre-tx data for
 *     up to `staleTimeMs`. Combined with `formStaleTimeMs`, this is the
 *     plan-time path's post-execution stale boundary, not a forced transport
 *     re-read.
 *
 * Stale-time classes (organising the rows below):
 *
 *   - **Default / low-volatility reads** (deployments, labels, oracle adapter
 *     lists, verified-vault arrays, reward campaign metadata, V3 list pages):
 *     5 min.
 *   - **Plan-critical chain reads** (vault info, account info, vault
 *     factory/type lookups): 5 min on the browsing SDK + 1 min on the plan-time
 *     SDK + invalidate-after-tx. The bumped 5-min stale lets quote plugins
 *     and simulate's `fetchVaultTypes` hit cache on Review-clicks; the post-tx
 *     invalidation makes display refresh after a deposit/borrow.
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

export const ACTIVITY_QUERY_STALE_TIME_MS = MINUTE

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
  queryBrevisCampaigns: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  queryBrevisUserProofs: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  queryEVaultVerifiedArray: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  queryEulerEarnConvertToAssets: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  queryEulerEarnVerifiedArray: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  queryFuulClaimChecks: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  queryFuulClaimableRewards: { staleTimeMs: DEFAULT_STALE_TIME_MS },
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
  queryTurtleMerkleProofs: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  queryTurtleStreams: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  queryV3EVaultList: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  queryV3EulerEarnList: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  queryV3IntrinsicApysPage: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  queryV3RewardsApyPage: { staleTimeMs: DEFAULT_STALE_TIME_MS },
  queryVaultInfoERC4626: { staleTimeMs: DEFAULT_STALE_TIME_MS },

  // === Plan-critical chain reads ===
  queryAccountVaults: { staleTimeMs: DEFAULT_STALE_TIME_MS, formStaleTimeMs: MINUTE, invalidateAfterTx: true },
  queryEVaultInfoFull: { staleTimeMs: 5 * MINUTE, formStaleTimeMs: MINUTE, invalidateAfterTx: true },
  queryEulerEarnVaultInfoFull: { staleTimeMs: 5 * MINUTE, formStaleTimeMs: MINUTE, invalidateAfterTx: true },
  queryV3AccountPositions: { staleTimeMs: DEFAULT_STALE_TIME_MS, invalidateAfterTx: true },
  queryV3EVaultDetail: { staleTimeMs: 5 * MINUTE, invalidateAfterTx: true },
  queryV3EulerEarnDetail: { staleTimeMs: 5 * MINUTE, invalidateAfterTx: true },
  queryEVCAccountInfo: { staleTimeMs: 5 * MINUTE, formStaleTimeMs: MINUTE, invalidateAfterTx: true },
  queryVaultAccountInfo: { staleTimeMs: 5 * MINUTE, formStaleTimeMs: MINUTE, invalidateAfterTx: true },
  queryVaultFactories: { staleTimeMs: 5 * MINUTE, invalidateAfterTx: true },

  // === Activity: V3-indexed event history ===
  queryAccountActivityEvents: { staleTimeMs: ACTIVITY_QUERY_STALE_TIME_MS, invalidateAfterTx: true },
  queryVaultActivityEvents: { staleTimeMs: ACTIVITY_QUERY_STALE_TIME_MS, invalidateAfterTx: true },
  // Historical liquidation valuations are immutable once indexed, but new
  // liquidations append — same freshness window as the feeds they enrich.
  queryLiquidations: { staleTimeMs: ACTIVITY_QUERY_STALE_TIME_MS, invalidateAfterTx: true },

  // === Position migration (SDK 1.1.3) ===
  // Discovery lists are heavier connector reads (GraphQL + balance
  // multicalls). External position balances and authorization state back
  // plan sizing and signature prompts — debt accrues per block and the user
  // can grant/revoke authorization mid-flow — so they get the balance-class
  // short windows plus post-tx invalidation (a completed migration must not
  // serve the pre-migration position for 5 minutes). Euler-side target
  // vault data (assets + borrow LTV) is governance config; source vault
  // asset addresses are immutable in practice.
  queryListPositions: { staleTimeMs: DEFAULT_STALE_TIME_MS, formStaleTimeMs: MINUTE, invalidateAfterTx: true },
  queryListTargets: { staleTimeMs: DEFAULT_STALE_TIME_MS, formStaleTimeMs: MINUTE, invalidateAfterTx: true },
  queryGetPosition: { staleTimeMs: MINUTE, formStaleTimeMs: 15 * SECOND, invalidateAfterTx: true },
  queryGetAuthorization: { staleTimeMs: MINUTE, formStaleTimeMs: 15 * SECOND, invalidateAfterTx: true },
  queryEulerTargetVaultData: { staleTimeMs: 5 * MINUTE, formStaleTimeMs: MINUTE },
  queryEulerSourceVaultAssets: { staleTimeMs: 5 * MINUTE },

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
  queryPythUpdateBundle: { staleTimeMs: 30 * SECOND },
  queryPythUpdateData: { staleTimeMs: 30 * SECOND },
  queryPythUpdateFee: { staleTimeMs: 30 * SECOND },

  // === Balances / allowances: short cache, 15 s in form context ===
  // The 15-second form window keeps external wallet changes from going unnoticed
  // for long; it is a stale time, so a read inside that window still comes from
  // cache. Balance reads are additionally marked `invalidateAfterTx` so post-tx
  // wallet refreshes (useWallets.updateBalances, fetchSingleBalance,
  // fetchVaultShareBalance) read the new on-chain state instead of the
  // 60-second browsing-SDK cache.
  queryNativeBalance: { staleTimeMs: MINUTE, formStaleTimeMs: 15 * SECOND, invalidateAfterTx: true },
  queryTokenBalances: { staleTimeMs: MINUTE, formStaleTimeMs: 15 * SECOND, invalidateAfterTx: true },
  queryBalanceOf: { staleTimeMs: MINUTE, formStaleTimeMs: 15 * SECOND, invalidateAfterTx: true },
  queryAllowance: { staleTimeMs: MINUTE, formStaleTimeMs: 15 * SECOND },
  queryPermit2Allowance: { staleTimeMs: MINUTE, formStaleTimeMs: 15 * SECOND },
}

const policyEntries = (): [EulerSDKQueryName, SdkQueryPolicyEntry][] =>
  Object.entries(SDK_QUERY_POLICY) as [EulerSDKQueryName, SdkQueryPolicyEntry][]

/** Names where `invalidateAfterTx === true` — marked stale after plan finalization / subgraph sync / CoW hard-cancel, not after standalone grant/revoke receipts. */
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
