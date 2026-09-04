# Euler Lite - Project Documentation

Welcome to the documentation for the Euler Lite project. This documentation is designed to help both new developers understand the project structure and system architects understand how this project fits into the broader ecosystem.

## 📚 Documentation Sections

### 🚀 [Getting Started](./getting-started.md)

- Project overview and purpose
- Technology stack
- Development environment setup
- Quick start guide

### 🏗️ [Architecture Overview](./architecture.md)

- High-level system architecture
- Component architecture
- Data flow patterns
- Technology decisions

### 🚀 [Development Guide](./development-guide.md)

- Development workflow

### 💰 [Pricing System](./pricing-system.md)

- 3-layer pricing architecture (oracle → USD → values)
- On-chain vs off-chain price sources
- Pyth oracle simulation for price reads
- SDK/V3-populated intrinsic APY for yield-bearing assets

### 📐 [Projected Yield](./projected-yield.md)

- Utilization-aware supply and borrow rate projections
- USD-weighted multi-collateral snapshots
- Net APY, ROE, intrinsic yield, and reward breakdowns
- Transaction-batch layer consistency and fail-closed estimates

### 📊 [Portfolio Logic](./portfolio-logic.md)

- Position discovery and categorization
- Lens contract usage
- Borrow, deposit, and earn position loading
- External Aave / Morpho migrate discovery is covered in [External Migration Discovery](./external-migration.md)
- Cross-position exact-vault repayment is covered in [Cross-Position Repay](./cross-position-repay.md)

### 🏷️ [Vault Labels & Verification](./vault-labels-and-verification.md)

- Vault verification and trust levels
- Label data sources and types
- Unknown vault resolution
- SDK 2.0 governance hydration guard (`hasResolvedGovernorAdmin`)
- Oracle provider logos from the V3 managed-image namespace (not `V3_API_URL`)

### 🔧 [Transaction Building](./transaction-building.md)

