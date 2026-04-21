# Development Guide

This guide covers the concrete steps and scripts needed to work on this repository.

## Prerequisites

- Node.js 24+
- npm (or yarn/pnpm if you prefer)

## Install and run

```bash
npm install
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

## End-to-End Testing

The project includes [Playwright](https://playwright.dev/) for E2E testing:

```bash
npx playwright test                # Run all E2E tests
npx playwright test --ui           # Run with interactive UI
npx playwright show-report         # Show last test report
```

## Project configuration

- Nuxt config: `nuxt.config.ts`
  - Modules, SSR disabled, CSS, SVG sprite, runtimeConfig, dev server HTTPS, Vite SCSS additionalData.
- TypeScript config: `tsconfig.json`
- ESLint config: `eslint.config.mjs` (flat config format)
- Playwright config: `playwright.config.ts`
- Git hooks: `simple-git-hooks` + `lint-staged` (configured in `package.json`)

## Environment variables

Configuration is split into two mechanisms:

1. **`useEnvConfig()`** (`composables/useEnvConfig.ts`) — API URLs, Pyth, Reown, wallet screening. Injected at runtime via `server/plugins/app-config.ts` into `window.__APP_CONFIG__`. Accepts both plain names (`EULER_API_URL`) and Doppler-prefixed names (`NUXT_PUBLIC_EULER_API_URL`).

2. **Nuxt `runtimeConfig`** (`useDeployConfig()`) — branding, social links, feature flags. Set via `NUXT_PUBLIC_CONFIG_*` env vars. Includes `NUXT_PUBLIC_CONFIG_LABELS_BASE_URL`, `NUXT_PUBLIC_CONFIG_ORACLE_CHECKS_BASE_URL`, and `NUXT_PUBLIC_CONFIG_EULER_CHAINS_URL` for configuring upstream data sources (GitHub or S3/CDN). All three are fetched through server-side proxy endpoints with 5-minute caching — see [Server-Side Data Proxies](#server-side-data-proxies) below.

3. **Chain config** (`useChainConfig()`) — derived dynamically from `RPC_URL_HTTP_<chainId>` env vars at server startup, injected via `window.__CHAIN_CONFIG__`.

See the [README](../README.md) for the full env var reference.

Dev HTTPS: `HTTPS_KEY`, `HTTPS_CERT` (optional).

## Server-Side Data Proxies

External metadata (contract addresses, labels, oracle checks) is fetched through Nuxt server proxy endpoints rather than directly from GitHub/CDN. This deduplicates upstream requests across users, adds stale-fallback resilience, and avoids GitHub rate limits.

| Endpoint | Upstream source | Cache TTL | Env var override |
|----------|----------------|-----------|------------------|
| `GET /api/euler-chains` | `EulerChains.json` from euler-interfaces | 5 min | `NUXT_PUBLIC_CONFIG_EULER_CHAINS_URL` |
| `GET /api/labels/:file?chainId=X` | `{chainId}/{file}` from euler-labels | 5 min | `NUXT_PUBLIC_CONFIG_LABELS_BASE_URL` |
| `GET /api/oracle-adapter?chainId=X&address=0x...` | Per-adapter JSON from oracle-checks | 5 min | `NUXT_PUBLIC_CONFIG_ORACLE_CHECKS_BASE_URL` |
| `GET /api/token-list?chainId=X` | Euler API + Uniswap + DefiLlama + Merkl reward-tokens | 5 min | `EULER_API_URL`, `NUXT_PUBLIC_CONFIG_UNISWAP_TOKEN_LIST_URL`, `NUXT_PUBLIC_CONFIG_DEFILLAMA_TOKEN_LIST_URL` |
| `GET /api/vault-categories?chainId=X[&address=0x…]` | Subgraph vaults query (paginated, capped at 10k per chain) + escrow perspective RPC | 5 min | `NUXT_PUBLIC_SUBGRAPH_URI_<chainId>` |
| `GET /api/intrinsic-apy?chainId=X` | Every intrinsic-APY source for chain as `{ [addr]: info }` | 5 min (per upstream) | Provider-specific upstreams (DefiLlama, Pendle, Securitize, etc.) |
| `GET /api/rewards/{merkl,brevis,fuul}?chainId=X` | Merkl / Incentra / Fuul public campaigns | 5 min | Hardcoded provider URLs |
| `GET /api/vaults?chainId=X` | Pre-computed chain vault snapshot | 10 min (safety floor) | — |
| `GET /api/pyth/updates?ids[]=...` | Pyth Hermes (`/v2/updates/price/latest`) | No cache | `PYTH_HERMES_URL` (server-only) |

All endpoints use rate limiting and return stale cached data when upstream is unavailable (except `/api/pyth/updates` which requires real-time data and returns no-store cache headers). The shared caching utility is in `server/utils/cache.ts`.

**Startup cache warming**: `server/plugins/warm-cache.ts` runs at Nitro startup and pre-populates `/api/labels/*`, `/api/token-list`, `/api/intrinsic-apy`, `/api/vault-categories`, `/api/rewards/*`, and the vaults snapshot for every enabled chain, plus `/api/euler-chains` once globally. A 5-min interval re-warms thereafter. Each warm task is a **direct function call** (`refreshX()`) that bypasses the handler's fresh-cache short-circuit and forces an upstream fetch, so the entry is always overwritten before it can expire — user requests during the refresh window keep reading the still-fresh previous entry from cache. Warming runs in the background — Nitro's node-server preset doesn't await plugins before starting the HTTP listener, so users arriving in the first ~5 s of a freshly-booted instance's lifetime pay the usual cold-upstream latency for whichever endpoints they hit; everyone after that sees cached responses.

### Token List Endpoint Details

The `/api/token-list` endpoint aggregates three token sources, all fetched in parallel with stale-fallback resilience:

1. **Euler API** (`EULER_API_URL/v1/tokens`) — vault-relevant tokens with logos
2. **DefiLlama** (`NUXT_PUBLIC_CONFIG_DEFILLAMA_TOKEN_LIST_URL`) — broad token coverage
3. **Uniswap** (`NUXT_PUBLIC_CONFIG_UNISWAP_TOKEN_LIST_URL`) — baseline token list

Priority for deduplication: Euler API > DefiLlama > Uniswap. If any source fails, the endpoint still returns data from the remaining sources. The client consumes this via the `useTokenList` composable.

### Pyth Proxy Endpoint Details

The `/api/pyth/updates` endpoint proxies Pyth Hermes price update requests through the server. This avoids CORS restrictions and prevents the Hermes URL (which may contain credentials) from reaching the browser.

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
- If blockchain calls fail, verify `RPC_URL_HTTP_<chainId>` env vars and check that matching `NUXT_PUBLIC_SUBGRAPH_URI_<chainId>` is set.
- If token logos don't load, verify `EULER_API_URL` (or `NUXT_PUBLIC_EULER_API_URL`) is set. Token data is fetched server-side via `/api/token-list` which aggregates Euler API, Uniswap, and DefiLlama sources with fallback.

---

_Next: Explore the [Architecture](./architecture.md) for a high-level view of the system._
