# AGENTS.md

Euler Lite is a single-service **Nuxt 4 / Vue 3 / TypeScript** frontend for the Euler DeFi
lending protocol (lend, borrow, earn, portfolio, rewards, swaps). There is no separate backend:
the Nitro server layer only serves the SPA shell and a set of `/api/internal/*` proxy routes.
All Ethereum interaction uses **viem** + the **`@eulerxyz/euler-v2-sdk`**; wallet connection uses
**wagmi + Reown AppKit**.

Deep-dive docs live in `docs/` (see "Reference docs" below) and setup/scripts are in `README.md`
and `package.json`. This file captures the non-obvious, durable context that isn't already
obvious from those sources.

## Cursor Cloud specific instructions

Euler Lite is the only service. Standard commands live in `README.md` ("Available Scripts") and
`package.json`.

### Node version
- The app requires **Node 24** (24.14.1 is installed via `nvm` and set as the default). The VM's
  system `node` at `/exec-daemon/node` is Node 22, so `~/.bashrc` prepends the Node 24 bin to
  `PATH`. New login shells already resolve `node -v` to 24.x — no action needed. If you spawn a
  non-login/non-interactive shell and get Node 22, run `nvm use default` or prepend
  `$HOME/.nvm/versions/node/v24.14.1/bin` to `PATH`. CI also pins Node 24 (`.github/workflows/ci.yaml`).

### Environment config (`.env`)
- The app reads runtime config from `.env` (gitignored). A working dev `.env` is created during
  setup by copying `.env.example` and setting `NUXT_PUBLIC_APP_URL=http://localhost:3000` plus a
  public RPC: `RPC_URL_1=https://ethereum-rpc.publicnode.com`. If `.env` is missing, recreate it
  the same way — **at least one `RPC_URL_<chainId>` is required** or the chain selector shows no
  chains. Subgraph URLs for many chains are already present in `.env.example`.
- `NUXT_PUBLIC_APP_KIT_PROJECT_ID` (Reown/WalletConnect) is left empty; browsing/read flows work
  without it, but live wallet connection needs a real project ID.
- Enabled chains are derived from `RPC_URL_<chainId>` vars at server startup, so **restart
  `npm run dev` after editing chain env vars** (they are not hot-reloaded).

### Running / testing
- Dev server: `npm run dev` → http://localhost:3000 (use a tmux session so it persists).
- Vault/market data (Explore page, vault details) loads from the upstream V3 API + the configured
  RPC; some individual price/vault upstream calls may log `502`/timeout warnings without breaking
  the page.
- Lint: `npm run lint` (a few pre-existing `no-explicit-any` warnings, 0 errors).
- Typecheck: `npm run typecheck`.
- Tests: `npm run test:run` (single pass; `npm run test` is watch mode). Test runs print lots of
  `pino` warn/error JSON lines from exercised code paths — this is expected; check the final
  vitest summary. See "Testing" below for the golden/parity suites and the CI build-before-test
  gotcha.
- A `pre-commit` hook (simple-git-hooks + lint-staged) runs `eslint --fix` on staged files.

## Architecture at a glance

- **SPA, not SSR.** `nuxt.config.ts` sets `ssr: false`. Nitro still runs to serve the HTML shell
  (with injected config scripts) and the `/api/internal/*` proxies. Details in `docs/architecture.md`.
- **No Pinia.** State lives in module-scoped `ref`s inside composables (e.g. `useVaults`,
  `useEulerAccount`, `useTxBatch`, `useWallets`). `app.vue` eagerly instantiates the key
  composables at the root so their watchers survive navigation. TanStack Vue Query
  (`plugins/01.query.ts`) is used for some async caching, not as global app state.
- **Config flows env → server plugin → `window` global → composable:**
  - `RPC_URL_*`, `DEPRECATED_CHAINS`, `ONCHAIN_SDK_CHAINS`, `EVAULT_FETCH_CHUNK_CHAINS`
    → `server/plugins/chain-config.ts` → `window.__CHAIN_CONFIG__` → `useChainConfig()`
  - AppKit / V3 / Swap / Pyth URLs + branding → `server/plugins/app-config.ts` →
    `window.__APP_CONFIG__` → `useEnvConfig()`
  - `NUXT_PUBLIC_CONFIG_*` feature flags/page toggles → Nuxt `runtimeConfig.public` → `useDeployConfig()`
