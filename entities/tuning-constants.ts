// ── Cache TTLs ────────────────────────────────────────────
export const CACHE_TTL_15S_MS = 15_000
export const CACHE_TTL_1MIN_MS = 60_000
export const CACHE_TTL_5MIN_MS = 300_000

// ── Polling Intervals ─────────────────────────────────────
export const POLL_INTERVAL_60S_MS = 60_000

// ── RPC Batch Sizes ───────────────────────────────────────
export const BATCH_SIZE_RPC_CALLS = 5
export const BATCH_SIZE_VAULT_FETCH = 25
export const BATCH_SIZE_PARALLEL_ROUNDS = 5

// ── Request Batching Delays ───────────────────────────────
export const BATCH_DELAY_COLLECT_MS = 100

// ── Request Timeouts ────────────────────────────────────
/** Subgraph query timeout (client-side). Longer than server-side subgraph
 * calls because client traffic tolerates higher variance. */
export const SUBGRAPH_TIMEOUT_MS = 30_000

// ── Debounce ──────────────────────────────────────────────
/** Price-fetch watchEffects on list pages. Collapses bursts of registry
 * updates streamed during loadVaults's RPC refresh into a single pass. */
export const DEBOUNCE_LIST_PRICE_FETCH_MS = 300

// ── Progressive list rendering ────────────────────────────
/** Rows rendered on the initial paint of a long list. Remainder is inserted
 * one frame later so the first paint is fast on large (400+ row) sets. */
export const LIST_INITIAL_BATCH_ROWS = 40
/** Estimated per-row height for the scroll-restoration spacer reservation. */
export const LIST_ROW_HEIGHT_PX = 88

// ── Wallet balances ───────────────────────────────────────
/** TTL for a "full" wallet balance fetch (the one that includes the whole
 * token list for the pay-with selector). Navigating between swap pages
 * within this window reuses the cached Map rather than re-fetching. */
export const FULL_BALANCES_TTL_MS = 60_000

// ── Basis Points ──────────────────────────────────────────
export const BPS_BASE = 10_000n
/** BPS_BASE + 1: pads amounts by 0.01% to cover interest accrual */
export const INTEREST_ADJUSTMENT_BPS = 10_001n
