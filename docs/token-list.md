# Token List

The token list provides token metadata (name, symbol, decimals, logo URL) used across the app for asset logos, the swap token selector, and wallet balance fetching.

## Architecture

```text
Client (composables/useTokenList.ts)
  |
  |  GET /api/token-list?chainId=X  (once per chain switch)
  v
Server (server/api/token-list.get.ts)
  |
  +-- Euler API      ┐
  +-- DefiLlama      │  Promise.allSettled — all three concurrent,
  +-- Uniswap        ┘  bounded by 10s timeout each
  |
  v
Merge with deduplicateTokens()
Priority: Euler API > DefiLlama > Uniswap > Merkl reward-tokens
```

## Server Endpoint

**`/api/token-list?chainId=<number>`**

Four data sources, each with its own 5-minute TTL cache and in-flight request deduplication:

| Source | Scope | Role |
|--------|-------|------|
| Euler API | Per-chain | Primary. Reliable logo URLs. |
| DefiLlama | Per-chain | Supplemental. |
| Uniswap | All chains | Supplemental. |
| Merkl reward-tokens | Per-chain | Fallback. Fills in rEUL and other reward-specific tokens that rarely appear in general-purpose lists. Shares the rewards-cache state used by warm-cache, so in steady state this is a synchronous cache hit. |

All four sources run concurrently via `Promise.allSettled`. Each fetcher has its own 5-minute TTL cache, in-flight dedup, and a 10-second timeout that falls back to the stale cached value. On a warm cache the request returns immediately; on a cold cache the response is bounded by the slowest source and contains whatever resolved in time.

**Startup warming**: `server/plugins/warm-cache.ts` calls `refreshTokenList(chainId)` directly every 5 minutes for each enabled chain. The direct refresh bypasses the handler's fresh-cache short-circuit and always fetches all four sources + rebuilds the merged cache, so the entry is rewritten while the previous one is still serving live traffic. User requests arriving during a refresh continue to read the still-fresh old entry from `mergedCache`. Warming runs fire-and-forget (Nitro's node-server preset doesn't await plugin promises), so caches are typically hot within ~5 s of boot; users arriving before that pay the usual cold-upstream latency.

**Deduplication**: tokens are merged with Euler taking priority. If the same `chainId:address` appears in multiple sources, the higher-priority entry wins. This ensures Euler's metadata (name, symbol, decimals, logo URL) takes precedence over supplemental sources.

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

### Exported functions

| Function | Description |
|----------|-------------|
| `loadTokenList(forceRefresh?)` | Fetch token list from server. Respects 5-min cache unless `forceRefresh` is true. |
| `getAssetLogoUrl(address, symbol)` | Returns logo URL. Checks local overrides (`assets/tokens/`) first, then token list, then `''`. |
| `getTokenListLogoUrl(address)` | Returns logo URL from token list only. Upgrades CoinGecko `/thumb/` to `/small/`. |
| `hasToken(address)` | Check if a token is in the current map. |
| `getAllTokens()` | Get all tokens for the current chain. |
| `toVaultAsset(entry)` | Convert a token list entry to a `VaultAsset`. |

## Loading Strategy

The token list is loaded once per chain switch via `watch(chainId)` in `app.vue`. Because the server now awaits all three sources concurrently, a single client call returns the merged set — no second retry is needed. When the fetch completes, the `isTokenListLoaded` watcher refreshes wallet balances so any newly-discovered tokens are included.

## CSP

The `img-src` directive uses `https:` as a wildcard because token logos come from unpredictable CDNs (CoinGecko, DefiLlama, Uniswap, etc.) that cannot be whitelisted upfront. Images are passive content with no script execution risk. All other CSP directives remain locked down.
