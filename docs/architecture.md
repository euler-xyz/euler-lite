# Architecture Overview

This document provides an overview of the Euler Lite system architecture, including the high-level design, component structure, and key architectural decisions.

## 🏗️ High-Level System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     User Interface Layer                        │
├─────────────────────────────────────────────────────────────────┤
│                    Application Logic Layer                      │
├─────────────────────────────────────────────────────────────────┤
│                      Integration Layer                          │
├─────────────────────────────────────────────────────────────────┤
│                    External Services Layer                      │
└─────────────────────────────────────────────────────────────────┘
```

### System Layers

1. **User Interface Layer**: Vue components, pages, and UI elements
2. **Application Logic Layer**: Composables, business logic, and state management
3. **Integration Layer**: API clients, blockchain interactions, and external service adapters
4. **External Services Layer**: Euler Finance, EVM chains, and third-party APIs

## 🧩 Component Architecture

### Vue 3 Composition API Pattern

The application follows Vue 3's Composition API pattern, organizing code into logical, reusable composables:

```
┌─────────────────────────────────────────────────────────────────┐
│                           Pages                                 │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                │
│  │   Index     │ │   Borrow    │ │  Portfolio  │                │
│  └─────────────┘ └─────────────┘ └─────────────┘                │
├─────────────────────────────────────────────────────────────────┤
│                        Components                               │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                │
│  │   Layout    │ │    Vault    │ │    UI       │                │
│  └─────────────┘ └─────────────┘ └─────────────┘                │
├─────────────────────────────────────────────────────────────────┤
│                        Composables                              │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                │
│  │ useVaults   │ │useEulerAcct │ │ useWallets  │                │
│  └─────────────┘ └─────────────┘ └─────────────┘                │
├─────────────────────────────────────────────────────────────────┤
│                        Entities                                 │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                │
│  │   Vault     │ │   Account   │ │  Rewards    │                │
│  └─────────────┘ └─────────────┘ └─────────────┘                │
└─────────────────────────────────────────────────────────────────┘
```

### Key Architectural Principles

1. **Separation of Concerns**: Clear separation between UI, business logic, and data
2. **Composability**: Reusable composables for shared functionality
3. **Type Safety**: Full TypeScript integration for better development experience
4. **Reactive State**: Vue 3 reactivity system for state management
5. **Modular Design**: Well-defined boundaries between different system parts
6. **Directory-based Modules**: Large composables and UI workflow helpers are split into focused modules within directories (e.g., `utils/vault/`, `composables/repay/`). Protocol transaction planning flows through `useEulerTx.ts`, and SDK entities are imported directly from `@eulerxyz/euler-v2-sdk`
7. **Structured Logging**: a single `logger` API from `~/utils/logger` (console-backed shim, used by shared code) and `~/server/utils/logger` (pino, JSON to stdout for BetterStack on Fargate). Errors passed in `err` are summarised by `~/utils/viem-errors` so viem's `abi` / `metaMessages` / hex request bodies never leak. `~/utils/errorHandling` exposes a small `logWarn` helper for the long tail of client-side call sites; it routes through the same shared logger

## 🔄 Data Flow Architecture

### Unidirectional Data Flow

```
┌─────────────┐    ┌─────────────┐     ┌─────────────┐
│   External  │───▶│ Composables │───▶ │ Components  │
│   Services  │    │             │     │             │
└─────────────┘    └─────────────┘     └─────────────┘
       ▲                   │                   │
       │                   ▼                   ▼
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Entities  │◀───│   State     │◀───│   UI State  │
│             │    │ Management  │    │             │
└─────────────┘    └─────────────┘    └─────────────┘
```

### Data Flow Patterns

1. **External Data Fetching**: Composables fetch data from external services
2. **State Transformation**: Raw data is transformed into application entities
3. **Reactive Updates**: UI automatically updates when state changes
4. **Caching Strategy**: Smart caching to minimize API calls
5. **Error Handling**: Graceful error handling with user feedback

## 🏛️ Technology Architecture

### Frontend Framework Stack

```
┌─────────────────────────────────────────────────────────────────┐
│                        Nuxt.js 3                                │
├─────────────────────────────────────────────────────────────────┤
│                    Vue 3 + Composition API                      │
├─────────────────────────────────────────────────────────────────┤
│                    TypeScript + SCSS                            │
├─────────────────────────────────────────────────────────────────┤
│         ESLint (flat config) + Vitest (unit/integration)        │
├─────────────────────────────────────────────────────────────────┤
│          simple-git-hooks + lint-staged (pre-commit)            │
└─────────────────────────────────────────────────────────────────┘
```

### Blockchain Integration Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Wagmi / Reown                                │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                │
│  │ useWagmi    │ │ Reown       │ │ Wallet      │                │
│  │             │ │ AppKit      │ │ Connect     │                │
│  └─────────────┘ └─────────────┘ └─────────────┘                │
├─────────────────────────────────────────────────────────────────┤
│                    EVM (Viem + Multicall)                       │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                │
│  │ EVC Batch   │ │ Pyth Oracle │ │ Simulation  │                │
│  └─────────────┘ └─────────────┘ └─────────────┘                │
├─────────────────────────────────────────────────────────────────┤
│                    Euler Finance                                │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                │
│  │ Vault Lens  │ │ Account     │ │ Interest    │                │
│  │             │ │ Lens        │ │ Rate Model  │                │
│  └─────────────┘ └─────────────┘ └─────────────┘                │
└─────────────────────────────────────────────────────────────────┘
```

