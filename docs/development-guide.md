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

Configuration is split into two mechanisms:

1. **`useEnvConfig()`** (`composables/useEnvConfig.ts`) — API URLs, Pyth, Reown, wallet screening. Injected at runtime via `server/plugins/app-config.ts` into `window.__APP_CONFIG__`. Browser V3 data services use the same-origin `/api/internal/v3` proxy. The proxy reads `V3_API_URL`, `EULER_SDK_V3_API_URL`, or `NUXT_PUBLIC_V3_API_URL` for the upstream URL and `EULER_SDK_V3_API_KEY` for the optional server-side API key.

2. **Nuxt `runtimeConfig`** (`useDeployConfig()`) — branding, social links, feature flags. Set via `NUXT_PUBLIC_CONFIG_*` env vars. Includes `NUXT_PUBLIC_CONFIG_LABELS_BASE_URL`, `NUXT_PUBLIC_CONFIG_ORACLE_CHECKS_BASE_URL`, and `NUXT_PUBLIC_CONFIG_EULER_CHAINS_URL` for configuring upstream data sources (GitHub or S3/CDN). All three are fetched through server-side proxy endpoints with 5-minute caching — see [Server-Side Data Proxies](#server-side-data-proxies) below.

3. **Chain config** (`useChainConfig()`) — derived dynamically from `RPC_URL_<chainId>` env vars at server startup, injected via `window.__CHAIN_CONFIG__`.

See the [README](../README.md) for the full env var reference.

Dev HTTPS: `HTTPS_KEY`, `HTTPS_CERT` (optional).

## Server-Side Data Proxies

External metadata (contract addresses, labels, oracle checks) is fetched through Nuxt server proxy endpoints rather than directly from GitHub/CDN. This deduplicates upstream requests across users, adds stale-fallback resilience, and avoids GitHub rate limits.

| Endpoint | Upstream source | Cache TTL | Env var override |
|----------|----------------|-----------|------------------|
| `GET /api/internal/euler-chains` | `EulerChains.json` from euler-interfaces | 5 min | `NUXT_PUBLIC_CONFIG_EULER_CHAINS_URL` |
| `GET /api/internal/labels/:file?chainId=X` | `{chainId}/{file}` from euler-labels (query-shape; used by Lite helpers) | 5 min | `NUXT_PUBLIC_CONFIG_LABELS_BASE_URL` |
| `GET /api/internal/labels/:chainId/:file` | `{chainId}/{file}` from euler-labels (path-shape; matches the SDK's default `eulerLabelsBaseUrl` template, shares cache with the query-shape route) | 5 min | `NUXT_PUBLIC_CONFIG_LABELS_BASE_URL` |
| `GET /api/internal/oracle-adapter?chainId=X&address=0x...` | Per-adapter JSON from oracle-checks | 5 min | `NUXT_PUBLIC_CONFIG_ORACLE_CHECKS_BASE_URL` |
| `GET /api/internal/token-list?chainId=X` | Euler V3 + Uniswap + DefiLlama + Merkl reward-tokens | 5 min | `V3_API_URL`, `EULER_SDK_V3_API_URL`, `NUXT_PUBLIC_V3_API_URL`, `EULER_SDK_V3_API_KEY`, `NUXT_PUBLIC_CONFIG_UNISWAP_TOKEN_LIST_URL`, `NUXT_PUBLIC_CONFIG_DEFILLAMA_TOKEN_LIST_URL` |
| `GET /api/internal/vaults?chainId=X` | Pre-computed chain vault snapshot built by the server-side SDK | 2 min (V3 configured) / 5 min (no V3) | `V3_API_URL`, `EULER_SDK_V3_API_URL`, `NUXT_PUBLIC_V3_API_URL` (presence selects cadence) |
| `GET\|HEAD /api/internal/proxy/merkl/:path` | `api.merkl.xyz/v4` (`opportunities`, `users`, `campaigns` allowlist) | 60 s | — |
| `GET\|HEAD\|POST /api/internal/proxy/fuul/:path` | `api.fuul.xyz/api/v1` (`incentives`, `totals`, `claim-checks`, `rewards` allowlist) | 30 s | `FUUL_API_URL`, `NUXT_PUBLIC_FUUL_API_URL` |
| `GET\|HEAD\|POST /api/internal/proxy/incentra/:path` | Incentra API (`sdk/v1/`, `v1/` allowlist) | 30 s | `INCENTRA_API_URL`, `NUXT_PUBLIC_INCENTRA_API_URL` |
| `POST /api/internal/proxy/subgraph/:chainId` | Per-chain Goldsky subgraph | 30 s | `SUBGRAPH_URL_<chainId>` (server-only) or `NUXT_PUBLIC_SUBGRAPH_URI_<chainId>` |
| `GET\|POST /api/internal/v3/...path` | Exact SDK-owned V3 endpoint allowlist (`tokens`, `prices`, APYs, rewards, account positions, vault reads, vault batch/resolve) | none — V3 caches upstream | `V3_API_URL`, `EULER_SDK_V3_API_URL`, `NUXT_PUBLIC_V3_API_URL`, `EULER_SDK_V3_API_KEY` |
| `GET /api/internal/pyth/updates?ids[]=...` | Pyth Hermes (`/v2/updates/price/latest`) | No cache | `PYTH_HERMES_URL` (server-only) |

All endpoints use rate limiting and return stale cached data when upstream is unavailable (except `/api/internal/pyth/updates` which requires real-time data and returns no-store cache headers). The shared caching utility is in `server/utils/cache.ts`; the per-host external proxies share `server/utils/external-proxy.ts`.

**Startup cache warming**: `server/plugins/warm-cache.ts` runs at Nitro startup. Two timers:

- **Global cycle (5 min)**: `/api/internal/euler-chains` once, cross-chain `labels/all/assets.json` once, then per-chain `/api/internal/labels/*` and `/api/internal/token-list` for every enabled non-deprecated chain, serialized so cross-chain upstreams dedupe via the in-flight cache.
- **Vaults cycle (1 min when V3 is configured, otherwise 5 min)**: `/api/internal/vaults` per chain, also serialized.

Each warm task is a **direct function call** (`refreshX()`) that bypasses the handler's fresh-cache short-circuit and forces an upstream fetch, so the entry is always overwritten before it can expire — user requests during the refresh window keep reading the still-fresh previous entry from cache. Warming runs in the background — Nitro's node-server preset doesn't await plugins before starting the HTTP listener, so users arriving in the first ~5 s of a freshly-booted instance's lifetime pay the usual cold-upstream latency for whichever endpoints they hit; everyone after that sees cached responses.

For the full setup — per-host proxies, vault snapshot pipeline, two-pass client hydration, V3-conditional cadence, and the bigint wire codec — see [Server-Side Caching](./server-side-caching.md).

### Token List Endpoint Details

The `/api/internal/token-list` endpoint aggregates four token sources, all fetched in parallel with stale-fallback resilience:

1. **Euler SDK token list** (`sdk.tokenlistService`, configured via `V3_API_URL`, `EULER_SDK_V3_API_URL`, or `NUXT_PUBLIC_V3_API_URL`; authenticated with `EULER_SDK_V3_API_KEY` when set) — vault-relevant tokens with logos
2. **DefiLlama** (`NUXT_PUBLIC_CONFIG_DEFILLAMA_TOKEN_LIST_URL`) — broad token coverage
3. **Uniswap** (`NUXT_PUBLIC_CONFIG_UNISWAP_TOKEN_LIST_URL`) — baseline token list
4. **Merkl** — reward tokens

Priority for deduplication: Euler SDK token list > DefiLlama > Uniswap > Merkl. If any source fails, the endpoint still returns data from the remaining sources. The client consumes this via the `useTokenList` composable.

### Pyth Proxy Endpoint Details

The `/api/internal/pyth/updates` endpoint proxies Pyth Hermes price update requests through the server. This avoids CORS restrictions and prevents the Hermes URL (which may contain credentials) from reaching the browser.

- **Rate limit**: 600 requests per 60-second window
- **Validation**: Feed IDs must match `0x[64 hex chars]` format, max 100 per request
- **Env var**: `PYTH_HERMES_URL` (server-only; not exposed to client)

## Code layout (high level)

- App entry: `app.vue`
- Pages: `pages/*`
- Components: `components/*`
- Composables: `composables/*`
- Entities (types/helpers/ABI/addresses): `entities/*`
- Public assets: `public/*`
- Styles: `assets/styles/*`

## Conventions

- Vue 3 + Nuxt 3 with Composition API.
- Composables named as `useXxx.ts` and colocated in `composables/`.
- Prefer referencing on-chain data via helpers in `entities/` and state via `composables/`.

## Troubleshooting

- If the app fails to start, ensure Node 24+ and reinstall deps.
- If blockchain calls fail, verify `RPC_URL_<chainId>` env vars and check that matching `SUBGRAPH_URL_<chainId>` or `NUXT_PUBLIC_SUBGRAPH_URI_<chainId>` is set.
- If token logos don't load, verify `V3_API_URL` (or `EULER_SDK_V3_API_URL` / `NUXT_PUBLIC_V3_API_URL`) and, when required by the upstream, `EULER_SDK_V3_API_KEY`. Token data is fetched server-side via `/api/internal/token-list` which aggregates Euler V3, Uniswap, DefiLlama, and Merkl sources with fallback.

---

_Next: Explore the [Architecture](./architecture.md) for a high-level view of the system._
