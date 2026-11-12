# Server-Side Caching

Lite proxies external data sources — third-party reward APIs, subgraphs, Public Labels V3, the optional static authoring source, and the chain RPC — and caches selected responses. The layer accomplishes four things:

1. **Cross-tab sharing.** Every browser session against the same origin hits the same in-process cache.
2. **Authentication / credentials stay server-side.** Browsers don't need V3 API keys, subgraph project IDs, or any provider tokens.
3. **CORS avoidance.** Most upstreams don't set permissive CORS; same-origin proxying sidesteps the issue.
4. **First-paint amortization.** A consolidated vault snapshot is built every minute and served directly to `/lend`, so first paint is one HTTP fetch instead of a fan-out of per-vault calls.

This document covers the per-host proxies, the vault snapshot pipeline, the warm-cache plugin, and how V3 configuration changes the cadence.

## Files at a Glance

| File | Purpose |
|------|---------|
| `server/utils/provider-proxy.ts` | `createProviderProxy(config)`: the request pipeline every rewards-provider proxy runs (method check, allowlist, rate limit, credential, forward, error mapping, browser cache headers) |
| `server/utils/external-proxy.ts` | Shared forwarder underneath: TTL cache, in-flight dedup, stale-on-error fallback |
| `server/utils/rewards-proxy-allowlist.ts` | Per-provider path + query allowlists (`isAllowed*ProxyRequest`) |
| `server/api/internal/proxy/{merkl,fuul,incentra,turtle}/[...path].ts` | One `createProviderProxy` config each — upstream, allowlist, credential headers, rate limit, cache policy |
| `server/utils/merkl-proxy.ts`, `server/utils/turtle-proxy.ts` | Credential header builders (optional `MERKL_API_KEY`; required `TURTLE_EARN_API_KEY`) plus the fixed Turtle upstream constant shared with the server SDK builder |
| `server/api/internal/proxy/subgraph/[chainId].post.ts` | Proxies the chain's explicit subgraph URL or selected catalog endpoint (router param, per-chain source, not built with the factory) |
| `server/api/internal/public-labels.get.ts` | Chain/version-scoped aggregate Public Labels endpoint |
| `server/utils/public-labels-source.ts` | Public Labels V3 pagination, 5-minute cache, in-flight dedup, and bounded stale fallback |
| `server/utils/v3-chain-catalog.ts` | Euler default V3 indexing support, 5-minute cache, 24-hour maximum age, 30-second failure cooldown |
| `server/api/internal/chain-policy.get.ts` | Uncached policy combining registry lifecycle, V3 indexing support and env overrides |
| `server/api/internal/curator-profiles/[entityId].get.ts` | Chain-independent V3 entity profile |
| `server/utils/curator-profile-source.ts` | 5-minute profile cache, 15 s timeout, 404 → empty V3 entity |
| `server/api/internal/curator-networks/[entityId].get.ts` | Per-enabled-chain product / Earn counts for a managing entity |
| `server/utils/curator-network-index.ts` | 5-minute network-index cache, 25 s timeout, EulerChains admission |
| `server/api/internal/liquidation-coverage.get.ts` | Chain-scoped default liquidation bot coverage |
| `server/utils/liquidation-coverage-source.ts` | Reads each bot's `/vault-filter`, 5-minute cache, 30-minute last-good window, one-minute retry floor |
| `server/utils/static-labels-source.ts` | Atomic static authoring snapshots, used only in static mode |
| `server/api/internal/v3/[...path].ts` | Rate-limited V3 backend proxy for SDK browser endpoints (`/api/internal/v3/...` → `v3.euler.finance/v3/...`) |
| `server/api/internal/proxy/intrinsic-apy-overrides.get.ts` | Lite intrinsic-APY overlay for HyperEVM / Monad; chain-keyed 5-min cache |
| `server/api/internal/vaults.get.ts` | Per-chain consolidated vault snapshot endpoint |
| `server/utils/vaults-cache.ts` | `refreshChainVaults` + `vaultsCache` |
| `server/utils/sdk-server.ts` | Lazy per-chain server-side SDK builder, including Sonic transport tuning |
| `server/plugins/warm-cache.ts` | Boot + interval warm cycles for labels, token-list, vault snapshot |
| `utils/snapshot-codec.ts` | Bigint-safe JSON wire format |
| `utils/snapshot-types.ts` | Wire-shape types shared client + server |
| `utils/sdk-vault-meta-stub.ts` | Registry-backed `IVaultMetaService` for the client-side hydration two-pass |
| `composables/useVaults.ts:hydrateFromServer` | Browser-side snapshot hydrate |

## Per-Host Proxies

This section is the canonical reference for the same-origin proxies under `/api/internal/proxy/*`. Other docs link here instead of repeating the rules.

### Rewards providers: `createProviderProxy`

Merkl, Fuul, Incentra and Turtle are all built from `createProviderProxy(config)` in `server/utils/provider-proxy.ts`. A route file is a config object; the factory owns the pipeline, so every provider gets the same behaviour and a security fix lands in one place. The pipeline, in order, and the status each step answers with:

| Step | Failure → status | Notes |
|---|---|---|
| 1. Method in `methods` | 405 | Checked before anything else |
| 2. Path starts with the route prefix | 404 | `Not a <provider> proxy path` |
| 3. `allow(method, path, params)` | 404 | `<Provider> path not allowed`. Exact path + exact query-key allowlist; rejected before rate limiting and before any upstream contact |
| 4. Rate limit | 429 / 403 | `createRateLimiter` keyed on the trusted client IP; see `server/utils/rate-limit.ts` |
| 5. `headers()` returns `undefined` | 503 | `<Provider> API key not configured` — a required credential is missing; upstream is never called |
| 6. Upstream timeout | 504 | `<Provider> upstream timed out`, logged at `info` with `reason: upstream-timeout` |
| 7. Upstream non-2xx or network error | 502 | `<Provider> upstream unavailable`. If a stale cache entry exists it is served instead (`x-cache: stale-fallback`) |

Fixed rules, not configurable per provider:

- **Caller headers are never forwarded.** The upstream request carries only what the provider's `headers()` returns (default `accept: application/json`, plus `content-type: application/json` when a body is forwarded).
- **Upstream error bodies are never returned or logged.** Logs carry the upstream host, a path template with addresses/ids masked, query keys, duration and status — never query values, wallets or credentials.
- **Responses are TTL-cached by `sha1(method, target, body)`** through `external-proxy.ts` (fresh hit → `x-cache: hit`; miss → `miss`; stale served on failure within `2 × ttlMs`, capped at 30 min). `cache.bypass` skips the store for per-wallet reads while still coalescing concurrent identical requests (`x-cache: bypass`).
- **Credentialed providers set `redirect: 'manual'`** so a redirect surfaces as a 502 instead of replaying the key against the redirect target, and use a constant upstream rather than an env override — with a key attached, a configurable URL is a leak waiting for a typo. Anonymous providers may read their upstream from env via `upstreamFromEnv([...keys], fallback)`, re-read per request.

### Per-host config

| Endpoint | Upstream | Methods | Allowlist (`rewards-proxy-allowlist.ts`) | Credential | Server TTL | Browser hint | Rate limit |
|---|---|---|---|---|---|---|---|
| `/api/internal/proxy/merkl/{...}` | `api.merkl.xyz/v4` (fixed; `redirect: manual`) | GET, HEAD | `opportunities` (`chainId`, `type`, `campaigns`, `mainProtocolId`), `users/0x…/rewards` (`chainId`, `type`; `type=TOKEN` defaulted when absent) | optional `MERKL_API_KEY` → `X-API-Key` | 60 s | `public, max-age=60` | 600 / min |
| `/api/internal/proxy/fuul/{...}` | `api.fuul.xyz/api/v1`; override `FUUL_API_URL` / `NUXT_PUBLIC_FUUL_API_URL` | GET, HEAD | `incentives` (`protocol`, `chain_id`), `claimable-rewards` (`protocol`, `user_address`, `chain_id`) | none | 60 s | `public, max-age=30, stale-while-revalidate=30` | 600 / min |
| `/api/internal/proxy/incentra/{...}` | `incentra-prd.brevis.network`; override `INCENTRA_API_URL` / `NUXT_PUBLIC_INCENTRA_API_URL` | POST (body forwarded verbatim, no query) | `sdk/v1/eulerCampaigns`, `v1/getMerkleProofsBatch` | none | 60 s | `public, max-age=30, stale-while-revalidate=30` | 600 / min |
| `/api/internal/proxy/turtle/{...}` | `earn.turtle.xyz/v2` (fixed, no override; `redirect: manual`) | GET, HEAD | `streams/merkle_proofs` (`wallet`, one or more `streamIds` UUIDs, repeated rather than comma-joined) | **required** `TURTLE_EARN_API_KEY` → `X-API-Key`; 503 when unset or blank | bypass (per-wallet proofs) | `no-store` | 300 / min |

Turtle is the only provider whose credential is required: Turtle rejects unauthenticated requests, so the route fails closed rather than forwarding a request that would 401 anyway. Merkl works anonymously on a shared quota and only attaches a key when one is configured.

### Adding a provider

1. Add an `isAllowed<Provider>ProxyRequest(method, path, params)` to `server/utils/rewards-proxy-allowlist.ts`: exact paths, exact query keys, validated values (addresses, chain ids). Test it.
2. Create `server/api/internal/proxy/<provider>/[...path].ts` exporting `defineEventHandler(createProviderProxy({...}))`. If the provider needs a key, add a `build<Provider>ProxyRequestHeaders()` in `server/utils/<provider>-proxy.ts` that reads a server-only variable (never `NUXT_PUBLIC_*`) and returns `undefined` when it is missing, use a constant upstream and set `redirect: 'manual'`.
3. Point the SDK config field at the proxy in `buildSdkStaticConfig` (`composables/useEulerSdk.ts`).
4. Add a row to the table above, the env var to the README table, and a route test modelled on `tests/server/turtle-proxy-route.test.ts`. The factory itself is covered by `tests/server/provider-proxy.test.ts`; route tests only need to pin the provider-specific config (upstream, allowlist, headers, cache hint).

### Subgraph proxy