## 🎯 Key Architectural Decisions

### 1. Nuxt.js 3 Framework

**Why Nuxt.js 3?**

- **SSR Disabled**: Client-side only SPA, SSR is not needed
- **Auto-imports**: Reduces boilerplate and improves developer experience
- **File-based Routing**: Simple and intuitive routing system
- **Built-in Optimizations**: Automatic code splitting and optimization

### 2. Composition API Pattern

**Why Composition API?**

- **Better Logic Reuse**: Composables can be shared across components
- **TypeScript Support**: Better type inference and type safety
- **Tree-shaking**: Unused code can be eliminated during build

### 3. Composable-based State Management

**Why Composables over Pinia?**

- **Lightweight**: No additional state management library needed
- **Vue Native**: Built into Vue 3, no external dependencies
- **Flexibility**: Can implement custom state management patterns
- **Performance**: Direct Vue reactivity, no additional overhead

### 4. TypeScript Integration

**Why TypeScript?**

- **Type Safety**: Catches errors at compile time
- **Better IDE Support**: Enhanced autocomplete and refactoring
- **Documentation**: Types serve as living documentation
- **Team Collaboration**: Easier for multiple developers to work together

## 🔌 Integration Architecture

### External Service Integration Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│                        Application                              │
├─────────────────────────────────────────────────────────────────┤
│                    Integration Layer                            │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                │
│  │ Wagmi/Viem  │ │ Rewards API │ │ Composables │                │
│  │ Client      │ │ Client      │ │             │                │
│  └─────────────┘ └─────────────┘ └─────────────┘                │
├─────────────────────────────────────────────────────────────────┤
│              Server-Side Proxy Layer (Nuxt server/)             │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                │
│  │ /api/internal│ │ /api/internal/pyth   │ │ /api/internal/labels │                │
│  │ /token-list │ │ /updates    │ │ /rpc/[chain]│                │
│  └─────────────┘ └─────────────┘ └─────────────┘                │
├─────────────────────────────────────────────────────────────────┤
│                    External Services                            │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                │
│  │ Euler V3 /  │ │ EVM RPC     │ │ Merkl /     │                │
│  │ Pyth Hermes │ │ (multi-     │ │ Brevis /    │                │
│  │ / DefiLlama │ │  chain)     │ │ Fuul        │                │
│  └─────────────┘ └─────────────┘ └─────────────┘                │
└─────────────────────────────────────────────────────────────────┘
```

**Server-Side Proxy Layer**: External data sources (token lists, Pyth Hermes, labels, oracle checks, RPC) are proxied through Nuxt server endpoints rather than called directly from the browser. This provides caching, rate limiting, CORS avoidance, and keeps credentials server-side. Vault reads use the Euler SDK from the client layer. See [Development Guide - Server-Side Data Proxies](./development-guide.md#server-side-data-proxies) for the full endpoint reference.

**Proxy cache strategy**:

| Endpoint | TTL | Notes |
|----------|-----|-------|
| `/api/internal/labels/{file}` | 5 min | Query-shape labels endpoint (`?chainId=N`); used internally by Lite helpers. 404 → empty shape; stale-fallback on upstream error |
| `/api/internal/labels/{chainId}/{file}` | 5 min | Path-shape labels endpoint matching the SDK's default `eulerLabelsBaseUrl` template; shares the underlying cache with the query-shape route |
| `/api/internal/token-list` | 5 min | Four sources merged via `Promise.allSettled` (Euler SDK, DefiLlama, Uniswap, Merkl); per-source cache with stale fallback |
| `/api/internal/oracle-adapter` | 5 min | Lazy per-address fetch |
| `/api/internal/euler-chains` | 5 min | Static chain-agnostic config from `euler-interfaces` repo. 7-day stale window so a running instance outlives upstream outages |
| `/api/internal/abis/{contract}` | 5 min | Runtime ABI documents from `euler-interfaces` (`AccountLens`/`VaultLens`/`UtilsLens` allowlist; SDK `setQueryABI` target). Same 7-day stale window as euler-chains |
| `/api/internal/vaults` | 2 min (V3) / 5 min (no V3) | Pre-computed chain vault snapshot. Handler is read-only — no request-triggered refresh; warm-cache rewrites at the same cadence as the TTL |
| `/api/internal/proxy/merkl/{path}` | 60 s | Same-origin proxy to Merkl v4; path allowlist; GET/HEAD only |
| `/api/internal/proxy/fuul/{path}` | 30 s | Same-origin proxy to Fuul; path allowlist; GET/HEAD/POST |
| `/api/internal/proxy/incentra/{path}` | 30 s | Same-origin proxy to Incentra/Brevis; path allowlist; GET/HEAD/POST |
| `/api/internal/proxy/subgraph/{chainId}` | 30 s | Same-origin proxy to per-chain Goldsky subgraph; POST only |
| `/api/internal/v3/{...path}` | request-scoped | Rate-limited proxy for the exact SDK browser V3 endpoint allowlist; no TTL — V3 manages its own caching |

Every cacheable proxy above uses the same pattern: TTL cache for fresh hits, stale-cache fallback on upstream failure, and in-flight request deduplication so concurrent cache-miss callers (e.g. warm-cache racing real traffic) collapse onto a single upstream fetch per cache key. The in-flight dedup pattern itself is a shared util — `createInFlightDedup` / `scheduleBackgroundRefresh` in `server/utils/in-flight.ts`. The per-host proxies (`/api/internal/proxy/{merkl,fuul,incentra,subgraph}`) share a common forwarder at `server/utils/external-proxy.ts`.

`server/plugins/warm-cache.ts` pre-populates labels and token-list for every enabled chain, plus `/api/internal/euler-chains` and the runtime ABI manifests once globally, on a 5-min cycle. The vault snapshot runs on its own faster timer (1 min when V3 is configured, 5 min otherwise) so V3-backed refreshes stay tight without hammering upstream. Every warm task is a **direct function call** to a `refreshX()` that bypasses the handler's fresh-cache short-circuit and writes straight to the cache. This matters: if warm cycled via HTTP, the handler would short-circuit on the still-fresh entry from the previous cycle (age ≈ TTL − 2 s) and the entry would then expire with no refresh until the next cycle — leaving a stale window per cycle. With direct refresh calls, the cache is always rewritten while the previous entry is still serving live traffic, so user requests arriving during a refresh continue to read the fresh previous entry (no blocking on the in-flight refresh). Warming runs fire-and-forget so Nitro's listener is never delayed; caches are typically hot within ~5 s of boot, and users arriving before that just pay the usual cold-upstream latency for whichever endpoints they hit.

For the full setup — per-host proxies, vault snapshot pipeline, two-pass client hydration, V3-conditional cadence, and the bigint wire codec — see [Server-Side Caching](./server-side-caching.md).

### Vault snapshot pipeline

`/api/internal/vaults?chainId=X` serves a pre-computed snapshot of the public vault set for a chain: every EVault, Earn vault, Securitize vault, and referenced escrow vault, with all on-chain state (caps, rates, LTV matrices, oracle prices) already resolved. Per-user data (balances, positions, collateral flags) is **not** in this snapshot — the client fetches it separately after wallet connect via `useEulerAccount`.

The client composable `useVaults.loadVaults()` runs in two phases:

1. **Hydrate** (`~100 ms`): `$fetch('/api/internal/vaults?chainId=X')`, deserialise via the bigint codec, instantiate each vault into its SDK class (`new EVault(args)` etc.), then run `populateCollaterals` / `populateStrategyVaults` against a registry-backed `IVaultMetaService` stub (`utils/sdk-vault-meta-stub.ts`) so cross-references resolve to the same EVault instances already in the registry (no RPC). Flip `isReady=true`; UI renders a fully populated `borrowList` immediately.
2. **Fresh RPC pass** (`~3-6 s`): the existing batched lens pipeline (`fetchVaults`/`fetchEarnVaults`/`fetchSecuritizeVault`/`fetchEscrowVault`) runs against the client's RPC with Pyth simulation, overwriting registry entries with live prices and rates in silent mode (loading flags stay false).

The public interface of `useVaults()` is unchanged — the 15 exports (`isReady`, `borrowList`, `getVault`, etc.) keep their names, types, and semantics. Vault entities are SDK-owned (`EVault`, `EulerEarn`, `SecuritizeCollateralVault`), while Lite keeps UI-only categorization, LTV, APY, collateral discovery, and presentation helpers under `utils/vault/`.

The wire payload uses the bigint codec at `utils/snapshot-codec.ts`: bigints serialise as `{ __bi: "<decimal>" }` (object-wrapper tag, unforgeable by adversary-controlled ERC-20 metadata). The server-side SDK builder at `server/utils/sdk-server.ts` instantiates one `EulerSDK` per chain (lazy, cached at module scope) with the default `'fallback'` adapter chain — V3 primary, onchain secondary when V3 is configured; pure onchain otherwise.

### Reward campaign and claim pipeline

Reward APRs and account claimable rewards are SDK-owned data. Lite reads reward campaigns through SDK-populated vault entities and reads claimable user rewards from `portfolio.account.userRewards`. Claim plans are built through `sdk.rewardsService.buildClaimPlan(s)` and executed as SDK `TransactionPlan` items through `useEulerTx()`.

The SDK's default rewards adapter reads V3 reward APIs and uses direct provider reads where V3 does not expose claim-specific helper data. Lite's provider feature flags are passed into SDK config as `rewardsEnableMerkl`, `rewardsEnableBrevis`, and `rewardsEnableFuul` only when a provider is disabled. Display formatting, provider labels, sorting, and transaction review remain in Lite.

## 🔍 Explore Page & Market Discovery

The Explore page (`pages/explore/index.vue`) provides a market discovery interface that groups vaults into logical markets.

### Market Grouping Algorithm

The `useMarketGroups` composable (`composables/useMarketGroups.ts`) implements a hybrid grouping algorithm:

1. **Product-label groups** — Vaults are first assigned to groups using `products` metadata from euler-labels. Each product defines a curator entity, name, and list of vault addresses.
2. **Collateral graph augmentation** — For each group, external collateral vaults (referenced by member vaults but not in the group) are resolved and attached.
3. **Orphan clustering** — Vaults not assigned to any product are clustered using a BFS connected-component algorithm over their collateral relationships. This produces "Ungrouped" markets.
4. **Async TVL resolution** — Group metrics (TVL, available liquidity, borrowed) are resolved asynchronously using USD pricing.

### Correlated Pairs, Max ROE, and Max Multiplier

Leveraged return metrics are only shown when the collateral and debt assets are treated as price-correlated. The source of truth is token-list metadata: `useTokenList().getTokenCategoryTags(address)` returns normalized `tags`, and `utils/token-categories.ts` only considers tags present in `CORRELATED_CATEGORY_LABELS` (`usd`, `eth`, `btc`, `mon`, `avax`, `hype`, `bnb`).

Correlation rules:

- **Pair-level**: `areTokenAddressesCorrelatedByTags()` returns true when both assets share an allowlisted category tag, or when they are the same asset address.
- **Portfolio-level**: `areRoeCollateralVaultsCorrelatedWithBorrow()` requires every resolved collateral asset and the borrow asset to share one allowlisted category.
- **Math**: `utils/leverage.ts` delegates max multiplier and max ROE formulas to the SDK, then adds looping rewards flat because those rewards are paid per unit of equity rather than scaled by leverage.

The correlation decision is shared across discovery, borrow, and portfolio surfaces:

| Surface | Correlated assets | Uncorrelated assets |
|---|---|---|
| Explore market card (`useBestMaxROE`) | Best Max ROE across eligible LTV pairs | Best visible Net APY fallback |
| Explore matrix (`DiscoveryMarketMatrix.vue`) | Numeric cells in `roe` and `multiplier` views | `-` cell with unavailable-metric tooltip and accordion notice |
| Borrow pair card (`VaultBorrowItem.vue`) | Max ROE headline, correlated-category badge, Max multiplier column, Multiply tab link | Net APY headline; multiplier column and Multiply tab shortcut are hidden |
| Portfolio borrow card (`PortfolioBorrowItem.vue`) | Position ROE when all collateral vaults resolve and share the category | Net APY path |

Borrow-page collateral and debt filters reuse the same category metadata. `pages/borrow/index.vue` builds quick-filter values such as `category:usd` from tags present in the active pair list, and matching accepts either an explicit token address or a category match via `tokenAddressMatchesCategoryFilter()`.

### Key Types

- `MarketGroup` — Core group with vaults, external collateral, metrics, and curator info
- `MarketGroupMetrics` — TVL, best APYs, utilization, vault counts, asset symbols
- `CuratorGroup` — Groups `MarketGroup`s by curator entity for aggregated views

### Custom Filters

The listing pages (Lend, Borrow, Earn, Explore) support user-defined metric filters via the `useCustomFilters` composable:

- `UiCustomFilterModal` — Modal for creating filters with metric, operator (gt/lt), and value
- `UiCustomFilterChips` — Displays active filters as removable chips
- Filters are applied client-side using `matchesCustomFilters(item)`

## 🚀 Performance Architecture

### Page KeepAlive Strategy

The app uses Vue's `<KeepAlive>` to preserve component state across navigation for listing pages:

```vue
<NuxtPage
  :keepalive="{ include: ['ExplorePage', 'EarnPage', 'LendPage', 'BorrowPage', 'PortfolioPage'] }"
