# Development Guide

This guide covers the concrete steps and scripts needed to work on this repository.

## Prerequisites

- Node.js 24+
- npm

## Install and run

```bash
npm ci
npm run dev
```

Available scripts (from `package.json`):

- `dev` – start Nuxt in development
- `build` – production build
- `preview` – preview the production build
- `generate` – generate static site (requires a running backend; data proxy endpoints are not available in static-only deployments)
- `lint` – run ESLint on the entire project
- `lint:fix` – run ESLint with auto-fix
- `typecheck` – run Nuxt type checking (`nuxt typecheck`)
- `postinstall` – `nuxt prepare && simple-git-hooks`

## Linting & Pre-commit Hooks

The project uses a production-grade ESLint configuration (`eslint.config.mjs`) with `simple-git-hooks` and `lint-staged` for pre-commit enforcement:

- **Pre-commit hook**: Automatically runs `lint-staged` on staged files before each commit
- **Lint-staged**: Runs `eslint --fix` on staged `.ts`, `.vue`, and `.mjs` files
- **ESLint config**: Flat config format with Vue + TypeScript rules

Run linting manually:

```bash
npm run lint          # Check for lint errors
npm run lint:fix      # Auto-fix lint errors
npm run typecheck     # Type-check the project
```

## Continuous Integration

Pull requests are gated by the `CI` workflow (`.github/workflows/ci.yaml`), which runs on Node 24 (matching the Dockerfile) with npm caching:

- **typecheck** – `npm run typecheck` (blocking)
- **test** – `npm run build` then `npm run test:run` (blocking). The build runs first because `tests/utils/logger-bundle.test.ts` inspects the production client bundle (`.output/public/_nuxt`) and hard-fails under CI when it is absent.
- **lint** – `npm run lint` (blocking)

Run the same checks locally before opening a PR:

```bash
npm run lint
npm run typecheck
npm run build       # required so the logger-bundle test can inspect .output
CI=true npm run test:run
```

## Project configuration

- Nuxt config: `nuxt.config.ts`
  - Modules, SSR disabled, CSS, SVG sprite, runtimeConfig, dev server HTTPS, Vite SCSS additionalData.
- TypeScript config: `tsconfig.json`
- ESLint config: `eslint.config.mjs` (flat config format)
- Tests: `vitest.config.ts` + `tests/**/*.test.ts`
- Git hooks: `simple-git-hooks` + `lint-staged` (configured in `package.json`)

## Environment variables

Configuration is split into three mechanisms:

1. **`useEnvConfig()`** (`composables/useEnvConfig.ts`) — API URLs, Pyth, Reown, branding, and deployment announcements. Injected at runtime via `server/plugins/app-config.ts` into `window.__APP_CONFIG__`, with Nuxt public runtime config as a fallback when the injected config is unavailable. Browser V3 data services use the same-origin `/api/internal/v3` proxy. The proxy reads `V3_API_URL`, `EULER_SDK_V3_API_URL`, or `NUXT_PUBLIC_V3_API_URL` for the upstream URL and `EULER_SDK_V3_API_KEY` for the optional server-side API key.

2. **Nuxt `runtimeConfig`** (`useDeployConfig()`) — social links, feature flags, and static deployment fallbacks. Set via `NUXT_PUBLIC_CONFIG_*` env vars. The temporary visibility/geo compatibility policy is server-only and configured through `EFFECTIVE_POLICY_*`; display content comes from Public Labels V3. Explicit chain and ABI URLs configure their respective upstream sources.

3. **Chain config** (`useChainConfig()`) — derived dynamically from `RPC_URL_<chainId>` env vars at server startup, injected via `window.__CHAIN_CONFIG__`.

See the [README](../README.md) for the full env var reference.

Dev HTTPS: `HTTPS_KEY`, `HTTPS_CERT` (optional).

Announcement modal content is read at server startup from `CONFIG_ANNOUNCEMENT_TITLE`, `CONFIG_ANNOUNCEMENT_BODY`, `CONFIG_ANNOUNCEMENT_ITEMS`, and `CONFIG_ANNOUNCEMENT_URL`, falling back to the corresponding `NUXT_PUBLIC_CONFIG_ANNOUNCEMENT_*` names. The prefixed names also populate the public runtime config fallback. See [Announcement Modal](./announcement-modal.md) for examples, dismissal behavior, and URL constraints.

## Server-Side Data Proxies

External metadata (contract addresses, labels, and Data V3 oracle assessments) is fetched through Nuxt server proxy endpoints rather than directly from upstream hosts.