- **Secrets never reach the browser.** RPC URLs, subgraph URLs (`SUBGRAPH_URL_*`), and the V3 URL
  are server-only. The client always talks to same-origin proxies: `/api/internal/rpc/{chainId}`,
  `/api/internal/proxy/subgraph/{chainId}`, `/api/internal/v3`. `pythHermesUrl` is exposed to the
  client only as the string `'proxy'`.

## Repository layout

| Directory | Contents |
|-----------|----------|
| `pages/` | File-based routes. Key sections: `/explore`, `/lend`, `/borrow`, `/earn`, `/portfolio`, `/position/[number]/*` (supply/withdraw/repay/multiply/migrate), `/batch`. `/ui` is a dev-only component playground stripped from production builds. |
| `components/` | `base/`, `layout/`, `entities/` (feature components — scanned by Tailwind), `ui/` (design-system kit — SCSS, **excluded** from Tailwind scanning), plus root `Batch*.vue`. Auto-imported flat (`pathPrefix: false`), so use `LogoBrand`, not `BaseLogoBrand`. |
| `composables/` | Business logic (~97 files). Subdirs `borrow/`, `repay/`, `cowswap/`, `guards/`, `position/`, `useKeyring/`, `useRpcClient/`. **Auto-import nuance:** only top-level `composables/*/index.ts` are auto-imported; nested files must be imported explicitly (e.g. `~/composables/repay/useRepaySwapCore`). |
| `utils/` | Pure helpers. `utils/vault/` is the largest (classification, APY, LTV, liquidation). |
| `entities/` | App-specific domain types/constants (`account.ts`, `chainRegistry.ts`, `constants.ts`, `menu.ts`, `oracle.ts`, migration/cowswap helpers). On-chain types come from the SDK, not here. |
| `server/` | Nitro layer: `api/`, `middleware/`, `plugins/`, `utils/`. |
| `plugins/` | Client/Nuxt plugins (numbered for load order): `00.wagmi.ts`, `00.chartjs.client.ts`, `01.query.ts`, `theme.client.ts`, `node.ts` (Buffer polyfill). |
| `middleware/` | Route middleware (numbered): `01.network.global.ts` (normalizes `?network=`, applies legacy path rewrites), `02.spy-param.global.ts`, `ensure-vault.global.ts`. |
| `services/` | 3 thin fetch wrappers over internal API routes (`country.ts`, `trm.ts`, `vpn.ts`). |
| `abis/` | viem ABIs (`vault.ts`, `evc.ts`, `erc20.ts`, `pyth.ts`, `keyring.ts`, `merkl.ts`, ...). |
| `types/` | Shared TS types + global `Window` augmentations (`types/index.ts`). |
| `assets/` | `styles/` (SCSS + theme vars in `variables.scss`), `tokens/` (icon overrides), `chains/`, `sprite/`. |
| `tests/` | Vitest suites + `golden/`, `parity/`, `execution/` (see Testing). |
| `scripts/` | Node tooling for parity/execution runs, Doppler sync, preview-SDK install. |
| `docs/` | Developer docs (see below). |

## Server / proxy layer (`server/`)

- **Internal proxies** (`server/api/internal/`) keep upstreams/secrets server-side and are the
  only outbound path the browser uses: `v3/[...path]` (allowlisted V3 proxy), `rpc/[chainId]`
  (JSON-RPC, allowlisted methods), `token-list`, `vaults` (pre-computed snapshot),
  `proxy/subgraph/[chainId]`, `proxy/merkl|fuul|incentra|turtle/*`, `pyth/updates`,
  `screen-address`, `tenderly/*`, `oracle-*`, `labels/*`, `tos`, `client-error`.
