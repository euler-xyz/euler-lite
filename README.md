# Euler Lite

## Overview

Euler Lite provides all the core functionality of Euler Finance in a customizable package:

- **Lending & Borrowing**: Users can deposit assets to earn yield or borrow against collateral
- **Portfolio Management**: Track positions and performance
- **Rewards**: Participate in Merkl, Incentra, and Fuul reward programs
- **Multi-chain Support**: Connect to multiple EVM-compatible networks

## Prerequisites

- **Node.js** 24+ (recommended: 24.14.1)
- **npm** package manager
- **Git**
- A **Reown Project ID** for AppKit wallet connections - get one at [reown.com](https://reown.com/)

## Quick Start

### 1. Clone and Install

```bash
git clone <repository-url>
cd euler-lite
npm ci
```

### 2. Environment Configuration

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

#### Required Variables

| Variable                             | Description                                                 |
| ------------------------------------ | ----------------------------------------------------------- |
| `APPKIT_PROJECT_ID` or `NUXT_PUBLIC_APP_KIT_PROJECT_ID` | Reown (WalletConnect) project ID                |
| `NUXT_PUBLIC_APP_URL`                | Your app's public URL                                       |
| `RPC_URL_<chainId>`                  | RPC endpoint per chain (e.g. `RPC_URL_1` for Ethereum)      |
| `SUBGRAPH_URL_<chainId>` or `NUXT_PUBLIC_SUBGRAPH_URI_<chainId>` | Subgraph URI per chain. `SUBGRAPH_URL_*` is server-only and preferred; `NUXT_PUBLIC_SUBGRAPH_URI_*` remains supported for existing deployments. |

#### API URLs

| Variable     | Default                       | Description                           |
| ------------ | ----------------------------- | ------------------------------------- |
| `V3_API_URL` | `https://v3.euler.finance`    | Euler V3 upstream used by the server `/api/internal/v3` proxy |
| `EULER_SDK_V3_API_KEY` | —                  | Optional server-side V3 API key forwarded by `/api/internal/v3` as `X-API-Key` |
| `SWAP_API_URL` or `NUXT_PUBLIC_SWAP_API_URL` | —           | Euler swap API                        |
| `PYTH_API_KEY` | — | Server-side API key sent to `https://hermes.pyth.network` as Bearer authentication by `/api/internal/pyth/updates` |

> **Doppler compatibility:** If your secret manager injects prefixed URL names, the server also accepts `EULER_SDK_V3_API_URL` and `NUXT_PUBLIC_V3_API_URL`. API keys use server-side names such as `EULER_SDK_V3_API_KEY` and `PYTH_API_KEY`.

#### SDK Data Source Controls

Euler Lite uses the [Euler V2 SDK](https://github.com/euler-xyz/euler-sdks) for vault reads, portfolio data, prices, rewards, and transaction plans. These controls select which SDK adapter path is used for cached browsing reads and the server-side vault snapshot:

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `SERVER_VAULT_CACHE_SOURCE` | `fallback` | Server snapshot builder adapter chain: `fallback`, `onchain`, or `v3`. |
| `NUXT_PUBLIC_BROWSER_VAULT_SOURCE` | `fallback` | Browser "fast" SDK adapter chain: `fallback`, `onchain`, or `v3`. The plan-time SDK is always on-chain. |
| `DISABLE_SERVER_VAULT_CACHE` | `false` | Set to `true` to disable `/api/internal/vaults` snapshots and let the browser fall through to the normal RPC pipeline. |
| `DEPRECATED_CHAINS` | — | Comma-separated chain IDs shown collapsed in the chain selector and skipped by startup warm-cache cycles. |
| `ONCHAIN_SDK_CHAINS` | — | Comma-separated chain IDs pinned to the onchain SDK adapter config for chain-aware browser reads and the server vault snapshot, bypassing V3. Independent of `DEPRECATED_CHAINS`; list a chain in both to deprecate it and route it onchain. |
| `EVAULT_FETCH_CHUNK_CHAINS` | — | Comma-separated chain IDs whose EVault list reads are split into small sequential SDK calls. Use for RPC/lens endpoints that fail under larger concurrent onchain EVault fetches. |
| `EULER_SDK_EULER_INTERFACES_BRANCH` | `master` | Euler interfaces branch used for runtime ABIs and `EulerChains.json`. When set, it takes precedence over `NUXT_PUBLIC_CONFIG_EULER_CHAINS_URL`. |

`fallback` uses V3 first and on-chain reads second. If no V3 URL is configured, Lite passes `disableV3: true` to the SDK so fallback reads go straight on-chain.

#### Optional Server Controls

| Variable | Description |
| -------- | ----------- |
| `CORS_ALLOWED_ORIGINS` | Comma-separated allowlist for `/api/*`; falls back to `NUXT_PUBLIC_APP_URL`. |
| `CSP_EXTRA_CONNECT_SRC` | Extra `connect-src` origins for development or staging endpoints. |
| `DEV_GEO_COUNTRY` | Local/preview country fallback when Cloudflare geo headers are absent. Do not set in production behind Cloudflare. |
| `ADDRESS_SCREENING_URI` / `ADDRESS_SCREENING_API_KEY` | Server-side data-v3 compliance endpoint + restricted API key, proxied by `/api/internal/screen-address` (also serves first-party `*.euler.finance` SPAs). Both unset ⇒ screening disabled (all addresses pass); only one set ⇒ fails closed. |
| `STABLEWATCH_API_KEY` | Optional server-side Stablewatch key for intrinsic APY data. |
| `MERKL_API_KEY` | Optional server-side Merkl key. The Merkl API works anonymously (10 req/sec shared across all users via `/api/internal/proxy/merkl`); set this to send `X-API-Key` upstream for a higher quota. Server-only — never exposed to the browser. |
| `TENDERLY_ACCESS_KEY`, `TENDERLY_ACCOUNT_SLUG`, `TENDERLY_PROJECT_SLUG` | Optional Tenderly simulation configuration. |
| `FUUL_API_URL` or `NUXT_PUBLIC_FUUL_API_URL` | Optional Fuul API upstream override. |
| `INCENTRA_API_URL` or `NUXT_PUBLIC_INCENTRA_API_URL` | Optional Incentra/Brevis API upstream override. |

#### Branding & Feature Flags

These use Nuxt's `runtimeConfig` and are set via `NUXT_PUBLIC_CONFIG_*` env vars:

| Variable                                    | Default                                    | Description                                           |
| ------------------------------------------- | ------------------------------------------ | ----------------------------------------------------- |
| `NUXT_PUBLIC_CONFIG_APP_TITLE`              | `Euler Lite`                               | App title (SEO, meta tags)                            |
| `NUXT_PUBLIC_CONFIG_APP_DESCRIPTION`        | `Lightweight interface for Euler Finance.` | App description                                       |
| `NUXT_PUBLIC_CONFIG_LOGO_URL`               | —                                          | Custom logo URL (falls back to built-in Euler logo)   |
| `NUXT_PUBLIC_CONFIG_SOCIAL_IMAGE_URL`       | —                                          | Absolute URL to social share image (og:image / twitter:image), 1200×630+ |
| `NUXT_PUBLIC_CONFIG_LABELS_REPO`            | `euler-xyz/euler-labels`                   | GitHub labels repo                                    |
| `NUXT_PUBLIC_CONFIG_LABELS_REPO_BRANCH`     | `master`                                   | Branch to fetch labels from                           |
| `NUXT_PUBLIC_CONFIG_LABELS_BASE_URL`        | —                                          | S3/CDN base URL for labels (overrides repo/branch)    |
| `NUXT_PUBLIC_CONFIG_ORACLE_CHECKS_REPO`     | `euler-xyz/oracle-checks`                  | GitHub repo for oracle check results                  |
| `NUXT_PUBLIC_CONFIG_ORACLE_CHECKS_BASE_URL` | —                                          | S3/CDN base URL for oracle checks (overrides repo)    |
| `NUXT_PUBLIC_CONFIG_EULER_CHAINS_URL`       | —                                          | URL for EulerChains.json, used when no Euler interfaces branch is configured |
| `NUXT_PUBLIC_CONFIG_DOCS_URL`               | —                                          | Documentation link                                    |
| `NUXT_PUBLIC_CONFIG_STARGATE_URL`           | —                                          | Stargate link                                         |
| `NUXT_PUBLIC_CONFIG_TOS_URL`                | —                                          | Terms of Service link                                 |
| `NUXT_PUBLIC_CONFIG_TOS_MD_URL`             | —                                          | TOS markdown URL (enables TOS signing when set)       |
| `NUXT_PUBLIC_CONFIG_PRIVACY_POLICY_URL`     | `https://www.euler.finance/privacy-policy` | Privacy policy link                                   |
| `NUXT_PUBLIC_CONFIG_RISK_DISCLOSURES_URL`   | `https://www.euler.finance/risk-disclosures` | Risk disclosures link                               |
| `NUXT_PUBLIC_CONFIG_MICA_WHITEPAPER_URL`    | `https://www.euler.finance/MICA-Whitepaper.pdf` | MiCA whitepaper link                           |
| `NUXT_PUBLIC_CONFIG_X_URL`                  | —                                          | X (Twitter) link                                      |
| `NUXT_PUBLIC_CONFIG_DISCORD_URL`            | —                                          | Discord link                                          |
| `NUXT_PUBLIC_CONFIG_TELEGRAM_URL`           | —                                          | Telegram link                                         |
| `NUXT_PUBLIC_CONFIG_GITHUB_URL`             | —                                          | GitHub link                                           |
| `NUXT_PUBLIC_CONFIG_ENABLE_EARN_PAGE`       | `true`                                     | Show Earn page                                        |
| `NUXT_PUBLIC_CONFIG_ENABLE_LEND_PAGE`       | `true`                                     | Show Lend page                                        |
| `NUXT_PUBLIC_CONFIG_ENABLE_EXPLORE_PAGE`    | `true`                                     | Show Explore page                                     |
| `NUXT_PUBLIC_CONFIG_ENABLE_ENTITY_BRANDING` | `true`                                     | Show entity branding                                  |
| `NUXT_PUBLIC_CONFIG_ENABLE_VAULT_TYPE`      | `true`                                     | Show vault type labels                                |
| `NUXT_PUBLIC_CONFIG_ENABLE_APP_TITLE`       | `true`                                     | Show app title in the navbar                          |
| `NUXT_PUBLIC_CONFIG_ENABLE_MERKL`           | `true`                                     | Enable Merkl rewards integration                      |
| `NUXT_PUBLIC_CONFIG_ENABLE_INCENTRA`        | `true`                                     | Enable Incentra rewards integration                   |
| `NUXT_PUBLIC_CONFIG_ENABLE_FUUL`            | `true`                                     | Enable Fuul rewards integration                       |
| `NUXT_PUBLIC_CONFIG_ANNOUNCEMENT_TITLE`     | —                                          | Optional one-time modal title; any announcement content field enables the modal |
| `NUXT_PUBLIC_CONFIG_ANNOUNCEMENT_BODY`      | —                                          | Optional one-time modal body text                     |
| `NUXT_PUBLIC_CONFIG_ANNOUNCEMENT_ITEMS`     | —                                          | Optional newline-delimited or JSON-array bullet items |
| `NUXT_PUBLIC_CONFIG_ANNOUNCEMENT_URL`       | —                                          | Optional announcement link (`https://`, `http://`, or safe root-relative path) |
| `NUXT_PUBLIC_CONFIG_UNISWAP_TOKEN_LIST_URL` | `https://tokens.uniswap.org`               | Uniswap token list for swap selector                  |
| `NUXT_PUBLIC_CONFIG_DEFILLAMA_TOKEN_LIST_URL` | `https://d3g10bzo9rdluh.cloudfront.net`  | DefiLlama token list for swap selector                |

Runtime deployments can also set the short `CONFIG_ANNOUNCEMENT_*` names. They are injected through `window.__APP_CONFIG__` at server startup and can change without rebuilding static assets. See [Announcement Modal](./docs/announcement-modal.md) for rollout and dismissal behavior.

#### Chain Configuration

Chains are configured dynamically at runtime. Each chain requires two env vars:

```bash
# Ethereum Mainnet
RPC_URL_1=https://your-rpc-endpoint.com
SUBGRAPH_URL_1=https://api.goldsky.com/.../euler-simple-mainnet/latest/gn

# Arbitrum
RPC_URL_42161=https://your-arbitrum-rpc.com
SUBGRAPH_URL_42161=https://api.goldsky.com/.../euler-simple-arbitrum/latest/gn
```

The app scans for `RPC_URL_<chainId>` env vars at server startup and automatically enables those chains. The SDK subgraph adapters call the same-origin `/api/internal/proxy/subgraph/<chainId>` route, which resolves `SUBGRAPH_URL_<chainId>` first and `NUXT_PUBLIC_SUBGRAPH_URI_<chainId>` second. No code changes needed to add or remove chains.

#### Base App In-App Browser

Euler Lite remains a normal multichain web app, but it supports opening inside the Base App in-app browser. The wallet flow prefers the injected Base App provider when it is available, then falls back to the standard Reown AppKit modal for all other browsers and wallets.

To make Base mainnet available in that environment, configure the same runtime chain variables used by every other chain:

```bash
RPC_URL_8453=https://your-base-rpc.com
SUBGRAPH_URL_8453=https://api.goldsky.com/.../euler-simple-base/latest/gn
```

### 3. Customize Your Instance

#### Theme Colors (`assets/styles/variables.scss`)

All colors are defined as CSS custom properties in `variables.scss`. The file has a clearly marked **THEME CONFIGURATION** section at the top — change these values to restyle the entire app:

```scss
// — Brand Accent (buttons, links, focus rings, highlights) —
--accent-500: #1c997c;          // Main accent color
--accent-rgb: 28, 153, 124;    // RGB components (for alpha variants)

// — Status Colors —
--success-500: #62ad4f;
--warning-500: #ecc033;
--error-500: #c02723;
```

Key design principles:
- **RGB companion variables** (`--accent-rgb`, `--success-rgb`, etc.) — all `rgba()` values throughout the app derive from these automatically
- **Chart colors** (`--chart-*`) — 15 variables controlling Chart.js canvas rendering, with light/dark overrides
- **Graph colors** (`--graph-*`) — 5 variables controlling SVG topology visualizations
- **Accent shadows** (`--accent-glow`, `--accent-shadow-*`) — auto-derived from `--accent-rgb`
- **Dark theme** — all variables are overridden in the `[data-theme="dark"]` section at the bottom of the file

The `useThemeColors` composable bridges CSS variables into JavaScript for Chart.js by reading computed styles from `document.body`. It uses `useTheme()` for reactivity so chart re-renders happen after the DOM `data-theme` attribute updates.

#### Logo

The app logo is rendered by `components/base/LogoBrand.vue`. By default it displays the Euler logo as an inline SVG using `currentColor`, so it automatically follows the theme's accent color.

To use a custom logo, set the `LOGO_URL` environment variable (or `NUXT_PUBLIC_CONFIG_LOGO_URL`). If the custom logo fails to load, the app falls back to the default Euler logo.

#### Intrinsic APY Sources

Intrinsic APY is populated by the Euler V2 SDK through the V3 backend and exposed on fetched vault entities as `intrinsicApy`. Lite enables this in `utils/sdk-fetch-options.ts`; provider coverage is configured upstream in V3. See [Intrinsic APY](./docs/intrinsic-apy.md) for the current data flow.

#### Favicon

Replace the favicon files in `public/favicons/`:

- `favicon.ico`
- `favicon.svg`

#### Token Icons

Token icons are resolved from a unified server-side token list that aggregates the Euler SDK token list, DefiLlama, Uniswap, and Merkl. All sources are fetched in parallel with 5-minute caching and stale-fallback resilience. Euler SDK entries take priority for vault assets.

To override an icon for a specific token, add a file to `assets/tokens/`:

```
assets/tokens/
  eul.png       # overrides the EUL token icon
  mytoken.png   # overrides MYTOKEN icon
```

The resolution order in `getAssetLogoUrl(address, symbol)`:

1. Local override in `assets/tokens/<symbol>.png`
2. `logoURI` from the unified token list (Euler SDK token list > DefiLlama > Uniswap > Merkl)
3. Empty string (component shows initials fallback)

#### EulerEarn Vaults

If using a custom labels repository, create chain-specific `earn-vaults.json` files to curate which EulerEarn vaults appear:

```
your-labels-repo/
├── 1/earn-vaults.json          # Ethereum
├── 42161/earn-vaults.json      # Arbitrum
└── 8453/earn-vaults.json       # Base
```

Each file is a JSON array of vault addresses:

```json
[
  "0x1234567890123456789012345678901234567890",
  "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"
]
```

When using the default `euler-xyz/euler-labels` repository, all verified EulerEarn vaults are shown automatically.

### 4. Development

```bash
npm run dev
```

The app will be available at `http://localhost:3000`.

For HTTPS in local development, set `HTTPS_KEY` and `HTTPS_CERT` env vars pointing to your certificate files.

#### Development with the SDK

The committed dependency uses the npm version in `package.json` and `package-lock.json`. Keep those files pinned to a published `@eulerxyz/euler-v2-sdk` version unless the PR is intentionally updating the SDK dependency.

For local Lite + SDK development, link the sibling SDK package without editing Lite package files:

```bash
cd ../euler-sdks/packages/euler-v2-sdk
pnpm run build
npm link

cd ../../../euler-lite
npm link @eulerxyz/euler-v2-sdk
npm ls @eulerxyz/euler-v2-sdk --depth=0
npm run dev
```

Rebuild the SDK after SDK source changes:

```bash
cd ../euler-sdks/packages/euler-v2-sdk
pnpm run build
```

Return Lite to the committed npm package before final validation:

```bash
cd ../../../euler-lite
npm ci
npm ls @eulerxyz/euler-v2-sdk --depth=0
```

### 5. Build for Production

```bash
npm run build
npm run preview   # preview locally
```

## Docker Deployment

The project includes a Dockerfile that uses [Doppler](https://doppler.com) for runtime secret injection:

```bash
docker build --build-arg APP_PORT=3000 -t euler-lite .

docker run -p 3000:3000 \
  -e DOPPLER_TOKEN=your-doppler-token \
  -e DOPPLER_PROJECT=euler-lite \
  -e DOPPLER_CONFIG=production \
  euler-lite
```

Doppler injects all environment variables at runtime. The server plugins scan the injected env vars and pass config to the client via `window.__APP_CONFIG__` and `window.__CHAIN_CONFIG__`.

The Docker build uses the npm SDK version from `package-lock.json` by default. For a Lite PR that needs an unreleased SDK branch, pass the SDK branch as a build argument:

```bash
docker build \
  --build-arg EULER_SDK_BRANCH=feat/sdk-branch \
  --build-arg APP_PORT=3000 \
  -t euler-lite .
```

When `EULER_SDK_BRANCH` is set, the builder clones `euler-xyz/euler-sdks`, builds `packages/euler-v2-sdk`, packs it, and installs that tarball with `--no-save` before running the Lite build. The committed Lite package files still point at the installed npm version.

Railway PR builds use the same Dockerfile. Set `EULER_SDK_BRANCH` for previews that should consume a branch from `https://github.com/euler-xyz/euler-sdks.git`; leave it unset for previews that should use the npm version in `package-lock.json`.

The SDK preview build installs `pnpm@10` by default. Set `EULER_SDK_PNPM_VERSION` if the SDK branch requires another pnpm version.

To run without Doppler, override the `CMD` and pass env vars directly:

```bash
docker run -p 3000:3000 \
  -e V3_API_URL=https://v3.euler.finance \
  -e EULER_SDK_V3_API_KEY=your-v3-api-key \
  -e SWAP_API_URL=https://swap.euler.finance \
  -e APPKIT_PROJECT_ID=your-project-id \
  -e RPC_URL_1=https://your-rpc.com \
  -e SUBGRAPH_URL_1=https://your-subgraph.com \
  euler-lite node .output/server/index.mjs
```

## Project Structure

```
assets/
  styles/variables.scss    # Theme config + CSS variables (edit top section to restyle)
  tokens/                  # Token icon overrides
components/
  base/LogoBrand.vue       # App logo (inline SVG default, env var override, error fallback)
  ...                      # Vue components organized by feature
composables/
  useEnvConfig.ts          # Runtime env config (API URLs, Pyth, Reown, logo)
  useDeployConfig.ts       # Branding, social links, feature flags
  useThemeColors.ts        # Bridges CSS color variables into Chart.js
  useChainConfig.ts        # Dynamic chain derivation from env vars
  useEulerConfig.ts        # Aggregated config for Euler services
  useTokenList.ts          # Unified token list and icon resolution
  useEulerTx.ts            # SDK TransactionPlan builders, simulation, and execution
entities/
  account.ts               # Account and position helpers
  chainRegistry.ts         # Supported-chain lookup helpers
  constants.ts             # Shared protocol/API constants
utils/
  vault/                   # Vault classification, APY, LTV, and verification helpers
pages/                     # Nuxt pages/routes
plugins/
  00.wagmi.ts              # Wagmi/Reown wallet configuration
public/
  favicons/                # Favicon files
  logo.svg                 # Default logo (uses currentColor for theme-awareness)
server/
  plugins/app-config.ts    # Injects env config into HTML (incl. logo URL)
  plugins/chain-config.ts  # Injects chain config into HTML
```

## Available Scripts

| Command               | Description                       |
| --------------------- | --------------------------------- |
| `npm run dev`         | Start development server          |
| `npm run build`       | Build for production              |
| `npm run preview`     | Preview production build locally  |
| `npm run generate`    | Generate static site              |
| `npm run lint`        | Run ESLint                        |
| `npm run lint:fix`    | Run ESLint with auto-fix          |
| `npm run test`        | Run unit tests (watch mode)       |
| `npm run test:run`    | Run unit tests (single pass)      |
| `npm run typecheck`   | Type-check the project            |
| `npm run postinstall` | Prepare Nuxt (runs automatically) |

## Configuration Checklist

Before deploying:

- [ ] Copied `.env.example` to `.env` and filled in values
- [ ] Set `APPKIT_PROJECT_ID` and `NUXT_PUBLIC_APP_URL`
- [ ] Set `V3_API_URL`, optional `EULER_SDK_V3_API_KEY`, and `SWAP_API_URL`
- [ ] Added at least one `RPC_URL_<chainId>` with matching `SUBGRAPH_URL_<chainId>` or `NUXT_PUBLIC_SUBGRAPH_URI_<chainId>`
- [ ] Configured branding via `NUXT_PUBLIC_CONFIG_*` env vars (title, description, logo, social links, social share image)
- [ ] Customized theme colors in `assets/styles/variables.scss` (THEME CONFIGURATION section)
- [ ] Replaced favicon files in `public/favicons/`
- [ ] Added token icon overrides in `assets/tokens/` (if needed)

## Troubleshooting

### Token logos not loading

- Verify `V3_API_URL` is set correctly. If the V3 deployment requires authentication, verify `EULER_SDK_V3_API_KEY` is set. If using Doppler, ensure the URL env var name matches (`V3_API_URL`, `EULER_SDK_V3_API_URL`, or `NUXT_PUBLIC_V3_API_URL`).
- Token data is fetched server-side via `/api/internal/token-list` which aggregates Euler V3, DefiLlama, Uniswap, and Merkl sources with fallback. Check server logs for upstream failures.

### Build Errors

- Ensure Node.js version is 24+ (24.14.1 recommended)
- Clear and reinstall: `rm -rf node_modules && npm ci`

### Wallet Connection Issues

- Verify `APPKIT_PROJECT_ID` is correct (or `NUXT_PUBLIC_APP_KIT_PROJECT_ID` for Doppler)
- Ensure `NUXT_PUBLIC_APP_URL` matches your domain
- Check browser console for errors

### No Chains Available

- Ensure at least one `RPC_URL_<chainId>` env var is set
- Each chain needs a matching `SUBGRAPH_URL_<chainId>` or `NUXT_PUBLIC_SUBGRAPH_URI_<chainId>`

## Additional Resources

- [Nuxt.js Documentation](https://nuxt.com/docs)
- [Reown (WalletConnect) Documentation](https://docs.reown.com/)
- [Euler Finance Documentation](https://docs.euler.finance/)

## License

MIT — see the [LICENSE](./LICENSE) file.
