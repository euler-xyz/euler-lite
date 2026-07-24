# Getting Started

Welcome to the Euler Lite project! This guide will help you get up and running with the development environment and understand the basics of the project.

## 🎯 What is Euler Lite?

**Euler Lite** is a lightweight multi-chain DeFi application that provides access to Euler Finance's lending and borrowing services. It supports multiple EVM chains and connects via standard EVM wallets.

### Key Features

- **Lending**: Users can deposit assets to earn yield
- **Borrowing**: Users can borrow assets using collateral
- **Portfolio Management**: Track positions and performance
- **Rewards**: Participate in Merkl, Incentra, and Fuul reward programs
- **Multi-chain**: Connect to any EVM-compatible network

## 🏗️ Technology Stack

### Frontend Framework

- **Nuxt.js 3**: Full-stack Vue.js framework
- **Vue 3**: Progressive JavaScript framework with Composition API
- **TypeScript**: Type-safe JavaScript development
- **SCSS**: Advanced CSS preprocessing with custom design system

### Blockchain & DeFi

- **Euler Finance**: DeFi lending and borrowing protocol
- **Wagmi / Reown (AppKit)**: EVM wallet integration
- **Viem**: Ethereum/EVM interaction library

### Development Tools

- **ESLint**: Code quality and consistency
- **VueUse**: Vue composition utilities

## 🚀 Quick Start

### Prerequisites

- Node.js 24+
- npm package manager
- Git
- Basic knowledge of Vue.js and TypeScript

### Installation

1. **Clone the repository**

   ```bash
   git clone <repository-url>
   cd euler-lite
   ```

2. **Install dependencies**

   ```bash
   npm ci
   ```

3. **Set up environment variables**

   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

4. **Start development server**

   ```bash
   npm run dev
   ```

5. **Open your browser**
   Navigate to `http://localhost:3000`

### Available Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run preview` - Preview production build
- `npm run generate` - Generate static site (requires a running backend for data proxy endpoints)
- `npm run lint` - Run ESLint

## Environment Configuration

The application is configured entirely via environment variables. See the [README](../README.md) for the full reference.

### Key Variables

```bash
# Reown (WalletConnect)
APPKIT_PROJECT_ID=your-project-id
NUXT_PUBLIC_APP_URL=https://your-domain.com

# API URLs
V3_API_URL=https://v3.euler.finance
EULER_SDK_V3_API_KEY=your-v3-api-key # optional
SWAP_API_URL=https://swap.euler.finance

# Chain RPC endpoints (one per chain you want to enable)
RPC_URL_1=https://your-ethereum-rpc.com
SUBGRAPH_URL_1=https://your-subgraph.com
```

## Key External Services

### Euler Finance

- **Purpose**: DeFi lending and borrowing protocol
- **Integration**: Smart contract interactions via EVM (EVC, EVK)
- **Data Source**: Vault information, interest rates, positions

### Pyth Network

- **Purpose**: Pull-based oracle price feeds
- **Integration**: Hermes API (`PYTH_API_KEY`)
- **Data Source**: Real-time price updates for oracle feeds

### Merkl

- **Purpose**: Reward distribution and management
- **Integration**: API for opportunities and rewards
- **Data Source**: Campaign information, user rewards

### Fuul

- **Purpose**: Incentive campaign distribution
- **Integration**: API for incentive campaigns
- **Data Source**: Campaign APR data and claimable rewards

## 🆘 Common Issues

### Build Errors

- Ensure Node.js version is 24+
- Clear `node_modules` and reinstall dependencies
- Check TypeScript compilation errors

### Blockchain Connection Issues

- Verify `RPC_URL_<chainId>` env vars are set correctly
- Ensure matching `SUBGRAPH_URL_<chainId>` or `NUXT_PUBLIC_SUBGRAPH_URI_<chainId>` exists for each chain
- Ensure RPC endpoints are accessible

### Wallet Connection Problems

- Verify `APPKIT_PROJECT_ID` is correct
- Ensure `NUXT_PUBLIC_APP_URL` matches your domain
- Check browser console for errors

## 🤝 Getting Help

- **Documentation**: Check other sections of this documentation
- **Code Issues**: Look at existing components and composables
- **Team Support**: Reach out to the development team

---

_Next: Continue to the [Architecture Overview](./architecture.md) to learn the system design._
