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
- Intrinsic APY for yield-bearing assets (DefiLlama + Pendle)

### 📊 [Portfolio Logic](./portfolio-logic.md)

- Position discovery and categorization
- Lens contract usage
- Borrow, deposit, and earn position loading

### 🏷️ [Vault Labels & Verification](./vault-labels-and-verification.md)

- Vault verification and trust levels
- Label data sources and types
- Unknown vault resolution

### 🔧 [Transaction Building](./transaction-building.md)

- TxPlan architecture and composite operations
- EVC batching and Permit2 integration
- Sub-accounts and position isolation

### 🔮 [Pyth Oracle Handling](./pyth-oracle-handling.md)

- Pull-based oracle model overview
- Read path (simulation) and write path (transactions)
- Feed collection and batch building

### 📈 [Intrinsic APY](./intrinsic-apy.md)

- Multi-provider architecture (DefiLlama + Pendle)
- Address-based lookup with TTL caching
- Source attribution in APY modals
- Adding new providers and tokens

### 🔐 [Keyring Hooks (Private Vaults)](./keyring-hooks.md)

- Keyring identity verification for private vaults
- On-chain credential checking and extension flow
- Operation guard registry for automatic TxPlan injection
- UI components (badges, alerts, verification flow)

### 🪙 [Token List](./token-list.md)

- Three-source token list (Euler API, DefiLlama, Uniswap)
- Euler-first blocking strategy with lazy supplemental sources
- One-shot 15s retry for supplemental data pickup
- CSP considerations for logo URLs

### 🌍 [Geo-Blocking](./geo-blocking.md)

- Country detection and sanctioned country lists
- Product-level and per-vault blocking overrides
- Country group aliases (EU, EEA, EFTA)
- UI enforcement across browse, detail, action, and modal pages

### 🌐 [Public API](./public-api.md)

- Publicly reachable endpoints under `/api/public/` (CORS `*`)
- `GET /api/public/is-known` — verified-vault lookup by address
- Request/response shape, caching, rate limits, and examples

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
- **Testing**: Playwright (E2E)

## 🔗 Quick Links

- [Euler Finance Documentation](https://docs.euler.finance/)
- [Merkl Documentation](https://docs.merkl.xyz/)

## 📞 Support

For questions about this documentation or the project:

- Create an issue in the GitHub repository
- Contact the development team
- Check the [Development Guide](./development-guide.md) for common issues

---
