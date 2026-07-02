# Token List

The token list provides token metadata (name, symbol, decimals, logo URL, and optional category tags) used across the app for asset logos, the swap token selector, wallet balance fetching, correlated-asset logic, and borrow-page asset filters.

## Architecture

```text
Client (composables/useTokenList.ts)
  |
  |  GET /api/internal/token-list?chainId=X  (once per chain switch)
  v
Server (server/api/internal/token-list.get.ts)
  |
  +-- Euler SDK token list ┐
  +-- DefiLlama            │  Promise.allSettled — all four concurrent,
  +-- Uniswap              │  bounded by 10s timeout each
  +-- Merkl reward-tokens  ┘
  |
  v
Merge with deduplicateTokens()
Priority: Euler SDK > DefiLlama > Uniswap > Merkl reward-tokens
```

## Server Endpoint

**`/api/internal/token-list?chainId=<number>`**

Four data sources, each with its own 5-minute TTL cache and in-flight request deduplication:

| Source | Scope | Role |
|--------|-------|------|
| Euler SDK token list | Per-chain | Primary. Reliable logo URLs and vault-relevant assets. |
| DefiLlama | Per-chain | Supplemental. |
| Uniswap | All chains | Supplemental. |
| Merkl reward-tokens | Per-chain | Fallback. Fills in rEUL and other reward-specific tokens that rarely appear in general-purpose lists. This source has its own token-list cache and is warmed through `/api/internal/token-list`. |

All four sources run concurrently via `Promise.allSettled`. Each fetcher has its own 5-minute TTL cache, in-flight dedup, and a 10-second timeout that falls back to the stale cached value. On a warm cache the request returns immediately; on a cold cache the response is bounded by the slowest source and contains whatever resolved in time.

**Startup warming**: `server/plugins/warm-cache.ts` calls `refreshTokenList(chainId)` directly every 5 minutes for each enabled chain. The direct refresh bypasses the handler's fresh-cache short-circuit and always fetches all four sources + rebuilds the merged cache, so the entry is rewritten while the previous one is still serving live traffic. User requests arriving during a refresh continue to read the still-fresh previous entry from `mergedCache`. Warming runs fire-and-forget (Nitro's node-server preset doesn't await plugin promises), so caches are typically hot within ~5 s of boot; users arriving before that pay the usual cold-upstream latency.

**Deduplication**: tokens are merged with the Euler SDK token list taking priority. If the same `chainId:address` appears in multiple sources, the higher-priority entry wins. This ensures Euler metadata (name, symbol, decimals, logo URL) takes precedence over supplemental sources.

**Error contract**:

| Status | Condition | Body |
|--------|-----------|------|
| `200` | At least one source returned tokens | `{ tokens: TokenEntry[] }` |
| `400` | `chainId` is missing, non-numeric, zero, or negative | `{ statusCode: 400, statusMessage: "chainId is required and must be a positive integer" }` |
| `502` | Merged token list is empty after combining all sources | `{ statusCode: 502, statusMessage: "Upstream error" }` |

## Client Composable

**`composables/useTokenList.ts`**

Singleton state with a `shallowRef` token map, keyed by normalized address.

- **Cache TTL**: 5 minutes. The client skips the API call if the same chain's data was fetched within the last 5 minutes (bypassed by `forceRefresh`).
- **Race guard**: prevents stale responses (from a previous chain) from overwriting current data.
- **`filterByChain()`**: filters the raw token array by `chainId`, normalizes addresses, and conditionally includes the native currency (address zero) when the wrapped variant exists.
- **Tags**: token entries may include `tags?: string[]`. `filterByChain()` normalizes tags with `normalizeTokenCategoryTags()` and copies wrapped-native tags to the native zero-address entry.

### Exported functions

| Function | Description |
|----------|-------------|
| `loadTokenList(forceRefresh?)` | Fetch token list from server. Respects 5-min cache unless `forceRefresh` is true. |
| `getAssetLogoUrl(address, symbol)` | Returns logo URL. Checks local overrides (`assets/tokens/`) first, then token list, then `''`. |
| `getTokenListLogoUrl(address)` | Returns logo URL from token list only. Upgrades CoinGecko `/thumb/` to `/small/`. |
| `hasToken(address)` | Check if a token is in the current map. |
| `getTokenByAddress(address)` | Return the normalized token-list entry, including `tags` when present. |
| `getTokenCategoryTags(address)` | Return normalized category tags from the token entry. Used by correlated-pair checks and borrow-page asset category filters. |
| `getAllTokens()` | Get all tokens for the current chain. |
| `toVaultAsset(entry)` | Convert a token list entry to a `VaultAsset`. |

## Category Tags

Category tags are an operational input, not just display metadata. `utils/token-categories.ts` allowlists correlated categories (`usd`, `eth`, `btc`, `mon`, `avax`, `hype`, `bnb`) and uses them to decide whether leveraged metrics are meaningful for a pair or portfolio position.

Current consumers:

- `areTokenAddressesCorrelatedByTags()` gates Max ROE and Max multiplier for pair-level surfaces such as Explore and Borrow.
- `areTokenAddressesInSameCorrelatedCategory()` gates portfolio ROE when a borrow position has one or more collateral vaults.
- `toTokenCategoryFilterValue()` and `tokenAddressMatchesCategoryFilter()` power Borrow quick filters such as `category:usd`.

When adding or changing token metadata, keep category tags lowercase and stable. Unsupported tags remain available on the token entry after normalization, but they do not participate in correlation or category quick filters unless added to `CORRELATED_CATEGORY_LABELS`.

## Loading Strategy

The token list is loaded once per chain switch via `watch(chainId)` in `app.vue`. The server awaits all four sources concurrently, so a single client call returns the merged set. When the fetch completes, the `isTokenListLoaded` watcher refreshes wallet balances so any newly-discovered tokens are included.

## CSP

The `img-src` directive uses `https:` as a wildcard because token logos come from unpredictable CDNs (CoinGecko, DefiLlama, Uniswap, etc.) that cannot be whitelisted upfront. Images are passive content with no script execution risk. All other CSP directives remain locked down.