/>
```

This prevents re-fetching and re-rendering when users navigate between listing pages and detail views (e.g., clicking a vault then pressing back). `app.vue` keeps route rendering outside Suspense to avoid conflicts with keepalive cache invalidation.

### Optimization Strategies

1. **Code Splitting**: Automatic route-based code splitting
2. **Lazy Loading**: Components and composables loaded on demand
3. **Caching**: Smart caching of blockchain data and API responses. Asset prices are cached with TTL to avoid redundant RPC calls
4. **RPC Deduplication**: Concurrent RPC calls for the same data are deduplicated so only one request is made
5. **Batch Operations**: Batch API calls to reduce network overhead
6. **Debouncing**: User input and position refresh debouncing to prevent excessive API calls
7. **KeepAlive**: Listing pages cached in memory to avoid redundant data loads
8. **Lazy Chart Loading**: Chart.js is lazy-loaded only when chart components are mounted. Chart colors are read from CSS custom properties via the `useThemeColors` composable (reads `document.body` computed styles, reactive to `useTheme()`), so charts automatically follow the theme
9. **Interval Cleanup**: All `setInterval` timers are properly cleaned up to prevent memory leaks
10. **shallowRef**: Collection data (arrays, maps) uses `shallowRef` instead of `ref` to avoid deep reactivity overhead

## 🔄 Swap & Slippage Behavior

### Slippage Settings

The `useSlippage` composable (`composables/useSlippage.ts`) manages swap slippage tolerance with two safety features:

- **24-hour expiry**: Custom slippage values above 0.3% automatically expire after 24 hours, reverting to the default. This prevents users from forgetting high slippage settings across sessions. Values at or below 0.3% never expire.
- **Stablecoin defaults**: Swaps between two stablecoins (detected by "USD" in the token symbol) default to 0.05% slippage instead of the general 0.3% default, reducing unnecessary losses on stable-to-stable pairs.

The composable accepts optional `fromSymbol`/`toSymbol` getters to detect stablecoin pairs reactively. Slippage state is persisted to `localStorage` with a timestamp for expiry tracking.

## 🔒 Security Architecture

### Security Measures

1. **Input Validation**: Strict input validation and sanitization
2. **Type Safety**: TypeScript prevents many runtime errors
3. **Secure Communication**: HTTPS for all external communications
4. **Wallet Security**: Secure wallet connection and transaction signing
5. **Error Handling**: Secure error messages that don't leak sensitive information

### Server-Side API Protection

The Nuxt server layer (`server/api/`) proxies requests to external services (RPC nodes, Tenderly, the compliance screening API) to keep operator API keys out of client bundles. Several layers protect these endpoints:

| Layer | Purpose |
|---|---|
| **CORS** (`server/middleware/cors.ts`) | Restricts API access to configured origins |
| **Body size limits** (`server/middleware/body-limit.ts`) | Caps request payloads (1 MB RPC, 2 MB Tenderly) |
| **Geo-blocking** (`server/middleware/geo-gate.ts`) | Blocks sanctioned countries via the edge-provided country (`getEdgeContext`); fails closed (HTTP 451) if a geo-capable edge leaves the country undetermined outside dev |
| **RPC method whitelist** (`server/api/internal/rpc/[chainId].ts`) | Only 15 safe read-only methods are proxied |
| **Rate limiting** (`server/utils/rate-limit.ts`) | Per-IP cost-based budgets (see below); fails closed (HTTP 403) if the edge provides no trusted client identity in prod |
| **Swap quote contract validation** (`@eulerxyz/euler-v2-sdk` `swapService`) | Validates each fetched quote's swapper and verifier addresses against the chain's canonical deployment allowlist |

#### Rate Limiting

The app includes a built-in per-IP rate limiter as a defense-in-depth measure. Default budgets per 60-second window:

- **RPC proxy**: 10,000 units (batch of N costs N)
- **All other proxies**: 1,000 requests (token list, Pyth updates, labels, oracle adapter, euler chains, intrinsic APY, TOS)
- **Tenderly simulate**: 10 requests
- **Address screening**: 10 requests

**Wallet screening fail-closed**: `server/api/internal/screen-address.post.ts` proxies address checks to the data-v3 compliance API (configured via `ADDRESS_SCREENING_URI` + `ADDRESS_SCREENING_API_KEY`; the shared upstream logic lives in `server/utils/screening.ts`). With BOTH env vars unset the deployment is treated as having no screening provider (a fork, typically) and every address passes — except in production (`DOPPLER_ENVIRONMENT=prd`, the same convention the CORS/geo/rate middleware use), where an absent configuration is a failed secret injection rather than an opt-out and screening fails closed. Once either var is set, the path is fail-closed: partial configuration, a non-https `ADDRESS_SCREENING_URI` (plain http is tolerated for localhost/127.0.0.1 only — the restricted key must not travel without TLS), upstream errors, timeouts, redirects, address-mismatched or malformed verdicts all return `addressIsSuspicious: true`. Operators of screened deployments must therefore set both vars — and be aware that removing both silently disables screening, production refuses to run unscreened, and non-production monitoring can watch the screening-disabled log line. The route is also consumed cross-origin by first-party `*.euler.finance` SPAs that have no server of their own — `server/middleware/cors.ts` carries a CORS exception scoped to exactly this path, so no other internal route is exposed to sibling apps. It deliberately stays under `/api/internal/` (not `/api/public/`): the consumers are our own apps, and the public prefix would advertise it to external integrators. Because of these external first-party consumers, changes to this route's request/response contract must stay backward-compatible.

**Important**: This is a best-effort safeguard, not a security boundary. It catches accidental abuse (e.g. a client stuck in a retry loop) but will not stop a determined attacker. Known limitations:

- **In-memory state is per-process** — if Nitro spawns multiple workers, each gets its own budget, effectively multiplying the limit.

#### Edge Provider

The server never reads vendor edge headers directly. `getEdgeContext(event)` (`server/utils/edge.ts`) normalizes whatever the fronting infrastructure provides into a single shape — trusted client IP, country, VPN evidence, origin-auth status — and every consumer (geo-gate, rate limiter, CORS country hint, screening audit) reads that. The vendor-specific header mapping lives exclusively in `utils/edge-presets.ts`, selected by the `EDGE_PROVIDER` env var:

| Preset | Trusted client IP | Country | VPN evidence |
|---|---|---|---|
| `cloudflare` | `cf-connecting-ip` | `cf-ipcountry` | `x-is-vpn` / `x-is-proxy-or-vpn` |
| `google` | `x-forwarded-for` second-to-last entry (LB-appended) | `x-client-geo` (LB custom header) | — |
| `cloudfront` | `cloudfront-viewer-address` (port stripped) | `cloudfront-viewer-country` | — |
| `none` (default) | rightmost `x-forwarded-for` entry, else socket | — | — |

**Production deployments must set `EDGE_PROVIDER` explicitly** — the server refuses to boot in `prd` without it (`server/plugins/edge-guard.ts`), because the `none` default runs with geo-blocking off. `none` is intended for forks and previews that have no fronting edge.

**Origin auth** (`EDGE_ORIGIN_SECRET`): when set, every request must carry a matching `x-edge-origin-auth` header, stamped by the edge (e.g. a request-header transform rule). Requests without it are treated as having bypassed the edge: their trusted inputs are voided and the fail-closed paths below apply. The secret is optional for the `cloudflare` and `none` presets — until it is set, the edge headers are trusted on the historical assumption that the origin is only reachable through the edge. It is **required** for `google` and `cloudfront` (the server refuses to boot without it): those edges forward client headers untouched, so without origin auth their trusted inputs would be forgeable by anyone who can reach the origin. Configuring the secret is what closes direct-to-origin spoofing in every preset.

**Internal fetches** (`server/utils/internal-headers.ts`): server-internal `$fetch` calls (warm-cache, vaults-cache, labels) authenticate with an `x-edge-internal` marker whose value is the origin-auth secret or, when none is configured, a random per-process value — unforgeable under every preset with zero configuration. The container healthcheck does not use it: it probes `/healthz`, which lives outside `/api/` and is deliberately independent of edge configuration.

Fail-closed behaviour per environment (geo-capable presets):

| Environment | Geo-gate | Rate limiter |
|---|---|---|
| `prd` | Country required; fail-closed (HTTP 451) if undetermined. `DEV_GEO_COUNTRY` bypasses fail-closed if set. | Trusted identity required; fail-closed (HTTP 403) if absent. |
| `stg` | Country required; fail-closed (HTTP 451) if undetermined. `DEV_GEO_COUNTRY` bypasses fail-closed if set. | Trusted identity **not** required; falls back to `X-Forwarded-For`. |
| `dev` | Country not required; falls back to `DEV_GEO_COUNTRY`, then allows through if unset. | Trusted identity not required; falls back to `X-Forwarded-For`. |

Under the `none` preset the geo-gate does not fail closed (there is no geo evidence by design) and the rate limiter keys budgets on the rightmost `x-forwarded-for` entry.

### Clickjacking & Framing Defenses

The app is a wallet-bearing DeFi interface. Loading it inside an attacker-controlled `<iframe>` could let the attacker overlay invisible elements on top of transaction approval buttons (UI-redressing / clickjacking). Four independent layers prevent this, following a defense-in-depth model:

| Layer | Mechanism | Implementation |
|---|---|---|
| **HTTP header — legacy** | `X-Frame-Options: DENY` | `server/middleware/security-headers.ts` |
| **HTTP header — modern** | `Content-Security-Policy: frame-ancestors 'none'` | `server/plugins/csp.ts` |
| **HTTP header — opener isolation** | `Cross-Origin-Opener-Policy: same-origin-allow-popups` | `server/middleware/security-headers.ts` |
| **Inline script — last resort** | JS frame-busting: hides the page and navigates `window.top` | `server/plugins/00-anti-clickjack.ts` |

**Why all four?**

- `X-Frame-Options` is the universally-supported legacy header; some older user agents or edge workers only check this one.
- `frame-ancestors 'none'` is the modern CSP equivalent and takes precedence in browsers that support CSP Level 2+. It is set alongside `X-Frame-Options` for belt-and-suspenders coverage.
- `Cross-Origin-Opener-Policy: same-origin-allow-popups` prevents a cross-origin page from retaining a `window.opener` reference to ours after the user navigates away. `same-origin-allow-popups` (rather than `same-origin`) is the strictest value that still allows Reown AppKit and Coinbase Wallet SDK to open wallet connection popups.
- The inline script is the last line of defense in case a CDN, edge worker, or proxy strips the headers. It detects `window.self !== window.top`, hides the document root immediately, and attempts `window.top.location` navigation. Because `csp.ts` runs after `00-anti-clickjack.ts` in alphabetical Nitro plugin order, every `<script>` in `html.head` (including this one) already has a per-request CSP nonce injected before the response is sent.

**Wallet popup compatibility**

`COOP: same-origin` would fully isolate the browsing context but breaks popup-based wallet connection flows (Reown AppKit, Coinbase Wallet SDK). `same-origin-allow-popups` is the correct trade-off: it isolates the opener reference from cross-origin navigations while preserving same-origin popup handles.

**Regression coverage**

`tests/server/security.test.ts` locks in all four layers with pure-function unit tests (no Nitro boot required). The tests assert that `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy`, and the frame-busting script content cannot silently regress. Do not weaken these assertions without reviewing the threat model above.

## 📱 Mobile-First Architecture

### Responsive Design Principles

1. **Mobile-First**: Design starts with mobile and scales up
2. **Touch-Friendly**: Optimized for touch interactions
3. **Performance**: Optimized for mobile network conditions

## 🔄 State Management Architecture

### State Organization

```
┌─────────────────────────────────────────────────────────────────┐
│                        Global State                             │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                │
│  │ User State  │ │ App State   │ │ Config      │                │
│  │ (Wallet)    │ │ (UI)        │ │ State       │                │
│  └─────────────┘ └─────────────┘ └─────────────┘                │
├─────────────────────────────────────────────────────────────────┤
│                      Feature State                              │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                │
│  │ Vaults      │ │ Portfolio   │ │ Rewards     │                │
│  │ State       │ │ State       │ │ State       │                │
│  └─────────────┘ └─────────────┘ └─────────────┘                │
└─────────────────────────────────────────────────────────────────┘
```

### State Management Patterns

1. **Reactive References**: `ref()` and `shallowRef()` for state (`shallowRef` for collections to avoid deep reactivity overhead)
2. **Computed Properties**: `computed()` for derived state
3. **Watchers**: `watch()` and `watchEffect()` for side effects
4. **State Persistence**: Local storage for user preferences
5. **Race Guards**: `createRaceGuard()` utility prevents stale async operations from overwriting fresh data. Used extensively in `watchEffect` patterns where rapid chain/account switching can cause race conditions
6. **Reactive Maps**: `useReactiveMap()` composable encapsulates the race-guarded async watchEffect pattern for keyed async data loading

---

_Next: Learn about the [Project Structure](./project-structure.md) to understand how this architecture is implemented in the codebase._
