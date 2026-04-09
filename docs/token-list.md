# Token List

The token list provides token metadata (name, symbol, decimals, logo URL) used across the app for asset logos, the swap token selector, and wallet balance fetching.

## Architecture

```text
Client (composables/useTokenList.ts)
  |
  |  GET /api/token-list?chainId=X  (on chain switch + 15s retry)
  v
Server (server/api/token-list.get.ts)
  |
  +-- Euler API      [primary, always awaited]
  +-- DefiLlama      [supplemental, best-effort]
  +-- Uniswap        [supplemental, best-effort]
  |
  v
Merge with deduplicateTokens()
Priority: Euler API > DefiLlama > Uniswap
```

## Server Endpoint

**`/api/token-list?chainId=<number>`**

Three data sources, each with its own 5-minute TTL cache and in-flight request deduplication:

| Source | Scope | Role |
|--------|-------|------|
| Euler API | Per-chain | Primary. Always awaited. Has reliable logo URLs. |
| DefiLlama | Per-chain | Supplemental. Served from cache or stale; fetched in background if missing. |
| Uniswap | All chains | Supplemental. Same as DefiLlama. |

The Euler API is the blocking call. Uniswap and DefiLlama are non-blocking: if their cache is warm they're included immediately, otherwise a background fetch is fired and the response is returned without waiting.

**Deduplication**: tokens are merged with Euler taking priority. If the same `chainId:address` appears in multiple sources, the higher-priority entry wins. This ensures Euler's metadata (name, symbol, decimals, logo URL) takes precedence over supplemental sources.

**Error contract**:

| Status | Condition | Body |
|--------|-----------|------|
| `200` | At least one source returned tokens | `{ tokens: TokenEntry[] }` |
| `400` | `chainId` is missing, non-numeric, zero, or negative | `{ statusCode: 400, statusMessage: "chainId is required and must be a positive integer" }` |
| `502` | All sources returned empty (Euler down, no stale data, supplemental caches cold) | `{ statusCode: 502, statusMessage: "Upstream error" }` |

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

The token list is loaded:

1. **On chain switch** via `watch(chainId)` in `app.vue` — gets Euler tokens immediately
2. **One-shot retry after 15 seconds** — picks up supplemental Uniswap/DefiLlama data that the server fetched in the background after the first request, then refreshes balances to include newly discovered tokens

The 15s retry timer is cancelled on chain switch so it never fires for a stale chain.

## CSP

The `img-src` directive uses `https:` as a wildcard because token logos come from unpredictable CDNs (CoinGecko, DefiLlama, Uniswap, etc.) that cannot be whitelisted upfront. Images are passive content with no script execution risk. All other CSP directives remain locked down.