| Endpoint | Upstream source | Cache TTL | Env var override |
|----------|----------------|-----------|------------------|
| `GET /api/internal/euler-chains` | `EulerChains.json` from `EULER_SDK_EULER_INTERFACES_BRANCH` (`master`) | 5 min, 7-day stale window | `NUXT_PUBLIC_CONFIG_EULER_CHAINS_URL` (takes precedence over the branch vars) |
| `GET /api/internal/abis/:contract` | `abis/{contract}.json` from euler-interfaces (allowlist: `AccountLens`, `VaultLens`, `UtilsLens`; SDK `setQueryABI` target) | 5 min, 7-day stale window | `NUXT_PUBLIC_CONFIG_EULER_ABIS_BASE_URL` (takes precedence over the branch vars) |
| `GET /api/internal/public-labels?chainId=X&version=latest` | Versioned Public Labels V3 content plus the temporary effective-policy overlay | 5 min server cache; 30 s browser/CDN | `V3_API_URL`, optional `EULER_SDK_V3_API_KEY`; `EFFECTIVE_POLICY_BASE_URL` for policy only |
| `GET /api/internal/token-list?chainId=X` | Euler V3 + Uniswap + DefiLlama + Merkl reward-tokens | 5 min | `V3_API_URL`, `EULER_SDK_V3_API_URL`, `NUXT_PUBLIC_V3_API_URL`, `EULER_SDK_V3_API_KEY`, `NUXT_PUBLIC_CONFIG_UNISWAP_TOKEN_LIST_URL`, `NUXT_PUBLIC_CONFIG_DEFILLAMA_TOKEN_LIST_URL` |
| `GET /api/internal/vaults?chainId=X` | Pre-computed chain vault snapshot built by the server-side SDK | 2 min (V3 configured) / 5 min (no V3) | `V3_API_URL`, `EULER_SDK_V3_API_URL`, `NUXT_PUBLIC_V3_API_URL` (presence selects cadence); `TURTLE_EARN_API_KEY` (server SDK sends it to Turtle for stream discovery; direct Turtle discovery disabled without it; V3-sourced campaigns can remain) |
| `/api/internal/proxy/{merkl,fuul,incentra,turtle}/:path` | Rewards providers, one `createProviderProxy` config each — methods, allowlists, TTLs and credentials are tabulated in [Server-Side Caching → Per-Host Proxies](./server-side-caching.md#per-host-proxies) | 60 s (Turtle: not cached, `no-store`) | `FUUL_API_URL`, `INCENTRA_API_URL` (+ `NUXT_PUBLIC_` variants); `MERKL_API_KEY` (optional), `TURTLE_EARN_API_KEY` (required, server-only) |
| `POST /api/internal/proxy/subgraph/:chainId` | Per-chain Goldsky subgraph | not cached (`bypassCache`), `no-store` | `SUBGRAPH_URL_<chainId>` (server-only) or `NUXT_PUBLIC_SUBGRAPH_URI_<chainId>` |
| `GET\|HEAD /api/internal/proxy/intrinsic-apy-overrides?chainId=` | Lite HyperEVM / Monad intrinsic-APY overlay (fixed origin URLs in the handler) | 5 min, keyed by `chainId` only | — |
| `GET\|POST /api/internal/v3/...path` | Exact SDK-owned V3 endpoint allowlist (`tokens`, `prices`, APYs, rewards, oracle assessments/router state, account positions, activity/liquidations, vault reads, vault batch/resolve) | none — forwards upstream; `503` during failure backoff | `V3_API_URL`, `EULER_SDK_V3_API_URL`, `NUXT_PUBLIC_V3_API_URL`, `EULER_SDK_V3_API_KEY` |
| `POST /api/internal/screen-address` | data-v3 `POST /v3/compliance/address-screening` (connect-time wallet screen; first-party CORS exception) | no-store | `ADDRESS_SCREENING_URI`, `ADDRESS_SCREENING_API_KEY` |
| `GET /api/internal/pyth/updates?ids[]=...` | Pyth Hermes (`https://hermes.pyth.network/v2/updates/price/latest`) | No cache | `PYTH_API_KEY` (server-only) |

All listed endpoints use rate limiting. Local-TTL endpoints (everything in the table except `/api/internal/v3/...`, `/api/internal/proxy/turtle/:path`, `/api/internal/proxy/subgraph/:chainId`, `/api/internal/pyth/updates`, `/api/internal/proxy/intrinsic-apy-overrides`, and `/api/internal/screen-address`) return stale cached data when upstream is unavailable. The intrinsic-APY overlay caches by `chainId` only and does **not** stale-fallback a previous successful payload: HyperEVM all-source failure caches `[]` until TTL expiry, and a Monad origin throw is not cached. See [Intrinsic APY](./intrinsic-apy.md#lite-override-proxy). The euler-chains and ABI manifests keep a 7-day stale window (vs the default 30-minute ceiling) so a running instance outlives any realistic upstream outage; an instance cold-started mid-outage 502s until upstream recovers or the explicit URL env vars repoint it at a mirror. The V3 proxy has no local TTL cache: it forwards the upstream response, or returns `503` during failure backoff / upstream outage with `retry-after`. `/api/internal/proxy/turtle/:path` bypasses the cache because reward proofs are per wallet, so a Turtle outage surfaces as a 502 rather than stale data. `/api/internal/pyth/updates` and `/api/internal/screen-address` require real-time data and return no-store cache headers. Screening fail-closed behavior is in [Address Screening](./address-screening.md). The shared caching utility is in `server/utils/cache.ts`. See [Server-Side Caching](./server-side-caching.md) for the provider-proxy pipeline and status codes, the V3 allowlist and backoff, and the labels handler divergence detail.

**Startup cache warming**: `server/plugins/warm-cache.ts` runs at Nitro startup. Two timers:

- **Global cycle (5 min)**: Euler Chains and runtime ABIs once, the cross-chain effective asset policy once, then each enabled non-deprecated chain's Public Labels bundle, effective product/Earn/asset policy, and token list.
- **Vaults cycle (1 min when V3 is configured, otherwise 5 min)**: `/api/internal/vaults` per chain, also serialized.

Each warm task is a **direct function call** (`refreshX()`) that forces an upstream fetch and replaces the cached value before expiry. Concurrent refreshes join the same in-flight operation; request paths continue to use the previous fresh value or the bounded stale fallback. Warming runs in the background — Nitro's node-server preset does not await plugins before starting the HTTP listener, so users arriving in the first few seconds of a freshly booted instance may pay the cold-upstream latency.

For the full setup — per-host proxies, vault snapshot pipeline, two-pass client hydration, V3-conditional cadence, and the bigint wire codec — see [Server-Side Caching](./server-side-caching.md).

### Token List Endpoint Details

The `/api/internal/token-list` endpoint aggregates four token sources, all fetched in parallel with stale-fallback resilience:

1. **Euler SDK token list** (`sdk.tokenlistService`, configured via `V3_API_URL`, `EULER_SDK_V3_API_URL`, or `NUXT_PUBLIC_V3_API_URL`; authenticated with `EULER_SDK_V3_API_KEY` when set) — vault-relevant tokens with logos
2. **DefiLlama** (`NUXT_PUBLIC_CONFIG_DEFILLAMA_TOKEN_LIST_URL`) — broad token coverage
3. **Uniswap** (`NUXT_PUBLIC_CONFIG_UNISWAP_TOKEN_LIST_URL`) — baseline token list
4. **Merkl** — reward tokens

Priority for deduplication: Euler SDK token list > DefiLlama > Uniswap > Merkl. If any source fails, the endpoint still returns data from the remaining sources. The client consumes this via the `useTokenList` composable.

### Pyth Proxy Endpoint Details

The `/api/internal/pyth/updates` endpoint proxies Pyth Hermes price update requests through the server. It authenticates requests to `https://hermes.pyth.network` with a server-side Bearer token, keeping the API key out of the browser.

- **Rate limit**: 1,000 requests per 60-second window
- **Validation**: Feed IDs must match `0x[64 hex chars]` format, max 100 per request
- **Env var**: `PYTH_API_KEY` (server-only; not exposed to client)

## Code layout (high level)

- App entry: `app.vue`
- Pages: `pages/*`
- Components: `components/*`
- Composables: `composables/*`
- Entities (types/helpers/ABI/addresses): `entities/*`
- Public assets: `public/*`
- Styles: `assets/styles/*`

## Conventions

- Vue 3 + Nuxt 4 with Composition API.
- Composables named as `useXxx.ts` and colocated in `composables/`.
- Prefer referencing on-chain data via helpers in `entities/` and state via `composables/`.

## Troubleshooting

- If the app fails to start, ensure Node 24+ and reinstall deps.
- If blockchain calls fail, verify `RPC_URL_<chainId>` env vars and check that matching `SUBGRAPH_URL_<chainId>` or `NUXT_PUBLIC_SUBGRAPH_URI_<chainId>` is set.
- If token logos don't load, verify `V3_API_URL` (or `EULER_SDK_V3_API_URL` / `NUXT_PUBLIC_V3_API_URL`) and, when required by the upstream, `EULER_SDK_V3_API_KEY`. Token data is fetched server-side via `/api/internal/token-list` which aggregates Euler V3, Uniswap, DefiLlama, and Merkl sources with fallback.
- Oracle **provider** logos (Chainlink, Pyth, Midas, …) are a separate client fetch from `https://v3.euler.finance/v3/images/oracle-providers/{key}`. They ignore a custom `V3_API_URL`. Missing or unknown provider names render no logo rather than borrowing the adapter's brand; see [Vault Labels & Verification](./vault-labels-and-verification.md#oracle-provider-logos).

---

_Next: Explore the [Architecture](./architecture.md) for a high-level view of the system._
