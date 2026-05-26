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
| `server/api/proxy/merkl/[...path].ts` | Proxies Merkl v4 (`api.merkl.xyz/v4`) |
| `server/api/proxy/fuul/[...path].ts` | Proxies Fuul (`api.fuul.xyz/api/v1`) |
| `server/api/proxy/incentra/[...path].ts` | Proxies Incentra / Brevis (`incentra-prd.brevis.network`) |
| `server/api/proxy/subgraph/[chainId].post.ts` | Proxies the per-chain Goldsky subgraph |
| `server/api/labels/[file].get.ts` | Query-shape labels endpoint (`?chainId=X`) — used internally |
| `server/api/labels/[chainId]/[file].get.ts` | Path-shape labels endpoint — matches the SDK's default URL template |
| `server/api/v3/[...path].ts` | Rate-limited V3 backend proxy for SDK browser endpoints (`/api/v3` → `v3.euler.finance/v3`) |
| `server/api/vaults.get.ts` | Per-chain consolidated vault snapshot endpoint |
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
| `/api/proxy/fuul/{...}` | `api.fuul.xyz/api/v1` | `FUUL_API_URL` / `NUXT_PUBLIC_FUUL_API_URL` | `incentives`, `totals`, `claim-checks`, `rewards` | GET, HEAD, POST | `public, max-age=30, swr=30` |
| `/api/proxy/incentra/{...}` | `incentra-prd.brevis.network` | `INCENTRA_API_URL` / `NUXT_PUBLIC_INCENTRA_API_URL` | `sdk/v1/`, `v1/` | GET, HEAD, POST | `public, max-age=30, swr=30` |
| `/api/proxy/subgraph/{chainId}` | per-chain Goldsky URL | `SUBGRAPH_URL_<chainId>` (server-only) or `NUXT_PUBLIC_SUBGRAPH_URI_<chainId>` | (POST only — chain-level guard) | POST | `public, max-age=30, swr=30` |
| `/api/proxy/merkl/{...}` | `api.merkl.xyz/v4` | (none) | `opportunities`, `users`, `campaigns` | GET, HEAD | `public, max-age=60` |

Each proxy carries a rate limiter (`createRateLimiter`) and returns 405 for disallowed methods, 404 for paths outside the allowlist, 502 on upstream errors when no stale entry exists. The `x-cache: hit | miss | stale-fallback` response header reports the cache state for observability.

### Why route through these proxies

- **Fuul, Incentra/Brevis**: provider APIs don't set permissive CORS; direct browser fetches fail. Pre-proxying also lets us share one warm response across every connected wallet.
- **Goldsky subgraph**: Each chain's URL is a per-deployment Goldsky deployment ID. Proxying keeps the project ID server-side and amortizes GraphQL responses across tabs.
- **Merkl**: CORS, plus credential handling.

### Labels

Two endpoints, same `refreshLabelFile` engine:

- **`/api/labels/{file}?chainId=N`** (`[file].get.ts`) — query-shape, used by internal callers (`labels-helpers.ts`).
- **`/api/labels/{chainId}/{file}`** (`[chainId]/[file].get.ts`) — path-shape, matches the SDK's default `eulerLabelsBaseUrl` template (`${base}/{chainId}/{file}.json`). The SDK is pointed at `/api/labels`, default templates land here.

Both endpoints share the same in-memory TTL cache. Upstream is resolved by `NUXT_PUBLIC_CONFIG_LABELS_BASE_URL` if set, else `NUXT_PUBLIC_CONFIG_LABELS_REPO` + `NUXT_PUBLIC_CONFIG_LABELS_REPO_BRANCH` → GitHub raw.

### V3 proxy

`/api/v3/{...path}` forwards only the SDK browser endpoints Lite needs. It accepts `GET` for token, price, APY, reward, account-position, and vault-read endpoints, and `POST` for the SDK vault batch and vault resolve endpoints. The route consumes a local rate-limit budget before forwarding (`GET` costs 1, `POST` costs 5), injects the server-side V3 API key when configured, and forwards only fixed JSON headers to upstream. Query strings and JSON bodies are left for V3 to validate.

## Vault Snapshot Pipeline