`/api/internal/proxy/subgraph/{chainId}` (`[chainId].post.ts`) is not built with the factory: its upstream is selected per chain from `SUBGRAPH_URL_<chainId>`, then `NUXT_PUBLIC_SUBGRAPH_URI_<chainId>`, then the optional `SUBGRAPH_CATALOG_URL`. `SUBGRAPH_DISABLED_<chainId>` takes priority over every source; `SUBGRAPH_CATALOG_DISABLED` disables catalog resolution. A chain with no selected source is a 404; a per-chain disable or an invalid, retired or unavailable selected catalog source is a 503. An empty body is a 400. It still forwards through `external-proxy.ts` (POST only) with `bypassCache: true` and a `no-store` browser hint; the proxy coalesces concurrent identical queries without caching completed responses. It carries its own rate limiter. Optional catalog metadata refreshes after 60 seconds and retains the last successful snapshot for up to seven days during outages. The SDK separately caches checked query results according to its browsing/form/server policies; see [Subgraph catalog resolution](./sdk-integration.md#subgraph-catalog-resolution).

The response budget is 8 MiB of decoded body bytes and 10 seconds total for fetching headers and consuming the full body, including upstream error responses. Oversized or slow responses return 502 and fail the checked subgraph read. Onchain account discovery also requires a successful subgraph response. The total deadline intentionally includes body consumption. The proxy retains the SDK's dynamic GraphQL query surface; these limits bound buffering and waiting, not upstream query computation.

### Why route through these proxies

- **Fuul, Incentra/Brevis, Merkl**: provider APIs don't set permissive CORS; direct browser fetches fail. Proxying also shares one warm response across every connected wallet and keeps the optional Merkl key server-side.
- **Turtle**: the API key must stay off the client; the browser only fetches reward proofs through the proxy, while stream discovery happens in the server-side SDK (see below).
- **Subgraphs**: Euler's published catalog selects Goldsky endpoints. Forks can supply compatible endpoints through direct URL overrides or their own catalog. Proxying keeps configured upstream URLs server-side; completed proxy responses are not cached. SDK query caches have bounded stale windows and post-transaction invalidation. Fresh reads validate payloads and, for catalog sources, the selected deployment. Reads are best-effort rather than a guarantee of the latest block.

### Intrinsic APY overlay

`GET|HEAD /api/internal/proxy/intrinsic-apy-overrides?chainId=` is a Lite-owned aggregator, not `external-proxy.ts`. Origin results are cached 5 minutes **by `chainId` only** — extra query parameters must not create extra origin fetches. Concurrent callers coalesce per chain. Unsupported chains return `[]` without fetching. HyperEVM all-source failure caches an empty array until TTL expiry; a Monad origin throw is not cached. Browser `Cache-Control: public, max-age=300`; Nitro route rules add CDN `s-maxage=300, stale-while-revalidate=600`. Rate limiter: 300 / 60 s. End-to-end behavior, V3 overlay rules, and the unwrapped server snapshot are in [Intrinsic APY](./intrinsic-apy.md#lite-override-proxy).

### Public Labels

`/api/internal/public-labels?chainId=N` is the browser's single label read. `server/utils/public-labels-source.ts` reads the admitted `EulerChains.json` manifest and, for Euler's default V3, its indexing catalog, then paginates vaults, products, entities, entity governance addresses, and geo policies directly from V3. Chains retired by Euler's default V3 catalog use metadata with on-chain verification; indexed Euler chains and custom-provider chains use V3 visibility verdicts regardless of deprecation. Results are cached for five minutes by chain, version, and verification mode; concurrent misses share one in-flight operation. Bundle and geo-policy stale fallback is bounded to 24 hours. Geo separately retains a validated, fetchedAt-stamped disk checkpoint; cold starts without valid geo policies cannot publish a bundle. Mount `GEO_POLICY_CACHE_DIR` for cross-container persistence.

`LABELS_SOURCE=v3` performs no label-file reads. `LABELS_SOURCE=static` reads the operator-owned authoring files on the same warm/refresh cycle and uses one atomic disk checkpoint for the entire collection. See [Static labels](./static-labels.md).

### Curator profile and network index

These are separate from the chain-scoped public-labels bundle. Both routes require `entityId` matching `^[A-Za-z0-9_-]{1,100}$`, rate-limit at 120 / 60 s, and send `Cache-Control: public, max-age=60, stale-while-revalidate=60`. Upstream failures are 502.

| Route | Cache key | Timeout | Miss / 404 |
|---|---|---|---|
| `GET /api/internal/curator-profiles/{entityId}` | V3 URL + label set + version + entity id | 15 s | 404 → `{ source: 'v3', entity: null }`; other errors use bounded stale then 502 |
| `GET /api/internal/curator-networks/{entityId}` | same, plus enabled chain ids after EulerChains admission | 25 s | stale then 502 |

Static labels mode returns `{ source: 'static' }` without hitting V3 (profile `entity: null`, networks `[]`). Product counts use `product.entityId`; Earn counts use vault rows with `vaultType === 'earn'`. Page-level fallback and completeness rules are in [Vault Labels → Curator profile pages](./vault-labels-and-verification.md#curator-profile-pages).

### Liquidation bot coverage

`/api/internal/liquidation-coverage?chainId=N` answers which vaults the default liquidation bot leaves out on that chain. `LIQUIDATION_BOT_API_URL` is a URL template that must contain `{chainId}` (replaced per request), use HTTPS except loopback HTTP, and carry no credentials, query, or fragment. An invalid template is logged once and treated as off. With the variable unset the route answers `{ enabled: false }` and nothing is fetched.

`server/utils/liquidation-coverage-source.ts` fetches `{base}/vault-filter` with one 5 s deadline covering the headers and the body, follows no redirects, and parses with `parseVaultFilter`. The bot's reasons are dropped. More than 2,000 items, a malformed address, a non-string reason, or an unknown mode is not a filter. Mode names are the bot's PascalCase strings mapped through a `Map` (`None`, `Blacklist`, `Whitelist`); lowercase `blacklist` is not accepted.

| Mode | Meaning for the vault an account **borrows from** |
|------|---------------------------------------------------|
| `none` | Every vault is covered |
| `blacklist` | Listed addresses are not covered |
| `whitelist` | Only listed addresses are covered |

An answer is fresh for 5 minutes; after that it is still served at once while a background refresh runs, until 30 minutes after it was fetched. Past that, or when the bot has not answered since the server started, the chain is `no-bot`. A failing chain is retried at most once a minute. The browser asks again after a minute for a `no-bot` answer and before an answer reaches 30 minutes.

The badge is borrow-side only (`hasBorrowSide`: an EVK that is open to new borrows or still has residual `totalBorrowed`). Earn, Securitize, and collateral-only EVKs never badge. Unknown coverage — feature off, or the Lite endpoint failed and the last answer expired — renders nothing. `no-bot` badges every borrowable vault on that chain. The browser uses `no-bot` only when the server returns that state; a failed `$fetch` never synthesizes it.

Copy differs by surface (`getLiquidationCoverageWarning`):

- **Lend** (list + EVK overview, default): other liquidators may not act, so losses from unhealthy positions can reach lenders.
- **Borrow** (borrow list, borrow-pair overview, portfolio borrow): other liquidators may still liquidate the position.

The list chip is `LiquidationCoverageBadge` (`data-id="liquidation-coverage"`). The overview uses `LiquidationCoverageNotice`. Both call `isNotCoveredByDefaultBot`. Visible-tab poll and focus/visibility handlers expire answered coverage after 30 minutes, including while a refresh is in flight.

### V3 proxy

`/api/internal/v3/{...path}` is a deliberately narrow same-origin proxy for browser-side SDK V3 calls and a few Lite-owned chart endpoints. It normalizes browser paths to `/v3/...`, validates the exact path/method allowlist, consumes a local rate-limit budget, injects the server-side V3 API key when configured, and forwards only JSON-safe headers to the upstream V3 API. Query strings and POST bodies are forwarded unchanged after the route/method check, except that the V3 refresh parameters `forceFresh`, `maxAge` and `minBlock` are removed from every query string, because they would spend this deployment's V3 refresh budget; V3 remains responsible for domain-level validation.

Request flow:

```text
browser / SDK
  -> /api/internal/v3/{...path}
  -> server/utils/v3-proxy.ts validates path + method
  -> server/utils/v3-proxy-backoff.ts checks per-route cooldown
  -> V3_API_URL / EULER_SDK_V3_API_URL / NUXT_PUBLIC_V3_API_URL
```

If no V3 URL env var is set, the proxy target falls back to `https://v3.euler.finance`; `enableV3Backend` still remains `false`, so normal `fallback` SDK reads skip V3 unless the deployment explicitly configures it.

#### Allowlist

Allowed `GET` paths:

| Path | Notes |
|---|---|
| `/v3/tokens` | Token list / token metadata. |
| `/v3/prices` | V3 prices. |
| `/v3/apys/intrinsic` | Intrinsic APY data. |
| `/v3/apys/rewards` | Reward APYs. |
| `/v3/rewards/breakdown` | Rewards breakdown. |
| `/v3/accounts/{address}/positions` | Account positions. |
| `/v3/activity/accounts/0x…/events` | Portfolio / account activity events. Pattern requires a `0x` + 40-hex owner. |
| `/v3/activity/vaults/{chainId}/0x…/events` | Vault activity events. Pattern requires a positive integer chain id and a `0x` + 40-hex vault. |
| `/v3/liquidations` | Liquidation rows used to enrich activity feed liquidations. |
| `/v3/earn/vaults` | Earn vault catalogue. |
| `/v3/earn/vaults/{chainId}/{vault}` | Earn vault read. |
| `/v3/earn/vaults/{chainId}/{vault}/totals` | Earn vault totals history. |
| `/v3/evk/vaults` | EVK vault catalogue. |
| `/v3/evk/vaults/{chainId}/{vault}/totals` | EVK vault totals history. |
| `/v3/evk/vaults/bad-debt` | Bad debt rows. |
| `/v3/evk/vaults/open-interest/by-collateral` | Open interest grouped by collateral. |

Activity surfaces are documented end-to-end in [Activity Feed](./activity-feed.md).

Allowed `POST` paths:

| Path | Notes |
|---|---|
| `/v3/evk/vaults/batch` | SDK batched EVK vault reads. |
| `/v3/resolve/vaults` | SDK vault resolution. |

Everything outside the allowlist returns `404 V3 path not allowed`; method mismatches return `405 Method not allowed`. Additions should be made in `server/utils/v3-proxy.ts` alongside tests so the browser cannot accidentally become an open proxy.

#### Headers, rate limits, and responses

- Rate limiter label: `v3-proxy`, `10_000` budget units per 60 seconds.
- Cost: `GET` = 1 unit, `POST` = 5 units.
- Request headers sent upstream: `accept: application/json`, `content-type: application/json` for POST, and `X-API-Key` when `V3_API_KEY`, `EULER_SDK_V3_API_KEY`, or `EULER_V3_API_KEY` is configured.
- Response headers forwarded back: `cache-control`, `cf-ray`, `content-type`, `etag`, and `last-modified`.
- The proxy itself does not TTL-cache V3 responses; V3 and any CDN in front of it own freshness. Retry protection is handled by the backoff described below.

#### Failure backoff and logs

`server/utils/v3-proxy-backoff.ts` applies a 10-second cooldown (`V3_PROXY_FAILURE_BACKOFF_MS`) per normalized route key after:

- upstream fetch errors, or
- retryable upstream statuses: `429`, `500`, `502`, `503`, `504`.

During cooldown the proxy returns `503 V3 upstream cooling down` with a `retry-after` header. Fetch exceptions return `503 V3 upstream unavailable` and also set `retry-after`.

Backoff keys normalize high-cardinality account and vault paths:

| Request shape | Backoff key behavior |
|---|---|
| `/v3/accounts/{address}/positions` | Address is collapsed to `/v3/accounts/:address/positions`. |
| `/v3/activity/accounts/{owner}/events` | Owner is collapsed to `/v3/activity/accounts/:owner/events`, plus safe activity query context (`chainId`, `vaultType`, `from`, `to`, `category`, `eventType`) when present. |
| `/v3/activity/vaults/{chainId}/{vault}/events` | Vault address is collapsed to `/v3/activity/vaults/{chainId}/:vault/events` (chain id stays in the template), plus the same safe activity query context when present. |
| `/v3/earn/vaults/{chainId}/{vault}` | Chain and vault are collapsed to `/v3/earn/vaults/:chainId/:vault`. |
| `/v3/{evk,earn}/vaults/{chainId}/{vault}/totals` | Full path is retained, plus `resolution`, `from`, and `to` query params when present. |
| Other paths (including `/v3/liquidations`) | Full normalized path is used. |

Non-OK upstream responses and fetch exceptions are logged with `ctx: "v3-proxy"`, `method`, `pathTemplate`, `upstreamHost`, `durationMs`, optional `bodyBytes`, and safe V3 context from `buildV3ProxyLogFields()`: `v3ChainId`, `v3ChainIds`, `v3VaultKind`, `v3VaultAddress`, `v3ActivityScope`, `v3ActivityCategories`, `v3ActivityEventTypes`, and sanitized pagination/range fields such as `v3From`, `v3To`, `v3Limit`, `v3Offset`, `v3Resolution`, and `v3MinBadDebtUsd`. Account, violator, and liquidator wallet addresses are intentionally omitted from logs.

Troubleshooting quick checks:

| Symptom | Check |
|---|---|
| `404 V3 path not allowed` | The browser is calling a path not declared in `GET_ONLY_PATHS`, `GET_ONLY_PATH_PATTERNS`, or `POST_ONLY_PATHS`. Add a narrow allowlist entry instead of forwarding a broad prefix. |
| `405 Method not allowed` | The path exists but is being called with the wrong method, or an unsupported method was sent. |
| Repeated `503 V3 upstream cooling down` | Search logs for the same `pathTemplate` and V3 context in the previous 10 seconds; the first retryable failure records the cooldown. |
| V3-only charts or bad-debt sections are hidden | `useV3ChainGate()` requires `enableV3Backend` and excludes chains in the resolved onchain SDK list (chains retired by Euler's default V3 catalog plus explicit overrides). Exposure displays can fall back to RPC-derived qualitative data, but bad debt and history have no on-chain equivalent. |

## Vault Snapshot Pipeline

The largest win in this layer. The server pre-computes a consolidated snapshot of every public vault on a chain (~50–400 vaults depending on chain) and serves it from a fast TTL cache. The browser hydrates the registry from this single fetch on `/lend`, then runs a silent RPC refresh in the background. Time-to-first-paint goes from ~3.4 s (no snapshot, V3 off) to ~1.0 s.

### Server side

`server/utils/vaults-cache.ts:refreshChainVaults(chainId)` is the single refresh path. Used by:

- **`server/plugins/warm-cache.ts`**: every minute (V3 enabled) or every 5 minutes (V3 off), excluding deprecated chains.
- **`server/api/internal/vaults.get.ts`**: request-time refresh when the current policy has no usable snapshot, including cold starts, policy transitions and entries beyond the stale ceiling. A usable cached snapshot is returned without refreshing vault data.

Pipeline:

```text
0. policy = await loadServerChainReadPolicy(chainId)
1. getServerSdk(chainId, policy)  // reused within the current policy/configuration
2. getPublicEulerLabelsData(chainId) // shared normalized Public Labels bundle
3. sdk.eVaultService.fetchVerifiedVaultAddresses(chainId, [ESCROW])   // escrow set
4. sdk.vaultMetaService.fetchVaultTypes(chainId, candidates)          // partition EVK vs Securitize vs Earn
5. Promise.all([
     sdk.eVaultService.fetchVaults(evkAddrs, opts),
     sdk.eulerEarnService.fetchVaults(earnAddrs, opts),
     sdk.securitizeVaultService.fetchVaults(securitizeAddrs, opts),
     sdk.eVaultService.fetchVaults(escrowAddrs, opts),
   ])
6. encodeBigints(payload)         // includes chainPolicy; tags bigints as { __bi: "<decimal>" }
7. Recheck policy; reject the result if it changed during the refresh
8. vaultsCache.set(vaultsCacheKey(chainId, policy), payload)
```

Fetch options:

```ts
{
  populateMarketPrices: true,
  populateRewards: true,
  populateIntrinsicApy: true,
  populateCollaterals:     false,  // deferred — see below
  populateStrategyVaults:  false,  // deferred — see below
}
```

`populateCollaterals` and `populateStrategyVaults` populate `collateral.vault` (and `strategy.vault`) with direct EVault instance references. Those don't round-trip through JSON cleanly — they'd duplicate every collateral vault across the wire and break object identity on the client. The server omits them; the client restores them on hydration.

### Server-side SDK builder

`server/utils/sdk-server.ts:getServerSdk(chainId)` caches the current SDK per chain and rebuilds it when the resolved policy or configuration changes. Chains retired by Euler's default V3 catalog and explicit onchain overrides use onchain adapters. Other chains, including custom-provider chains without an onchain override, follow `SERVER_VAULT_CACHE_SOURCE` (default `fallback`):

| Value | Behavior |
|---|---|
| `fallback` *(default)* | V3 primary, on-chain secondary. With V3 configured: cheap/fast batched fetches. Without V3: `disableV3: true` short-circuits the fallback chain so the snapshot is built from onchain lens multicalls (slower but authoritative). |
| `onchain` | Account/vault/Earn reads use RPC and subgraph discovery; rewards use direct providers. Labels and optional V3 utilities follow their own settings. |
| `v3` | Account/vault/Earn and rewards use V3 without onchain fallback. An unset upstream URL resolves to Euler's hosted default. |

A boot-time warning fires if `SERVER_VAULT_CACHE_SOURCE` (or `NUXT_PUBLIC_BROWSER_VAULT_SOURCE`) needs V3 but `V3_API_URL` is unset — see `utils/api-url-env.ts:warnIfVaultSourceNeedsV3`.

`labels-view.ts` shares the same `getServerSdk` instance per chain.

The server SDK's labels service reads `getPublicLabelsBundle` directly. The token-list route's SDK uses the same service; both follow `LABELS_SOURCE=v3` or `LABELS_SOURCE=static` and reject an expired hosted snapshot. Neither SDK uses the default file-based labels adapter.

**Turtle rewards.** The direct Turtle rewards adapter inside the server SDK calls Turtle Earn upstream (not through `/api/internal/proxy/turtle`), and every Turtle endpoint requires `X-API-Key`. In fallback mode, the V3 rewards adapter sources campaigns from `euler-data-v3`. `resolveServerTurtleRewardsConfig()` therefore hands the SDK the same server-only `TURTLE_EARN_API_KEY` as `rewardsTurtleApiKey`, pinned to the same fixed upstream the proxy uses. When the key is unset or blank after trimming, the builder emits `rewardsEnableTurtle: false` so the direct adapter skips Turtle discovery rather than issuing guaranteed-401 requests. That flag gates only the direct adapter: in the default fallback mode the V3 adapter still returns Turtle campaigns it sourced from euler-data-v3, so those campaigns can remain in snapshots while the proof proxy answers 503. Missing Turtle campaigns are therefore not a reliable missing-key symptom, and visible campaigns do not prove the key is set. The SDK never follows redirects on credentialed Turtle requests. The key participates in the SDK configuration cache key. Restart the deployment to apply environment changes.

Every server-side SDK build resolves the deployments manifest through the euler-chains cache chain rather than fetching euler-interfaces directly: `server/plugins/sdk-deployments.ts` installs `DeploymentService.setQueryDeployments(loadEulerChains)` at boot, so all server SDK builds share one cached copy with its 7-day stale window instead of issuing their own GitHub fetches.

Deployment admission is per chain: valid rows refresh independently, present invalid rows retain their last-good entry only within its original 7-day stale window, and omitted rows leave the admitted set. Empty, malformed, or entirely invalid responses keep the bounded stale fallback. An RPC-configured chain without an admitted deployment is excluded from the injected browser chain lists; without any cached manifest, the env-derived config applies. The browser also intersects its initial RPC list with the fetched deployment IDs before constructing providers, so a slow registry boot read cannot enable an incomplete chain. Address loading keeps only that intersection and selects an admitted chain if the initial selection is unavailable.

### Server provider overrides

`getServerSdk` talks directly to `RPC_URL_<chainId>` through the SDK's provider. The SDK resolves chain metadata using the registry's `viemName` before applying Lite's `chains` transport options.

Sonic (`146`) is the only transport override. Other chains keep the SDK defaults (Ethereum in tests: Multicall `batchSize: 2048`, `wait: 10`). Each server SDK is built with only that chain's RPC URL, so asking its provider for another chain throws.

Transport overrides are a code map in `server/utils/sdk-server.ts`, covered by `tests/server/sdk-server.test.ts`. Because the server SDK is cached per chain at first use, a changed override needs a process restart. Sonic's public RPC / lens path uses:

| Layer | Value | Effect |
|---|---|---|
| `batch.multicall` | `{ batchSize: 128, wait: 10 }` | viem Multicall **byte** cap (not a call count). For VaultLens `getVaultInfoFull` reads this budget is **3 calls per `aggregate3`**. |
| HTTP `http(rpcUrl, { batch })` | `{ batchSize: 100, wait: 10 }` | JSON-RPC requests per HTTP body. The 3-call aggregates are then packed into one HTTP batch. |

Pinned by `tests/server/sdk-server.test.ts`: 36 concurrent Sonic lens reads become twelve `aggregate3` calls of three targets each, issued as a single HTTP JSON-RPC batch to the configured `RPC_URL_146`.

This is a different throttle from `EVAULT_FETCH_CHUNK_CHAINS`, which splits Lite's `eVaultService.fetchVaults(...)` into sequential SDK calls of 6 addresses. The two compose: chunked `fetchVaults` still uses the Sonic-throttled provider for each on-chain read. Browser wagmi / `getPublicClient` batching (`batchSize: 100`, Ankr-public clamp of 10) does not apply here.

| Symptom | First check |
|---|---|
| Sonic snapshot / server label reads fail with oversized Multicall or RPC batch errors | Confirm `getServerSdk` sets transport tuning for chain `146` and the process was restarted after a change |
| Other chains suddenly issue tiny Multicall aggregates | An override was added too broadly — only list the chain that needs it |
| `EVAULT_FETCH_CHUNK_CHAINS=146` does not stop Sonic Multicall failures | Expected: that env only chunks `fetchVaults`, it does not change viem Multicall size |

### Disabling the snapshot

Set `DISABLE_SERVER_VAULT_CACHE=true` to:

- Skip the vault warm-cache cycle in `warm-cache.ts` (the labels / token-list / chains cycle still runs).
- Make `/api/internal/vaults?chainId=N` respond `503 Vault snapshot disabled`.

The browser's snapshot hydrate (`hydrateFromServer`) treats the 503 as a hydrate failure and loads through `getEulerSdkForChain`, using the resolved V3/onchain routing. Disabling snapshots does not force browser reads onchain. This setting is useful when the host cannot afford the snapshot's outbound V3/RPC fan-out, or when bot-management throttles bursty origin traffic.

### Wire format

`utils/snapshot-codec.ts` exposes two functions:

```ts
encodeBigints(value)   // bigint → { __bi: "<decimal>" }, walks plain objects AND class instances
decodeBigints(value)   // reverse; only single-key { __bi: "<dec>" } objects unwrap, others round-trip as data
```

Adversarial safety: vault `name()` / `symbol()` come from on-chain ERC-20 metadata and can be set to arbitrary strings. A prefix-form encoding (`"__bi:0"`) would let a malicious deployer poison the decoder. The object-wrapper tag is unforgeable from any string field. Pinned by `tests/utils/snapshot-codec.test.ts`.

The encoder walks class instances (vault entities are classes — `EVault`, `EulerEarn`, `SecuritizeCollateralVault`) so their bigint fields get tagged; the decoder produces plain objects (the class identity is recovered on the client via `new EVault(args)`).

### Endpoint

`GET /api/internal/vaults?chainId=N`:

- Resolves the current chain policy, then returns its cached snapshot (5-min TTL with V3 off, 2-min TTL with V3 enabled). Stale fallback lasts up to three times the TTL from fetch time: 6 min with V3 enabled, 15 min otherwise.
- `vaultsCache.get(...) ?? vaultsCache.getStale(...)` serves usable snapshots without refreshing vault data.
- When that policy has no usable snapshot, synchronously awaits `refreshChainVaults`. In-flight dedup is scoped to the chain and policy.
- Response header: `Cache-Control: public, max-age=30, stale-while-revalidate=30`.

### Browser side

`composables/useVaults.ts:loadVaults()` runs in two phases:

```text
Phase 0: hydrateFromServer(chainId, generation)
  - $fetch('/api/internal/vaults?chainId=N')
  - decodeBigints(wire)
  - reject malformed data, a different chain, or a missing/mismatched chainPolicy
  - reject if older than MAX_HYDRATION_AGE_MS (6 min)
  - Pass 1: instantiate every kind into its SDK class
            new EVault(args), new EulerEarn(args), new SecuritizeCollateralVault(args)
            registry.setMany([...])
  - Pass 2: registry-backed cross-ref wiring (pure memory)
            const meta = buildRegistryMetaService(registry)
            await Promise.all([
              ...evk.map(v  => v.populateCollaterals(meta)),
              ...earn.map(v => v.populateStrategyVaults(meta)),
            ])
  - Clear all loading/updating flags. UI renders.

Phase 1+: chain-aware browser SDK loads in silent mode (resolved V3/onchain routing)
  - updateEVaults / updateEarnVaults / updateSecuritizeVaults
  - silent=true → loading/updating flags stay false
  - Vue reactivity overwrites entries in place as fresh data arrives
```

### Two-pass hydrate

Pass 2 uses `utils/sdk-vault-meta-stub.ts:buildRegistryMetaService(registry)` — an `IVaultMetaService` that only implements `fetchVault`, which returns a synchronous registry lookup wrapped in a resolved `ServiceResult`:

```ts
async fetchVault(_chainId, address) {
  return { result: registry.getVault(address), errors: [] }
}
```

The SDK's `populateCollaterals` and `populateStrategyVaults` only call `fetchVault`. Everything else they do (oracle adapter selection, `populated` flag bookkeeping, DataIssue collection) is local to `this`. Passing the registry-backed stub means populate runs purely in memory — no RPC — but produces correctly-wired cross-references that point at the same EVault instances registered in pass 1. Object identity is preserved, so Vue reactivity updates a collateral and its primary vault listing in lockstep.

Other methods on the stub (`fetchVaults`, `fetchVaultTypes`, etc.) throw — `populate*` doesn't reach them; if a future SDK release adds a populate path that does, the throw fires loudly.

### Hydrate failure modes

The hydrate falls through to the chain-aware browser SDK (driving loading flags normally) on any of:

- `$fetch` fails (HTTP error, network failure)
- `decodeBigints(wire)` produces a malformed shape (`isSerialisedSnapshot` returns false)
- `snap.chainId` doesn't match the requested chainId
- `snap.chainPolicy` is missing or differs from the browser's current policy
- A deprecated chain's snapshot contains no vaults
- `Date.now() - snap.fetchedAt > MAX_HYDRATION_AGE_MS` (6 min on the client; the server can serve snapshots up to 6 min old with V3 enabled, or 15 min otherwise)

The snapshot is optional. The browser SDK path still depends on its configured data sources being available.

## Warm-Cache Plugin

`server/plugins/warm-cache.ts` runs at Nitro startup and at intervals thereafter. Two timers, each with its own cadence:

```text
Global cycle (5 min)                   Vaults cycle (1 min if V3, else 5 min)
─────────────────────                  ──────────────────────────────────────
- Euler Chains, V3 catalog, runtime ABIs        - refreshChainVaults(chain) for each
- static source includes cross-chain assets     enabled non-deprecated chain
- per-chain Public Labels bundle
- per-chain labels snapshot
- per-chain token list
- per-chain liquidation bot coverage
  (when LIQUIDATION_BOT_API_URL is set)
```

Vault snapshot has its own faster timer because V3-backed refreshes are cheap — one batched POST per chain hitting V3's own cache. Pulling a fresh snapshot every minute keeps it tight without hammering upstream. Without V3, the snapshot is built from heavier onchain lens multicalls, so it falls back to the global 5-min cadence.

The global cycle warms labels and other shared inputs; only the vault cycle warms snapshots. Catalog warming calls `refreshV3ChainCatalog()` even when its cached entry is still fresh, and global warming continues when all configured chains are deprecated. Custom V3 and V3-disabled deployments skip the catalog fetch. In-flight dedup also coalesces a snapshot warm with a request-time refresh for the same chain and policy.

### Why warm directly (not via HTTP)

Every warm task is a **direct function call** (`refreshChainVaults(chainId)`, `refreshPublicLabelsBundle(...)`, `refreshLabelFile(...)`, etc.) that replaces the cache before expiry. The Public Labels and policy refreshers deduplicate concurrent work, while normal reads use the previous fresh value and failures can fall back only within the configured stale ceiling.

### Boot behaviour

Nitro's node-server preset calls `server.listen()` synchronously without awaiting plugins, so warming runs in the background. Caches are typically hot within ~5 s of boot. Users arriving before that pay the usual cold-upstream latency for whichever endpoints they hit (the cold-path branch in each handler handles it). Everyone after sees cached responses.

Per-chain selection also reads `deprecated` from the cached `EulerChains.json` (`getRegistryDeprecatedChainIds`). The first labels / token-list cycle and the first vaults cycle both `await` `firstManifestRead`: `refreshEulerChains()` raced against `UPSTREAM_FETCH_TIMEOUT_MS` (10 s). A failed or slow first read leaves the env `DEPRECATED_CHAINS` list unchanged rather than warming the wrong set or blocking boot. Later cycles re-read the cached manifest as before. See [Adding a Chain](./adding-a-chain.md#how-the-registry-status-shows-in-lite).

### Per-chain serialization

Chains are warmed sequentially, not in parallel. Cross-chain upstreams (DefiLlama, Pendle, etc.) dedupe via their own in-flight caches, so chains 2..N hit warm upstream caches rather than re-fetching. Parallel chain fan-out would trigger ~250 simultaneous HTTPS requests at cold boot (all chains × all upstream providers) and overshoot upstream timeouts on slow first-hit DNS/TLS handshakes.

## V3 Chain Catalog

`server/utils/v3-chain-catalog.ts` loads Euler's default V3 `GET /v3/chains` with the server-side API key. It treats the route as an unpaginated catalog and caches validated chain IDs with the `indexing` capability, independently of registry deprecation. Any pagination metadata supplied must describe a complete response; completeness fields are optional in the V3 contract. Health `status` and `labeling` are not retirement signals. A successful catalog without a chain, or without that chain's indexing capability, selects onchain routing; a valid empty catalog retires all enabled chains from V3 routing.

The cache is scoped by upstream and credentials, fresh for five minutes, and usable for at most 24 hours after its last successful fetch. Reads return a usable last-good entry immediately and schedule one background refresh when it is stale; only cold or expired entries wait for upstream. Periodic warming refreshes the catalog independently of requests. Refreshes coalesce and have a ten-second total budget including the response body; expiry aborts the underlying request and body consumption. HTTP errors, malformed rows and incomplete pagination preserve the last-good snapshot without extending its age; failures have a 30-second retry cooldown, including warm-cycle attempts. Late responses cannot overwrite a newer snapshot. Without a usable required catalog, policy reads return `503`, server data reads cannot select a policy, and open tabs retain their existing routing. Cold HTML marks admitted chains in `unresolvedChainIds` while catalog support is unknown. Chain-aware SDK reads wait for an authoritative policy; cached label verification, snapshot hydration and direct V3 reads remain unavailable until it resolves. Initial resolution advances policy and query-cache generations even when the routing flags match the env defaults. Mounted assessment consumers reload on their chain's policy generation changes.

The catalog is required for hosted labels or V3-backed data only when the normalized resolved base URL is `https://v3.euler.finance`. Custom hosts, ports or base paths (including proxies and staging services) skip catalog discovery, use the configured sources and `ONCHAIN_SDK_CHAINS`, and retain full hosted labels. They resolve policy as soon as the registry is available and do not inherit any cached Euler catalog. Static-label deployments with no configured V3 URL and no explicit `v3` source skip it, as do deployments with `DISABLE_V3=true`. Explicit `v3` sources use Euler's hosted default when the URL is unset. Registry admission, RPC provisioning and subgraph endpoint selection remain separate requirements.

## V3 Configuration Effects

Whether `V3_API_URL` (or aliases) is set changes how the default `fallback` adapter chain behaves on both the server (snapshot builder) and the browser (fast SDK):

| | V3 configured | V3 not configured |
|---|---|---|
| `enableV3Backend` (env) | `true` | `false` |
| Browser fast SDK (`NUXT_PUBLIC_BROWSER_VAULT_SOURCE=fallback`) | V3 primary → onchain secondary | `disableV3: true` → onchain only |
| Server snapshot builder (`SERVER_VAULT_CACHE_SOURCE=fallback`) | V3 primary → onchain secondary | `disableV3: true` → onchain lens multicalls |
| Vault snapshot TTL | 2 min | 5 min |
| Vault snapshot warm cadence | every 1 min | every 5 min |

Pinning either source to `onchain` selects RPC/subgraph account/vault/Earn reads. Browser rewards keep fallback routing, while server rewards use direct providers. Labels and optional V3 utilities remain independently configured; `DISABLE_V3=true` is the explicit deployment-wide opt-out. Global source settings do not hide direct V3 UI features; the resolved per-chain onchain list gates them through `useV3ChainGate`. Pinning to `v3` selects V3 without onchain fallback. An unset V3 URL resolves to Euler's hosted default, and a boot warning asks operators to configure their intended source explicitly.

With Euler's default V3, chains without catalog indexing support automatically use onchain account/vault/Earn adapters in chain-aware browser reads and server SDKs. Hosted labels use metadata-only verification for those chains; static labels retain authored membership. `ONCHAIN_SDK_CHAINS` adds explicit data overrides. Registry deprecation does not change data sources or label verification. The warm-cache plugin skips per-chain work for chains listed in `DEPRECATED_CHAINS` or marked `deprecated` in the cached registry.

Vault snapshots, labels views, public verification sets and public metadata separate cached and in-flight results by resolved chain policy. A refresh that observes a changed policy before publication rejects its result and cannot fall back across policies. Snapshot responses carry the policy; browser hydration rejects mismatches. `/api/internal/chain-policy` responses use `no-store` and update the selected chain's reactive browser policy even when labels fail; the underlying registry and V3 catalog each use shared five-minute caches and bounded stale fallback. V3 catalog support is usable for up to 24 hours after the last successful fetch; failures do not extend its age. Without usable required catalog support, server policy/data reads fail and open tabs keep their existing policy. Policy changes rebuild SDK instances, advance query generations and invalidate pending registry resolutions, category caches, vault loads and assessment stores. Labels must match the current policy before label-derived verification becomes available and vaults reload. Each SDK keeps its original policy namespace, preventing retained instances from writing results into the current policy cache.

Chains listed in `EVAULT_FETCH_CHUNK_CHAINS` split EVault list reads into small sequential SDK calls in both the browser loader and the server snapshot builder. This is a Lite-side throttle around SDK `eVaultService.fetchVaults` calls for chains whose RPC/lens path does not tolerate larger concurrent onchain EVault reads. It does not replace [server provider overrides](#server-provider-overrides): Sonic's Multicall byte cap is applied inside the server viem client, not by this env list.

The snapshot remains available in all modes (unless `DISABLE_SERVER_VAULT_CACHE=true`). Its account/vault/Earn source follows the server's resolved routing, including onchain overrides when V3 is configured. The browser receives the same wire format in each mode; refresh cost and data freshness depend on the selected sources.

## Configuration Flags Summary

| Env var | Side | Values | Default | Effect |
|---|---|---|---|---|
| `SERVER_VAULT_CACHE_SOURCE` | server | `fallback` \| `onchain` \| `v3` | `fallback` | Adapter chain in `server/utils/sdk-server.ts`; resolved onchain chains use `onchain`. |
| `NUXT_PUBLIC_BROWSER_VAULT_SOURCE` | browser (exposed) | `fallback` \| `onchain` \| `v3` | `fallback` | Adapter chain in `composables/useEulerSdk.ts:getEulerSdk()`. `getEulerSdkForChain(chainId)` uses `onchain` for chains retired by Euler's default V3 catalog and explicit onchain overrides. The "fresh" / plan-time SDK is always `onchain` regardless. |
| `DEPRECATED_CHAINS` | server + injected browser config | comma-separated chain ids | unset | Optional override for deprecated status. Enabled chains marked here or `deprecated` in `EulerChains.json` appear collapsed and skip per-chain warm-cache work. Deprecation does not change data routing or label verification. |
| `ONCHAIN_SDK_CHAINS` | server + injected browser config | comma-separated chain ids | unset | Additional chains pinned to onchain account/vault/Earn adapters. Euler's default V3 automatically includes chains without catalog indexing support; custom V3 uses the explicit list. Indexed overrides with hosted labels use the full V3 labels bundle, including verification and visibility, regardless of deprecation. Direct vault/oracle assessment reads are disabled for chains in this list. |
| `TURTLE_EARN_API_KEY` | server | Turtle Earn server key | unset | Passed to the server SDK as `rewardsTurtleApiKey` (and sent by the Turtle proxy). Unset or blank, the proxy answers 503 and the server SDK is built with `rewardsEnableTurtle: false`, which disables direct Turtle discovery only; V3-sourced Turtle campaigns may still be listed. |
| `EVAULT_FETCH_CHUNK_CHAINS` | server + injected browser config | comma-separated chain ids | unset | Chains whose EVault list reads are split into small sequential SDK calls in Lite. |
| `DISABLE_SERVER_VAULT_CACHE` | server | `true` \| `false` | `false` | When true: warm-cache skips the vault cycle, `/api/internal/vaults` returns 503, browser loads through its chain-aware SDK. |
| `V3_API_URL` *(plus aliases)* | server | URL | unset | Required upstream when any source ∈ `{fallback, v3}` actually needs V3. Boot warning fires when unset and a V3-requiring source is configured. |

## Verification

The repo includes `scripts/measure-lend-load.mjs` (Playwright) for time-to-first-paint measurement on `/lend`. Sample numbers:

| config | median time-to-5-rows |
|---|---|
| Pre-work baseline (no snapshot, V3 off, direct external calls) | 4.5 s |
| Snapshot pipeline, V3 off | ~1.0 s |
| Snapshot pipeline, V3 on | ~1.0 s |
| Production (development branch, snapshot + V3) | ~1.5 s |

Usage:

```bash
node scripts/measure-lend-load.mjs --url 'http://localhost:3000/lend?network=mainnet' --trials 4
# add --headed if upstream blocks headless chromium (e.g. Cloudflare interstitial)
```

To re-verify after changes, restart the dev server, wait for the warm cycle (~5 s), then run the script.
