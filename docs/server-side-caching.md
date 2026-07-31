# Server-Side Caching

Lite ships a layered cache between the browser and every external data source — third-party reward APIs, the Goldsky subgraph, the labels repo, the Euler V3 backend, and the chain RPC. The layer accomplishes four things:

1. **Cross-tab sharing.** Every browser session against the same origin hits the same in-process cache.
2. **Authentication / credentials stay server-side.** Browsers don't need V3 API keys, subgraph project IDs, or any provider tokens.
3. **CORS avoidance.** Most upstreams don't set permissive CORS; same-origin proxying sidesteps the issue.
4. **First-paint amortization.** A consolidated vault snapshot is built every minute and served directly to `/lend`, so first paint is one HTTP fetch instead of a fan-out of per-vault calls.

This document covers the per-host proxies, the vault snapshot pipeline, the warm-cache plugin, and how V3 configuration changes the cadence.

## Files at a Glance

| File | Purpose |
|------|---------|
| `server/utils/external-proxy.ts` | Shared forwarder: TTL cache, in-flight dedup, stale-on-error fallback. One helper used by all per-host proxies. |
| `server/api/internal/proxy/merkl/[...path].ts` | Proxies Merkl v4 (`api.merkl.xyz/v4`) |
| `server/api/internal/proxy/fuul/[...path].ts` | Proxies Fuul (`api.fuul.xyz/api/v1`) |
| `server/api/internal/proxy/incentra/[...path].ts` | Proxies Incentra / Brevis (`incentra-prd.brevis.network`) |
| `server/api/internal/proxy/subgraph/[chainId].post.ts` | Proxies the per-chain Goldsky subgraph |
| `server/api/internal/labels/[file].get.ts` | Query-shape labels endpoint (`?chainId=X`) — used internally |
| `server/api/internal/labels/[chainId]/[file].get.ts` | Path-shape labels endpoint — matches the SDK's default URL template |
| `server/api/internal/v3/[...path].ts` | Rate-limited V3 backend proxy for SDK browser endpoints (`/api/internal/v3/...` → `v3.euler.finance/v3/...`) |
| `server/api/internal/vaults.get.ts` | Per-chain consolidated vault snapshot endpoint |
| `server/utils/vaults-cache.ts` | `refreshChainVaults` + `vaultsCache` |
| `server/utils/sdk-server.ts` | Lazy per-chain server-side SDK builder |
| `server/plugins/warm-cache.ts` | Boot + interval warm cycles for labels, token-list, vault snapshot |
| `utils/snapshot-codec.ts` | Bigint-safe JSON wire format |
| `utils/snapshot-types.ts` | Wire-shape types shared client + server |
| `utils/sdk-vault-meta-stub.ts` | Registry-backed `IVaultMetaService` for the client-side hydration two-pass |
| `composables/useVaults.ts:hydrateFromServer` | Browser-side snapshot hydrate |

## Per-Host Proxies

Each per-host proxy follows the same shape — `external-proxy.ts` provides the helpers, the per-host file declares its allowlist, upstream URL, and cache TTL.

### Shared helper (`server/utils/external-proxy.ts`)

```ts
const cache    = createProxyCache(TTL_MS)        // wraps createTtlCache<string>
const inFlight = createProxyInFlight()           // InFlightDedup<string, string>

await forwardProxied({
  cache, inFlight,
  method, target, headers, body,
  ctx: 'fuul-proxy',
})
// → { status, contentType, body, cacheState: 'hit' | 'miss' | 'stale-fallback' }
```

Cache key is `sha1(method + '\0' + target + '\0' + body)`. Concurrent misses share one upstream request. On upstream failure the helper serves the stale entry within the TTL ceiling (`2 × ttlMs` capped at 30 min); past that, the error propagates.

### Per-host config

| Endpoint | Upstream | Env override | Allowlist | Methods | Browser cache hint |
|---|---|---|---|---|---|
| `/api/internal/proxy/fuul/{...}` | `api.fuul.xyz/api/v1` | `FUUL_API_URL` / `NUXT_PUBLIC_FUUL_API_URL` | `incentives`, `totals`, `claim-checks`, `rewards` | GET, HEAD, POST | `public, max-age=30, swr=30` |
| `/api/internal/proxy/incentra/{...}` | `incentra-prd.brevis.network` | `INCENTRA_API_URL` / `NUXT_PUBLIC_INCENTRA_API_URL` | `sdk/v1/`, `v1/` | GET, HEAD, POST | `public, max-age=30, swr=30` |
| `/api/internal/proxy/subgraph/{chainId}` | per-chain Goldsky URL | `SUBGRAPH_URL_<chainId>` (server-only) or `NUXT_PUBLIC_SUBGRAPH_URI_<chainId>` | (POST only — chain-level guard) | POST | `public, max-age=30, swr=30` |
| `/api/internal/proxy/merkl/{...}` | `api.merkl.xyz/v4` | (none) | `opportunities`, `users`, `campaigns` | GET, HEAD | `public, max-age=60` |