The largest win in this layer. The server pre-computes a consolidated snapshot of every public vault on a chain (~50–400 vaults depending on chain) and serves it from a fast TTL cache. The browser hydrates the registry from this single fetch on `/lend`, then runs a silent RPC refresh in the background. Time-to-first-paint goes from ~3.4 s (no snapshot, V3 off) to ~1.0 s.

### Server side

`server/utils/vaults-cache.ts:refreshChainVaults(chainId)` is the single refresh path. Used by:

- **`server/plugins/warm-cache.ts`**: every minute (V3 configured) or every 5 minutes (V3 off), per-chain.
- **`server/api/vaults.get.ts`**: cold-path fallback when the cache is genuinely empty (process just started, before the first warm cycle completed). Steady-state, the handler is a pure read.

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
- Make `/api/vaults?chainId=N` respond `503 Vault snapshot disabled`.

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

`GET /api/vaults?chainId=N`:

- Returns the cached snapshot (5-min TTL with V3 off, 2-min TTL with V3 on). Stale ceiling 30 min.
- `vaultsCache.get(...) ?? vaultsCache.getStale(...)` — handler never triggers a refresh on its own.
- Cold-path fallback (empty cache): synchronously awaits `refreshChainVaults`. In-flight dedup collapses concurrent cold requests.
- Response header: `Cache-Control: public, max-age=30, stale-while-revalidate=30`.

### Browser side

`composables/useVaults.ts:loadVaults()` runs in two phases:

```text
Phase 0: hydrateFromServer(chainId, generation)
  - $fetch('/api/vaults?chainId=N')
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
- /api/euler-chains                    - refreshChainVaults(chain) for each
- labels/all/assets.json                 enabled non-deprecated chain,
- per-chain:                             sequential (lets cross-chain V3
    labels/{file}.json (×5)              upstreams dedupe via in-flight)
    /api/token-list
```

Vault snapshot has its own faster timer because V3-backed refreshes are cheap — one batched POST per chain hitting V3's own cache. Pulling a fresh snapshot every minute keeps it tight without hammering upstream. Without V3, the snapshot is built from heavier onchain lens multicalls, so it falls back to the global 5-min cadence.

When the two intervals are equal (V3 off), the timers naturally double-warm at every 5-min boundary; the in-flight dedup inside `refreshChainVaults` collapses the concurrent calls onto a single upstream pass.

### Why warm directly (not via HTTP)

Every warm task is a **direct function call** (`refreshChainVaults(chainId)`, `refreshLabelFile(...)`, etc.) that bypasses the handler's fresh-cache short-circuit and writes straight to the cache. If we warm via HTTP, the handler short-circuits on the still-fresh previous entry (age ≈ TTL − 2 s) and the entry then expires without refresh until the next cycle — leaving a stale window per cycle. Direct calls ensure the entry is always rewritten *before* it expires.

User requests arriving during a refresh continue to read the still-fresh previous entry via the handler's own `cache.get()` short-circuit, so there's no blocking on the in-flight refresh.

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

The snapshot remains active in all modes (unless `DISABLE_SERVER_VAULT_CACHE=true`). With V3 the snapshot is built quickly from V3's batched endpoints; without V3 it's built from onchain lens multicalls. Either way the browser sees the same wire-format payload and benefits identically.

## Configuration Flags Summary

| Env var | Side | Values | Default | Effect |
|---|---|---|---|---|
| `SERVER_VAULT_CACHE_SOURCE` | server | `fallback` \| `onchain` \| `v3` | `fallback` | Adapter chain in `server/utils/sdk-server.ts`. |
| `NUXT_PUBLIC_BROWSER_VAULT_SOURCE` | browser (exposed) | `fallback` \| `onchain` \| `v3` | `fallback` | Adapter chain in `composables/useEulerSdk.ts:getEulerSdk()`. The "fresh" / plan-time SDK is always `onchain` regardless. |
| `DISABLE_SERVER_VAULT_CACHE` | server | `true` \| `false` | `false` | When true: warm-cache skips the vault cycle, `/api/vaults` returns 503, browser falls through to RPC pipeline. |
| `V3_API_URL` *(plus aliases)* | server | URL | unset | Required upstream when any source ∈ `{fallback, v3}` actually needs V3. Boot warning fires when unset and a V3-requiring source is configured.

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
