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
6. **Directory-based Modules**: Large composables and entity files are split into focused modules within directories (e.g., `useEulerOperations/`, `entities/vault/`, `composables/repay/`). Each directory has an `index.ts` re-exporting the public API
7. **Centralized Error Handling**: `logWarn()` and `logError()` from `utils/errorHandling.ts` replace raw `console.warn`/`console.error` calls, enabling structured logging

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
│              ESLint (flat config) + Playwright (E2E)            │
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
│  │ /api/token  │ │ /api/pyth   │ │ /api/labels │                │
│  │ -list       │ │ /updates    │ │ /rpc/[chain]│                │
│  └─────────────┘ └─────────────┘ └─────────────┘                │
├─────────────────────────────────────────────────────────────────┤
│                    External Services                            │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                │
│  │ Euler API / │ │ EVM RPC     │ │ Merkl /     │                │
│  │ Pyth Hermes │ │ (multi-     │ │ Brevis /    │                │
│  │ / DefiLlama │ │  chain)     │ │ Fuul        │                │
│  └─────────────┘ └─────────────┘ └─────────────┘                │
└─────────────────────────────────────────────────────────────────┘
```

**Server-Side Proxy Layer**: External data sources (token lists, Pyth Hermes, labels, oracle checks, RPC) are proxied through Nuxt server endpoints rather than called directly from the browser. This provides caching, rate limiting, CORS avoidance, and keeps credentials server-side. See [Development Guide - Server-Side Data Proxies](./development-guide.md#server-side-data-proxies) for the full endpoint reference.

## 🔍 Explore Page & Market Discovery

The Explore page (`pages/explore/index.vue`) provides a market discovery interface that groups vaults into logical markets.

### Market Grouping Algorithm

The `useMarketGroups` composable (`composables/useMarketGroups.ts`) implements a hybrid grouping algorithm:

1. **Product-label groups** — Vaults are first assigned to groups using `products` metadata from euler-labels. Each product defines a curator entity, name, and list of vault addresses.
2. **Collateral graph augmentation** — For each group, external collateral vaults (referenced by member vaults but not in the group) are resolved and attached.
3. **Orphan clustering** — Vaults not assigned to any product are clustered using a BFS connected-component algorithm over their collateral relationships. This produces "Ungrouped" markets.
4. **Async TVL resolution** — Group metrics (TVL, available liquidity, borrowed) are resolved asynchronously using USD pricing.

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

### Page Keepalive Strategy

The app uses Vue's `<KeepAlive>` to preserve component state across navigation for listing pages:

```vue
<NuxtPage
  :keepalive="{ include: ['ExplorePage', 'EarnPage', 'LendPage', 'BorrowPage', 'PortfolioPage'] }"