Each proxy carries a rate limiter (`createRateLimiter`) and returns 405 for disallowed methods, 404 for paths outside the allowlist, 502 on upstream errors when no stale entry exists. The `x-cache: hit | miss | stale-fallback` response header reports the cache state for observability.

### Why route through these proxies

- **Fuul, Incentra/Brevis**: provider APIs don't set permissive CORS; direct browser fetches fail. Pre-proxying also lets us share one warm response across every connected wallet.
- **Goldsky subgraph**: Each chain's URL is a per-deployment Goldsky deployment ID. Proxying keeps the project ID server-side and amortizes GraphQL responses across tabs.
- **Merkl**: CORS, plus credential handling.

### Labels

Two endpoints, same `refreshLabelFile` engine and one shared in-memory TTL cache:

- **`/api/internal/labels/{file}?chainId=N`** (`[file].get.ts`) — query-shape, used by internal callers (`labels-helpers.ts`). Reads through: a fresh `cache.get()` hit short-circuits (and the `assets.json` union uses `getOrRefresh`).
- **`/api/internal/labels/{chainId}/{file}`** (`[chainId]/[file].get.ts`) — path-shape, matches the SDK's default `eulerLabelsBaseUrl` template (`${base}/{chainId}/{file}.json`). The SDK is pointed at `/api/internal/labels`, so default templates land here. This handler calls `refreshLabelFile` directly, which **bypasses the fresh-entry check** and only collapses work while a fetch is already in flight. Every path-shape request therefore reaches upstream unless it coincides with an in-flight fetch for the same key; the warm-cache entry acts as a stale fallback on this route rather than as a read-through cache. Treat that as a known divergence from the shared read-through pipeline the path handler's header comment describes.

Upstream is resolved by `NUXT_PUBLIC_CONFIG_LABELS_BASE_URL` if set, else `NUXT_PUBLIC_CONFIG_LABELS_REPO` + `NUXT_PUBLIC_CONFIG_LABELS_REPO_BRANCH` → GitHub raw.

### V3 proxy

`/api/internal/v3/{...path}` is a deliberately narrow same-origin proxy for browser-side SDK V3 calls and a few Lite-owned chart endpoints. It normalizes browser paths to `/v3/...`, validates the exact path/method allowlist, consumes a local rate-limit budget, injects the server-side V3 API key when configured, and forwards only JSON-safe headers to the upstream V3 API. Query strings and POST bodies are forwarded unchanged after the route/method check; V3 remains responsible for domain-level validation.

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
| `/v3/evk/vaults/open-interest` | Open interest by vault/collateral query. |
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
| V3-only charts or bad-debt sections are hidden | `useV3ChainGate()` requires `enableV3Backend` and excludes chains listed in `ONCHAIN_SDK_CHAINS`. Exposure displays can fall back to RPC-derived qualitative data, but bad debt and history have no on-chain equivalent. |

## Vault Snapshot Pipeline

The largest win in this layer. The server pre-computes a consolidated snapshot of every public vault on a chain (~50–400 vaults depending on chain) and serves it from a fast TTL cache. The browser hydrates the registry from this single fetch on `/lend`, then runs a silent RPC refresh in the background. Time-to-first-paint goes from ~3.4 s (no snapshot, V3 off) to ~1.0 s.

### Server side

`server/utils/vaults-cache.ts:refreshChainVaults(chainId)` is the single refresh path. Used by:

- **`server/plugins/warm-cache.ts`**: every minute (V3 configured) or every 5 minutes (V3 off), per-chain.
- **`server/api/internal/vaults.get.ts`**: cold-path fallback when the cache is genuinely empty (process just started, before the first warm cycle completed). Steady-state, the handler is a pure read.

Pipeline:

```text
1. getServerSdk(chainId)          // lazy per-chain server SDK; reused across requests
2. getLabels(chainId)             // verified addresses, earn vaults (read via refreshLabelFile)
3. sdk.eVaultService.fetchVerifiedVaultAddresses(chainId, [ESCROW])   // escrow set
4. sdk.vaultMetaService.fetchVaultTypes(chainId, candidates)          // partition EVK vs Securitize vs Earn
5. Promise.all([
     sdk.eVaultService.fetchVaults(evkAddrs, opts),
     sdk.eulerEarnService.fetchVaults(earnAddrs, opts),
     sdk.securitizeVaultService.fetchVaults(securitizeAddrs, opts),
     sdk.eVaultService.fetchVaults(escrowAddrs, opts),
   ])
6. encodeBigints(payload)         // tag bigints as { __bi: "<decimal>" }
7. vaultsCache.set(String(chainId), payload)
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

`server/utils/sdk-server.ts:getServerSdk(chainId)` builds one SDK per chain, cached at module scope. The adapter chain is selected by `SERVER_VAULT_CACHE_SOURCE` (default `fallback`):

| Value | Behavior |
|---|---|
| `fallback` *(default)* | V3 primary, on-chain secondary. With V3 configured: cheap/fast batched fetches. Without V3: `disableV3: true` short-circuits the fallback chain so the snapshot is built from onchain lens multicalls (slower but authoritative). |
| `onchain` | Direct on-chain reads only — bypasses V3 entirely regardless of `V3_API_URL`. |
| `v3` | V3 only; SDK build throws when no V3 endpoint is configured. |

A boot-time warning fires if `SERVER_VAULT_CACHE_SOURCE` (or `NUXT_PUBLIC_BROWSER_VAULT_SOURCE`) needs V3 but `V3_API_URL` is unset — see `utils/api-url-env.ts:warnIfVaultSourceNeedsV3`.

`labels-view.ts` shares the same `getServerSdk` instance per chain.

### Disabling the snapshot

Set `DISABLE_SERVER_VAULT_CACHE=true` to:

- Skip the vault warm-cache cycle in `warm-cache.ts` (the labels / token-list / chains cycle still runs).
- Make `/api/internal/vaults?chainId=N` respond `503 Vault snapshot disabled`.

The browser's snapshot hydrate (`hydrateFromServer`) treats the 503 as a hydrate failure and falls through to the normal RPC pipeline — visually identical to the cold-snapshot path, just always taken. Useful when the host can't afford the snapshot's outbound V3/RPC fan-out, or when bot-management throttles bursty origin traffic.

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

- Returns the cached snapshot (5-min TTL with V3 off, 2-min TTL with V3 on). Stale ceiling 30 min.
- `vaultsCache.get(...) ?? vaultsCache.getStale(...)` — handler never triggers a refresh on its own.
- Cold-path fallback (empty cache): synchronously awaits `refreshChainVaults`. In-flight dedup collapses concurrent cold requests.
- Response header: `Cache-Control: public, max-age=30, stale-while-revalidate=30`.

### Browser side

`composables/useVaults.ts:loadVaults()` runs in two phases:

```text
Phase 0: hydrateFromServer(chainId, generation)
  - $fetch('/api/internal/vaults?chainId=N')
  - decodeBigints(wire)
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

Phase 1+: existing RPC pipeline in silent mode
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

The hydrate falls through to the RPC pipeline (driving loading flags normally) on any of:

- `$fetch` fails (HTTP error, network failure)
- `decodeBigints(wire)` produces a malformed shape (`isSerialisedSnapshot` returns false)
- `snap.chainId` doesn't match the requested chainId
- `Date.now() - snap.fetchedAt > MAX_HYDRATION_AGE_MS` (6 min stale ceiling on the client side, looser than the server's 5 min so warm-cycle hiccups don't immediately disable hydration)

The pipeline always succeeds eventually — the snapshot is the *fast path*, not a hard dependency.

## Warm-Cache Plugin

`server/plugins/warm-cache.ts` runs at Nitro startup and at intervals thereafter. Two timers, each with its own cadence:

```text
Global cycle (5 min)                   Vaults cycle (1 min if V3, else 5 min)
─────────────────────                  ──────────────────────────────────────
- /api/internal/euler-chains                    - refreshChainVaults(chain) for each
- labels/all/assets.json                 enabled non-deprecated chain,
- per-chain:                             sequential (lets cross-chain V3
    labels/{file}.json (×5)              upstreams dedupe via in-flight)
    /api/internal/token-list
```

Vault snapshot has its own faster timer because V3-backed refreshes are cheap — one batched POST per chain hitting V3's own cache. Pulling a fresh snapshot every minute keeps it tight without hammering upstream. Without V3, the snapshot is built from heavier onchain lens multicalls, so it falls back to the global 5-min cadence.

When the two intervals are equal (V3 off), the timers naturally double-warm at every 5-min boundary; the in-flight dedup inside `refreshChainVaults` collapses the concurrent calls onto a single upstream pass.

### Why warm directly (not via HTTP)

Every warm task is a **direct function call** (`refreshChainVaults(chainId)`, `refreshLabelFile(...)`, etc.) that bypasses the handler's fresh-cache short-circuit and writes straight to the cache. If we warm via HTTP, the handler short-circuits on the still-fresh previous entry (age ≈ TTL − 2 s) and the entry then expires without refresh until the next cycle — leaving a stale window per cycle. Direct calls ensure the entry is always rewritten *before* it expires.

