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
 *     Query's `staleTime` semantics.
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
 *   - **Static catalogue / metadata** (deployments, ABIs, labels, oracle
 *     adapter lists, verified-vault arrays): 5 min — these almost never
 *     change.
 *   - **Plan-critical chain reads** (vault info, account info, vault
 *     factory/type lookups): 5 min on the browsing SDK + 0 on the plan-time
 *     SDK + invalidate-after-tx. The bumped 5-min stale lets the Pyth
 *     plugin's `populateCollaterals` and simulate's `fetchVaultTypes` hit
 *     cache on Review-clicks; the post-tx invalidation makes display refresh
 *     after a deposit/borrow.
 *   - **Pricing / APY** (assetPriceInfo, rewards, intrinsicApy): 1 min —
 *     fresh enough for display, cheap to fetch.
 *   - **Time-sensitive** (Pyth update data + fee, simulate batch): 10 s on
 *     the browsing SDK + 0 on plan-time. Pyth payloads have a real on-chain
 *     validity window (~60 s); caching longer would make tx revert at
 *     execute.
 *   - **Balances / allowances**: 5 s on the browsing SDK + 0 on plan-time.
 *     Short enough that an external wallet change is picked up within ~5 s
 *     without explicit invalidation.
 *
 * Queries not listed here fall through to a 5-second default in
 * `sdk-query-cache.ts`'s `buildSdkQuery`. That fallback is exercised by
 * `tests/utils/sdk-query-cache.test.ts`.
 */
export interface SdkQueryPolicyEntry {
  staleTimeMs: number
  formStaleTimeMs?: number
  invalidateAfterTx?: boolean
}

const SECOND = 1_000
const MINUTE = 60 * SECOND

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
  queryEVaultVerifiedArray: { staleTimeMs: 5 * MINUTE, invalidateAfterTx: true },
  queryEulerEarnVerifiedArray: { staleTimeMs: 5 * MINUTE, invalidateAfterTx: true },
  queryV3VaultResolve: { staleTimeMs: 5 * MINUTE },

  // === Plan-critical chain reads ===
  queryEVaultInfoFull: { staleTimeMs: 5 * MINUTE, formStaleTimeMs: 0, invalidateAfterTx: true },
  queryEulerEarnVaultInfoFull: { staleTimeMs: 5 * MINUTE, formStaleTimeMs: 0, invalidateAfterTx: true },
  queryV3EVaultDetail: { staleTimeMs: 5 * MINUTE, invalidateAfterTx: true },
  queryV3EulerEarnDetail: { staleTimeMs: 5 * MINUTE, invalidateAfterTx: true },
  queryEVCAccountInfo: { staleTimeMs: 5 * MINUTE, formStaleTimeMs: 0, invalidateAfterTx: true },
  queryVaultAccountInfo: { staleTimeMs: 5 * MINUTE, formStaleTimeMs: 0, invalidateAfterTx: true },
  queryVaultFactories: { staleTimeMs: 5 * MINUTE, invalidateAfterTx: true },

  // === Pricing / APY: display-side, 1-min cache ===
  queryAssetPriceInfo: { staleTimeMs: MINUTE },
  queryV3RewardsBreakdown: { staleTimeMs: MINUTE },
  queryV3IntrinsicApy: { staleTimeMs: MINUTE },

  // === Time-sensitive (Pyth + simulation): short cache, always-fresh in form context ===
  queryBatchSimulation: { staleTimeMs: 10 * SECOND, formStaleTimeMs: 0 },
  queryPythUpdateData: { staleTimeMs: 10 * SECOND, formStaleTimeMs: 0 },
  queryPythUpdateFee: { staleTimeMs: 10 * SECOND, formStaleTimeMs: 0 },

  // === Balances / allowances: short cache, always-fresh in form context ===
  queryNativeBalance: { staleTimeMs: 5 * SECOND, formStaleTimeMs: 0 },
  queryTokenBalances: { staleTimeMs: 5 * SECOND },
  queryBalanceOf: { staleTimeMs: 5 * SECOND, formStaleTimeMs: 0 },
  queryAllowance: { staleTimeMs: 5 * SECOND, formStaleTimeMs: 0 },
  queryPermit2Allowance: { staleTimeMs: 5 * SECOND, formStaleTimeMs: 0 },
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
