// ── Cache TTLs ────────────────────────────────────────────
export const CACHE_TTL_15S_MS = 15_000
export const CACHE_TTL_1MIN_MS = 60_000
export const CACHE_TTL_5MIN_MS = 300_000

// ── Polling Intervals ─────────────────────────────────────
export const POLL_INTERVAL_5S_MS = 5_000
export const POLL_INTERVAL_10S_MS = 10_000
export const POLL_INTERVAL_30S_MS = 30_000
export const POLL_INTERVAL_60S_MS = 60_000

// ── RPC Batch Sizes ───────────────────────────────────────
export const BATCH_SIZE_RPC_CALLS = 5
export const BATCH_SIZE_VAULT_FETCH = 25
export const BATCH_SIZE_PARALLEL_ROUNDS = 5

// ── Request Batching Delays ───────────────────────────────
export const BATCH_DELAY_COLLECT_MS = 50

// ── Request Timeouts ────────────────────────────────────
export const TIMEOUT_SUBGRAPH_MS = 30_000

// ── Basis Points ──────────────────────────────────────────
export const BPS_BASE = 10_000n
/** BPS_BASE + 1: pads amounts by 0.01% to cover interest accrual */
export const INTEREST_ADJUSTMENT_BPS = 10_001n