/>
```

This prevents re-fetching and re-rendering when users navigate between listing pages and detail views (e.g., clicking a vault then pressing back). Suspense was removed from `app.vue` to avoid conflicts with keepalive cache invalidation.

### Optimization Strategies

1. **Code Splitting**: Automatic route-based code splitting
2. **Lazy Loading**: Components and composables loaded on demand
3. **Caching**: Smart caching of blockchain data and API responses. Asset prices are cached with TTL to avoid redundant RPC calls
4. **RPC Deduplication**: Concurrent RPC calls for the same data are deduplicated so only one request is made
5. **Batch Operations**: Batch API calls to reduce network overhead
6. **Debouncing**: User input and position refresh debouncing to prevent excessive API calls
7. **Keepalive**: Listing pages cached in memory to avoid redundant data loads
8. **Lazy Chart Loading**: Chart.js is lazy-loaded only when chart components are mounted. Chart colors are read from CSS custom properties via the `useThemeColors` composable (reads `document.body` computed styles, reactive to `useTheme()`), so charts automatically follow the theme
9. **Interval Cleanup**: All `setInterval` timers are properly cleaned up to prevent memory leaks
10. **shallowRef**: Collection data (arrays, maps) uses `shallowRef` instead of `ref` to avoid deep reactivity overhead

## 🔄 Swap & Slippage Behavior

### Slippage Settings

The `useSlippage` composable (`composables/useSlippage.ts`) manages swap slippage tolerance with two safety features:

- **24-hour expiry**: Custom slippage values above 0.5% automatically expire after 24 hours, reverting to the default. This prevents users from forgetting high slippage settings across sessions. Values at or below 0.5% never expire.
- **Stablecoin defaults**: Swaps between two stablecoins (detected by "USD" in the token symbol) default to 0.1% slippage instead of the general 0.5% default, reducing unnecessary losses on stable-to-stable pairs.

The composable accepts optional `fromSymbol`/`toSymbol` getters to detect stablecoin pairs reactively. Slippage state is persisted to `localStorage` with a timestamp for expiry tracking.

## 🔒 Security Architecture

### Security Measures

1. **Input Validation**: Strict input validation and sanitization
2. **Type Safety**: TypeScript prevents many runtime errors
3. **Secure Communication**: HTTPS for all external communications
4. **Wallet Security**: Secure wallet connection and transaction signing
5. **Error Handling**: Secure error messages that don't leak sensitive information

### Server-Side API Protection

The Nuxt server layer (`server/api/`) proxies requests to external services (RPC nodes, Tenderly, TRM) to keep operator API keys out of client bundles. Several layers protect these endpoints:

| Layer | Purpose |
|---|---|
| **CORS** (`server/middleware/cors.ts`) | Restricts API access to configured origins |
| **Body size limits** (`server/middleware/body-limit.ts`) | Caps request payloads (1 MB RPC, 2 MB Tenderly) |
| **Geo-blocking** (`server/middleware/geo-gate.ts`) | Blocks sanctioned countries via Cloudflare `CF-IPCountry`; fails closed (HTTP 451) if country is undetermined in prod |
| **RPC method whitelist** (`server/api/rpc/[chainId].ts`) | Only 15 safe read-only methods are proxied |
| **Rate limiting** (`server/utils/rate-limit.ts`) | Per-IP cost-based budgets (see below); fails closed (HTTP 403) if `CF-Connecting-IP` is absent in prod |
| **Swap verifier validation** (`utils/swap-validation.ts`) | Validates swap verifier addresses against known config |

#### Rate Limiting

The app includes a built-in per-IP rate limiter as a defense-in-depth measure. Default budgets per 60-second window:

- **RPC proxy**: 10,000 units (batch of N costs N)
- **All other proxies**: 1,000 requests (token list, Pyth updates, labels, oracle adapter, euler chains, intrinsic APY, TOS)
- **Tenderly simulate**: 10 requests
- **Address screening**: 10 requests

**Wallet screening fail-closed**: `server/api/screen-address.post.ts` proxies address checks to the TRM API (configured via `WALLET_SCREENING_URI`). If the env var is not set, or the TRM API returns an error or times out, the endpoint returns `addressIsSuspicious: true` — the app fails closed rather than open. Operators must set `WALLET_SCREENING_URI` or all users will be treated as suspicious.

**Important**: This is a best-effort safeguard, not a security boundary. It catches accidental abuse (e.g. a client stuck in a retry loop) but will not stop a determined attacker. Known limitations:

- **In-memory state is per-process** — if Nitro spawns multiple workers, each gets its own budget, effectively multiplying the limit.

#### Cloudflare Requirement

**Production deployments must be behind Cloudflare.** This is a hard requirement, not a recommendation — two independent server features depend on it:

1. **Geo-gate** (`server/middleware/geo-gate.ts`) reads `CF-IPCountry` to enforce sanctioned-country blocks. Without Cloudflare, the country cannot be determined and all API requests are rejected with HTTP 451.
2. **Rate limiter** (`server/utils/rate-limit.ts`) uses `CF-Connecting-IP` as the trusted client IP. Without Cloudflare, `CF-Connecting-IP` is absent and all API requests are rejected with HTTP 403.

Bypass behaviour per environment:

| Environment | Geo-gate | Rate limiter |
|---|---|---|
| `prd` | CF required; fail-closed (HTTP 451) if absent. `DEV_GEO_COUNTRY` bypasses fail-closed if set. | CF required; fail-closed (HTTP 403) if absent. |
| `stg` | CF required; fail-closed (HTTP 451) if absent. `DEV_GEO_COUNTRY` bypasses fail-closed if set. | CF **not** required; falls back to `X-Forwarded-For`. |
| `dev` | CF not required; falls back to `DEV_GEO_COUNTRY`, then allows through if unset. | CF not required; falls back to `X-Forwarded-For`. |

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