- SDK TransactionPlan architecture and composite operations
- EVC batching and Permit2 integration
- Gasless-signature preference (`useSignaturePreference`), Safe forced-off override, and sequential vs atomic Safe migration authorization paths
- Sub-accounts and position isolation
- Simulation performance tuning, batch-cart slot-hint / account prefetch, and plugin-layer mapping
- [User-facing review compatibility](./transaction-building.md#user-facing-review-compatibility): exhaustive internal reviewed executions remain separate from the unchanged handcrafted review
- Spy-mode review uses `prepareReadOnly` and a synthetic approval-only wallet binding; confirm stays disabled

### 🔁 [Cross-Position Repay](./cross-position-repay.md)

- Exact-vault collateral from another sub-account, gated on Advanced mode
- Reciprocal-debt batching without withdraw / swap / cleanup
- Distinct from the repay Savings tab (idle EVK deposits)

### 🔐 [Safe Wallet Compatibility](./safe-wallets.md)

- Safe detection (iframe connector, named wallet, WalletConnect peer metadata)
- Force-disabled signatures and CoW quotes while Safe / detection-pending
- EIP-5792 atomic request vectors, sealed wallet bindings, and current-session Safe detachment/status handling

### 🔄 [External Migration Discovery](./external-migration.md)

- Aave v3 and Morpho / MetaMorpho position scanning for Portfolio Migrate
- Supply-only Aave candidates, Morpho chain allowlist, per-source failure isolation

### 📜 [Activity Feed](./activity-feed.md)

- V3-backed vault and portfolio activity surfaces
- Availability gating, category defaults, and display event-type allowlists
- Liquidation enrichment, transaction grouping, and proxy allowlist constraints

### 🧩 [SDK Integration](./sdk-integration.md)

- SDK entry points (`getEulerSdk`, `getEulerSdkForChain`, `getEulerSdkFresh`)
- Backend selection via `enableV3Backend` (V3 adapters vs onchain/subgraph/direct)
- Unified `SDK_QUERY_POLICY` — `staleTimeMs` / `formStaleTimeMs` / `invalidateAfterTx`
- Post-tx portfolio refresh through the fresh SDK path
- Same-origin proxies wired into SDK config (labels, Merkl, Fuul, Incentra, subgraph)

### 🗄️ [Server-Side Caching](./server-side-caching.md)

- Per-host external proxies (Merkl, Fuul, Incentra, Goldsky subgraph) with TTL + in-flight dedup
- Vault snapshot pipeline (`/api/internal/vaults`) with two-pass client hydration
- V3 proxy allowlist, rate limits, failure backoff, and troubleshooting
- V3-conditional warm-cache cadence (1-min vaults timer with V3, 5-min without)
- Bigint wire codec and adversary-safe wrapper tag

### 🔮 [Pyth Oracle Handling](./pyth-oracle-handling.md)

- Pull-based oracle model overview
- Read path (simulation) and write path (transactions)
- Feed collection and batch building

### 📈 [Intrinsic APY](./intrinsic-apy.md)

- SDK/V3 provider architecture
- Vault-entity intrinsic APY fields and refresh cadence
- Source attribution in APY modals
- Adding new providers and tokens

### 🔐 [Keyring Hooks (Private Vaults)](./keyring-hooks.md)

- Keyring identity verification for private vaults
- On-chain credential checking and extension flow
- Operation guard registry for automatic SDK TransactionPlan injection
- UI components (badges, alerts, verification flow)

### 🪙 [Token List](./token-list.md)

- Four-source token list (Euler SDK, DefiLlama, Uniswap, Merkl reward tokens)
- Parallel fetch via `Promise.allSettled` with per-source stale fallback
- Pre-populated at server startup by `warm-cache.ts`
- CSP considerations for logo URLs

### 🌍 [Geo-Blocking](./geo-blocking.md)

- Country detection and sanctioned country lists
- Product-level, per-vault, earn-vault, and asset-level blocking rules
- Asset-level pattern matching (exact `symbols`/`names` + `symbolRegex`/`nameRegex`) and cross-chain `all/assets.json`
- Country group aliases (EU, EEA, EFTA)
- UI enforcement across browse, detail, action, and modal pages, plus the arbitrary-asset swap selector

### 🌐 [Public API](./public-api.md)

- Publicly reachable endpoints under `/api/public/` (CORS `*`)
- `GET /api/public/is-known` — verified-vault lookup by address (or list mode)
- `GET /api/public/metadata` — uniform vault display metadata (name / description / governing entity / asset) across EVK, Securitize, and Earn
- Request/response shape, caching, rate limits, and examples

### 📣 [Announcement Modal](./announcement-modal.md)

- Deployment-controlled one-time modal for operational notices
- `CONFIG_ANNOUNCEMENT_*` and `NUXT_PUBLIC_CONFIG_ANNOUNCEMENT_*` setup
- Dismissal token lifecycle, URL safety rules, and rollout troubleshooting

### 📉 [Earn Uncovered Losses](./earn-uncovered-losses.md)

- EulerEarn Statistics row for still-unbacked shortfalls
- Why `vault.lostAssets` is already coverage-normalized (do not re-net `address(1)`)
- Off-chain USD formatting, race-guarded display, and scraper `data-field` hooks

## 🎯 Project Overview

**Euler Lite** is a lightweight multi-chain DeFi application that provides lending and borrowing services through the Euler Finance protocol. It supports multiple EVM chains and connects via standard EVM wallets. The application allows users to:

- **Lend Assets**: Deposit crypto assets to earn yield
- **Borrow Assets**: Use collateral to borrow other assets
- **Swap Collateral & Debt**: Swap between collateral or debt assets via integrated DEX routing
- **Swap-and-Supply/Borrow**: Deposit or borrow with automatic cross-asset swaps
- **Repay from Savings**: Repay debt using savings positions (same or cross-asset)
- **Explore Markets**: Discover and compare markets grouped by curator/product
- **Manage Portfolio**: Track positions, rewards, and performance
- **Access Rewards**: Participate in Merkl, Incentra, and Fuul reward programs

## 🏛️ Key Technologies

- **Frontend**: Nuxt.js 3, Vue 3, TypeScript
- **Blockchain**: Multiple EVM chains
- **DeFi Protocol**: Euler Finance
- **Wallet Integration**: Wagmi / Reown (EVM wallets)
- **Styling**: SCSS with custom design system
- **State Management**: Vue Composition API with composables
- **Linting**: ESLint (flat config) with pre-commit hooks (simple-git-hooks + lint-staged)
- **Testing**: Vitest (unit/integration)

## 🔗 Quick Links

- [Euler Finance Documentation](https://docs.euler.finance/)
- [Merkl Documentation](https://docs.merkl.xyz/)

## 📞 Support

For questions about this documentation or the project:

- Create an issue in the GitHub repository
- Contact the development team
- Check the [Development Guide](./development-guide.md) for common issues

---
