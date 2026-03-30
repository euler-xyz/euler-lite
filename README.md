# Euler Lite

## Overview

Euler Lite provides all the core functionality of Euler Finance in a customizable package:

- **Lending & Borrowing**: Users can deposit assets to earn yield or borrow against collateral
- **Portfolio Management**: Track positions and performance
- **Rewards**: Participate in Merkl/Brevis reward programs
- **Multi-chain Support**: Connect to multiple EVM-compatible networks

## Prerequisites

- **Node.js** 18+ (recommended: 20.12.2)
- **npm** package manager
- **Git**
- A **Reown Project ID** (formerly WalletConnect) - get one at [reown.com](https://reown.com/)

## Quick Start

### 1. Clone and Install

```bash
git clone <repository-url>
cd euler-lite
npm install
```

### 2. Environment Configuration

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

#### Required Variables

| Variable                             | Description                                                 |
| ------------------------------------ | ----------------------------------------------------------- |
| `APPKIT_PROJECT_ID`                  | Reown (WalletConnect) project ID                            |
| `NUXT_PUBLIC_APP_URL`                | Your app's public URL                                       |
| `RPC_URL_HTTP_<chainId>`             | RPC endpoint per chain (e.g. `RPC_URL_HTTP_1` for Ethereum) |
| `NUXT_PUBLIC_SUBGRAPH_URI_<chainId>` | Subgraph URI per chain                                      |

#### API URLs

| Variable          | Default                       | Description                           |
| ----------------- | ----------------------------- | ------------------------------------- |
| `EULER_API_URL`   | —                             | Euler API (tokens, prices, logos)     |
| `SWAP_API_URL`    | —                             | Euler swap API                        |
| `PYTH_HERMES_URL` | `https://hermes.pyth.network` | Pyth oracle endpoint (server-only, proxied via `/api/pyth/updates`) |

> **Doppler compatibility:** If your secret manager injects `NUXT_PUBLIC_*` prefixed names (e.g. `NUXT_PUBLIC_EULER_API_URL`), the app accepts both forms automatically.

#### Branding & Feature Flags

These use Nuxt's `runtimeConfig` and are set via `NUXT_PUBLIC_CONFIG_*` env vars:

| Variable                                    | Default                                    | Description                                           |
| ------------------------------------------- | ------------------------------------------ | ----------------------------------------------------- |
| `NUXT_PUBLIC_CONFIG_APP_TITLE`              | `Euler Lite`                               | App title (SEO, meta tags)                            |
| `NUXT_PUBLIC_CONFIG_APP_DESCRIPTION`        | `Lightweight interface for Euler Finance.` | App description                                       |
| `NUXT_PUBLIC_CONFIG_LOGO_URL`               | —                                          | Custom logo URL (falls back to built-in Euler logo)   |
| `NUXT_PUBLIC_CONFIG_LABELS_REPO`            | `euler-xyz/euler-labels`                   | GitHub labels repo                                    |
| `NUXT_PUBLIC_CONFIG_LABELS_REPO_BRANCH`     | `master`                                   | Branch to fetch labels from                           |
| `NUXT_PUBLIC_CONFIG_LABELS_BASE_URL`        | —                                          | S3/CDN base URL for labels (overrides repo/branch)    |
| `NUXT_PUBLIC_CONFIG_ORACLE_CHECKS_BASE_URL` | —                                          | S3/CDN base URL for oracle checks (overrides repo)    |
| `NUXT_PUBLIC_CONFIG_DOCS_URL`               | —                                          | Documentation link                                    |
| `NUXT_PUBLIC_CONFIG_TOS_URL`                | —                                          | Terms of Service link                                 |
| `NUXT_PUBLIC_CONFIG_TOS_MD_URL`             | —                                          | TOS markdown URL (enables TOS signing when set)       |
| `NUXT_PUBLIC_CONFIG_X_URL`                  | —                                          | X (Twitter) link                                      |
| `NUXT_PUBLIC_CONFIG_DISCORD_URL`            | —                                          | Discord link                                          |
| `NUXT_PUBLIC_CONFIG_TELEGRAM_URL`           | —                                          | Telegram link                                         |
| `NUXT_PUBLIC_CONFIG_GITHUB_URL`             | —                                          | GitHub link                                           |
| `NUXT_PUBLIC_CONFIG_ENABLE_EARN_PAGE`       | `true`                                     | Show Earn page                                        |
| `NUXT_PUBLIC_CONFIG_ENABLE_LEND_PAGE`       | `true`                                     | Show Lend page                                        |
| `NUXT_PUBLIC_CONFIG_ENABLE_ENTITY_BRANDING` | `true`                                     | Show entity branding                                  |
| `NUXT_PUBLIC_CONFIG_ENABLE_VAULT_TYPE`      | `true`                                     | Show vault type labels                                |
| `NUXT_PUBLIC_CONFIG_ENABLE_APP_TITLE`       | `true`                                     | Show app title in the navbar                          |
| `NUXT_PUBLIC_CONFIG_UNISWAP_TOKEN_LIST_URL` | `https://tokens.uniswap.org`               | Uniswap token list for swap selector                  |
| `NUXT_PUBLIC_CONFIG_DEFILLAMA_TOKEN_LIST_URL` | `https://d3g10bzo9rdluh.cloudfront.net`  | DefiLlama token list for swap selector                |

#### Chain Configuration

Chains are configured dynamically at runtime. Each chain requires two env vars:

```bash
# Ethereum Mainnet
RPC_URL_HTTP_1=https://your-rpc-endpoint.com
NUXT_PUBLIC_SUBGRAPH_URI_1=https://api.goldsky.com/.../euler-simple-mainnet/latest/gn

# Arbitrum
RPC_URL_HTTP_42161=https://your-arbitrum-rpc.com
NUXT_PUBLIC_SUBGRAPH_URI_42161=https://api.goldsky.com/.../euler-simple-arbitrum/latest/gn
```

The app scans for `RPC_URL_HTTP_<chainId>` env vars at server startup and automatically enables those chains. No code changes needed to add or remove chains.

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

#### Theme Hue (`entities/custom.ts`)

The `themeHue` value (0-360) provides an additional runtime hue shift:

```typescript
export const themeHue = 150; // Change to shift brand palette
```

#### Intrinsic APY Sources (`entities/custom.ts`)

Configure which tokens show DeFiLlama base APY:

```typescript
export const intrinsicApySources = [
  { symbol: "steth", project: "lido" },
  { symbol: "wsteth", sourceSymbol: "steth", project: "lido" },
  // Add your tokens here
] as const;
```

- `symbol` — vault asset symbol (case-insensitive)
- `project` — DefiLlama project slug (from https://yields.llama.fi/pools)
- `sourceSymbol` — optional; use when the vault asset is wrapped but APY is tied to another symbol

#### Favicon

Replace the favicon files in `public/favicons/`:

- `favicon.ico`
- `favicon.svg`

#### Token Icons

Token icons are resolved from a unified server-side token list that aggregates three sources: Euler API, Uniswap, and DefiLlama. All sources are fetched in parallel with 5-minute caching and stale-fallback resilience. Euler API entries take priority for vault assets.

To override an icon for a specific token, add a file to `assets/tokens/`:

```
assets/tokens/
  eul.png       # overrides the EUL token icon
  mytoken.png   # overrides MYTOKEN icon
```

The resolution order in `getAssetLogoUrl(address, symbol)`:

1. Local override in `assets/tokens/<symbol>.png`
2. `logoURI` from the unified token list (Euler API > DefiLlama > Uniswap)
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

To run without Doppler, override the `CMD` and pass env vars directly:

```bash
docker run -p 3000:3000 \
  -e EULER_API_URL=https://your-euler-api.com \
  -e SWAP_API_URL=https://your-swap-api.com \
  -e APPKIT_PROJECT_ID=your-project-id \
  -e RPC_URL_HTTP_1=https://your-rpc.com \
  -e NUXT_PUBLIC_SUBGRAPH_URI_1=https://your-subgraph.com \
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
  useEulerOperations.ts    # Operation builders (deposit, borrow, etc.)
entities/
  custom.ts                # Theme hue and intrinsic APY sources
  vault.ts                 # Vault types and fetching
  account.ts               # Position types
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
| `npm run postinstall` | Prepare Nuxt (runs automatically) |

## Configuration Checklist

Before deploying:

- [ ] Copied `.env.example` to `.env` and filled in values
- [ ] Set `APPKIT_PROJECT_ID` and `NUXT_PUBLIC_APP_URL`
- [ ] Set `EULER_API_URL`, `SWAP_API_URL`
- [ ] Added at least one `RPC_URL_HTTP_<chainId>` with matching `NUXT_PUBLIC_SUBGRAPH_URI_<chainId>`
- [ ] Configured branding via `NUXT_PUBLIC_CONFIG_*` env vars (title, description, logo, social links)
- [ ] Customized theme colors in `assets/styles/variables.scss` (THEME CONFIGURATION section)
- [ ] Replaced favicon files in `public/favicons/`
- [ ] Added token icon overrides in `assets/tokens/` (if needed)

## Troubleshooting

### Token logos not loading

- Verify `EULER_API_URL` is set correctly. If using Doppler, ensure the env var name matches (`EULER_API_URL` or `NUXT_PUBLIC_EULER_API_URL`).
- Token data is fetched server-side via `/api/token-list` which aggregates Euler API, DefiLlama, and Uniswap sources with fallback. Check server logs for upstream failures.

### Build Errors

- Ensure Node.js version is 18+ (20.12.2 recommended)
- Clear and reinstall: `rm -rf node_modules && npm install`

### Wallet Connection Issues

- Verify `APPKIT_PROJECT_ID` is correct (or `NUXT_PUBLIC_APP_KIT_PROJECT_ID` for Doppler)
- Ensure `NUXT_PUBLIC_APP_URL` matches your domain
- Check browser console for errors

### No Chains Available

- Ensure at least one `RPC_URL_HTTP_<chainId>` env var is set
- Each chain needs a matching `NUXT_PUBLIC_SUBGRAPH_URI_<chainId>`

## Additional Resources

- [Nuxt.js Documentation](https://nuxt.com/docs)
- [Reown (WalletConnect) Documentation](https://docs.reown.com/)
- [Euler Finance Documentation](https://docs.euler.finance/)

## License

MIT — see the [LICENSE](./LICENSE) file.