- **Public routes** (`server/api/public/`): `is-known`, `metadata` (documented in `docs/public-api.md`).
- **Server middleware:** `geo-gate.ts` (451 for sanctioned countries via Cloudflare `CF-IPCountry`;
  set `DEV_GEO_COUNTRY` locally since there's no CF header), `cors.ts`, `security-headers.ts`,
  `body-limit.ts`, `ensure-vault.ts`.
- **Server plugins (load order matters):** `app-config.ts` / `chain-config.ts` inject the `window`
  config; `csp.ts` (nonce-based CSP) must run after them; `warm-cache.ts` warms labels/token-list/
  vault caches in the background. Caching internals are in `docs/server-side-caching.md`.
- **Logging:** server uses `pino` JSON (`server/utils/logger.ts`); client/shared uses a console
  shim (`utils/logger.ts`). viem errors are sanitized via `utils/viem-errors.ts`.

## Testing

Three distinct test layers — most day-to-day work only touches the first.

1. **Unit / integration (Vitest, `vitest.config.ts`).** 125+ files under `tests/` mirroring source
   dirs. Run with `npm run test:run`. Nuxt/Nitro globals and Vue reactivity are stubbed in
   `tests/setup.ts`; `#app` is aliased to `tests/stubs/nuxt-app.ts`.
   - **Gotcha:** `tests/utils/logger-bundle.test.ts` inspects the production client bundle at
     `.output/public/_nuxt` and **auto-skips when no build exists** (this is the "1 skipped" test
     in a plain run). CI runs `npm run build` before `npm run test:run` so it executes. Build
     first if you need to exercise it locally.
2. **Golden parity (`tests/golden/`, `vitest.golden.config.ts`).** Byte-for-byte comparison of
   legacy transaction builders against the SDK `TransactionPlan` methods in `useEulerTx.ts`.
   Requires a sibling git worktree at `../euler-lite-sdk-exec-legacy` — see `tests/golden/README.md`
   and `tests/golden/COVERAGE.md`. There is **no** `test:golden` npm script; run
   `npx vitest --config vitest.golden.config.ts run`.
3. **Parity / execution (Playwright, `scripts/*.mjs` + `tests/parity/`, `tests/execution/`).**
   Browser-driven diff and fork-based (Anvil) transaction recording. Driven by the `parity:*` and
   `execution:*` npm scripts using JSON scenario files. The UI exposes `data-id` / `data-field` /
   `data-value` attributes specifically for these scrapers — don't remove them casually.

**CI (`.github/workflows/ci.yaml`)** runs three blocking jobs on every PR: `lint`, `typecheck`,
and `test` (which builds first, then `test:run`). Match these locally before pushing.

## Reference docs (`docs/`)

Start with `docs/README.md` (index) and `docs/architecture.md`. Notable topics:
`development-guide.md`, `sdk-integration.md`, `transaction-building.md`, `server-side-caching.md`,
`pricing-system.md`, `pyth-oracle-handling.md`, `portfolio-logic.md`,
`vault-labels-and-verification.md`, `token-list.md`, `geo-blocking.md`, `tos-signing.md`,
`keyring-hooks.md`, `public-api.md`, `intrinsic-apy.md`.

## Conventions & gotchas

- **Vue style:** `<script setup lang="ts">` only (no Options API); `defineProps`/`defineEmits` use
  the TypeScript generic form. Rely on Nuxt auto-imports for Vue APIs and top-level composables.
- **TypeScript:** avoid `any` (ESLint warns). Type on-chain amounts as `bigint`. Note Nuxt sets
  `strict: false` / `noUncheckedIndexedAccess: false` in the generated tsconfig, so the compiler
  won't catch nullable-index access for you.
- **viem:** normalize addresses with `getAddress()` before comparing; use `parseUnits`/`formatUnits`
  with the asset's real decimals (never hardcode 18).
- **Styling:** Tailwind classes for `pages/`, `layout/`, `base/`, `entities/`; the `components/ui/`
  design kit uses SCSS and is intentionally outside Tailwind's `content` scan (`tailwind.config.js`).
  Colors/spacing derive from CSS vars in `assets/styles/variables.scss`.
- **Theme:** default dark; an inline critical script reads `localStorage.theme` before paint.
  Chart.js colors are bridged from CSS vars via `useThemeColors`.
- **Local SDK dev:** `nuxt.config.ts` detects a symlinked `@eulerxyz/euler-v2-sdk` and excludes it
  from Vite `optimizeDeps`. Keep `package.json`/`package-lock.json` pinned to the published SDK
  version unless a PR is intentionally bumping it (see README "Development with the SDK").
- **PR review skills:** `.claude/skills/{review-business,review-security,review-stack}/SKILL.md`
  document the review criteria used for this repo — useful before submitting changes.