User requests arriving during a refresh continue to read the still-fresh previous entry via the handler's own `cache.get()` short-circuit when that handler actually short-circuits — the vault snapshot endpoint and the query-shape labels endpoint. The path-shape labels endpoint calls `refreshLabelFile` instead of reading through, so a concurrent request there joins the in-flight refresh rather than being served the previous entry (see [Labels](#labels)).

### Boot behaviour

Nitro's node-server preset calls `server.listen()` synchronously without awaiting plugins, so warming runs in the background. Caches are typically hot within ~5 s of boot. Users arriving before that pay the usual cold-upstream latency for whichever endpoints they hit (the cold-path branch in each handler handles it). Everyone after sees cached responses.

### Per-chain serialization

Chains are warmed sequentially, not in parallel. Cross-chain upstreams (DefiLlama, Pendle, etc.) dedupe via their own in-flight caches, so chains 2..N hit warm upstream caches rather than re-fetching. Parallel chain fan-out would trigger ~250 simultaneous HTTPS requests at cold boot (all chains × all upstream providers) and overshoot upstream timeouts on slow first-hit DNS/TLS handshakes.

## V3 Configuration Effects

Whether `V3_API_URL` (or aliases) is set changes how the default `fallback` adapter chain behaves on both the server (snapshot builder) and the browser (fast SDK):

| | V3 configured | V3 not configured |
|---|---|---|
| `enableV3Backend` (env) | `true` | `false` |
| Browser fast SDK (`NUXT_PUBLIC_BROWSER_VAULT_SOURCE=fallback`) | V3 primary → onchain secondary | `disableV3: true` → onchain only |
| Server snapshot builder (`SERVER_VAULT_CACHE_SOURCE=fallback`) | V3 primary → onchain secondary | `disableV3: true` → onchain lens multicalls |
| Vault snapshot TTL | 2 min | 5 min |
| Vault snapshot warm cadence | every 1 min | every 5 min |

Pinning either source to `onchain` ignores V3 even when `V3_API_URL` is set. Pinning to `v3` requires `V3_API_URL` — the SDK build throws otherwise, and the boot warning surfaces this misconfiguration before warming starts.

Chains listed in `ONCHAIN_SDK_CHAINS` use onchain adapters for chain-aware browser SDK reads and server snapshot builds, so regular chains continue to follow the configured V3/fallback source while pinned chains avoid V3-backed account/vault/Earn reads. Independently, the warm-cache plugin skips per-chain warm work for chains listed in `DEPRECATED_CHAINS`; deprecated chains whose V3 data is gone should typically also be listed in `ONCHAIN_SDK_CHAINS`.

Chains listed in `EVAULT_FETCH_CHUNK_CHAINS` split EVault list reads into small sequential SDK calls in both the browser loader and the server snapshot builder. This is a Lite-side throttle around SDK `eVaultService.fetchVaults` calls for chains whose RPC/lens path does not tolerate larger concurrent onchain EVault reads.

The snapshot remains active in all modes (unless `DISABLE_SERVER_VAULT_CACHE=true`). With V3 the snapshot is built quickly from V3's batched endpoints; without V3 it's built from onchain lens multicalls. Either way the browser sees the same wire-format payload and benefits identically.

## Configuration Flags Summary

| Env var | Side | Values | Default | Effect |
|---|---|---|---|---|
| `SERVER_VAULT_CACHE_SOURCE` | server | `fallback` \| `onchain` \| `v3` | `fallback` | Adapter chain in `server/utils/sdk-server.ts`; `ONCHAIN_SDK_CHAINS` chains use `onchain`. |
| `NUXT_PUBLIC_BROWSER_VAULT_SOURCE` | browser (exposed) | `fallback` \| `onchain` \| `v3` | `fallback` | Adapter chain in `composables/useEulerSdk.ts:getEulerSdk()`. `getEulerSdkForChain(chainId)` uses `onchain` for `ONCHAIN_SDK_CHAINS` chains. The "fresh" / plan-time SDK is always `onchain` regardless. |
| `DEPRECATED_CHAINS` | server + injected browser config | comma-separated chain ids | unset | Chains shown collapsed in the chain selector and skipped by per-chain warm-cache work. |
| `ONCHAIN_SDK_CHAINS` | server + injected browser config | comma-separated chain ids | unset | Chains pinned to onchain adapters in chain-aware browser SDK reads and server snapshot builds. |
| `EVAULT_FETCH_CHUNK_CHAINS` | server + injected browser config | comma-separated chain ids | unset | Chains whose EVault list reads are split into small sequential SDK calls in Lite. |
| `DISABLE_SERVER_VAULT_CACHE` | server | `true` \| `false` | `false` | When true: warm-cache skips the vault cycle, `/api/internal/vaults` returns 503, browser falls through to RPC pipeline. |
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
