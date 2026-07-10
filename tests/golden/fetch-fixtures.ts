/* eslint-disable no-console -- this script's whole job is console output */
/**
 * One-off fetcher that calls swap-dev.euler.finance via the SDK's SwapService
 * and writes the validated quotes to `tests/golden/fixtures/`.
 *
 * Run from the main worktree with:
 *   npm run test:golden:fetch-fixtures
 *
 * The committed JSON files are what the parity tests load. Regenerate them
 * whenever an SDK validation rule changes (verifier args, slippage rounding,
 * etc.) or you need to add a new swap scenario.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type Address, zeroAddress } from 'viem'
import {
  SwapService,
  SwapperMode,
  type Deployment,
  type IDeploymentService,
  type SwapQuote,
} from '@eulerxyz/euler-v2-sdk'

import { ADDR, CHAIN_ID } from './harness'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = resolvePath(__dirname, 'fixtures')

const SWAP_API_URL = process.env.GOLDEN_SWAP_API_URL ?? 'https://swap-dev.euler.finance'
const SLIPPAGE = 0.5
const FIXED_DEADLINE = 4_000_000_000 // year ~2096, in seconds — keeps fixtures deterministic across regenerations

const stubDeployment: Deployment = {
  chainId: CHAIN_ID,
  name: 'mainnet',
  status: 'active',
  addresses: {
    coreAddrs: {
      balanceTracker: zeroAddress as Address,
      eVaultFactory: zeroAddress as Address,
      eVaultImplementation: zeroAddress as Address,
      eulerEarnFactory: zeroAddress as Address,
      evc: ADDR.evc,
      permit2: ADDR.permit2,
      protocolConfig: zeroAddress as Address,
      sequenceRegistry: zeroAddress as Address,
    },
    lensAddrs: {
      accountLens: ADDR.accountLens,
      eulerEarnVaultLens: zeroAddress as Address,
      irmLens: zeroAddress as Address,
      oracleLens: zeroAddress as Address,
      utilsLens: zeroAddress as Address,
      vaultLens: zeroAddress as Address,
    },
    peripheryAddrs: {
      swapper: ADDR.swapper,
      swapVerifier: ADDR.swapVerifier,
    },
  },
}

const deploymentService: IDeploymentService = {
  getDeploymentChainIds: () => [CHAIN_ID],
  getDeployment: (chainId) => {
    if (chainId !== CHAIN_ID) throw new Error(`unexpected chain: ${chainId}`)
    return stubDeployment
  },
  addDeployment: () => { /* noop */ },
}

const swapService = new SwapService({ swapApiUrl: SWAP_API_URL }, deploymentService)

// JSON serializer that preserves bigint values for round-trip.
const jsonReplacer = (_k: string, v: unknown): unknown =>
  typeof v === 'bigint' ? { $bigint: v.toString() } : v

const writeFixture = (name: string, request: unknown, quote: SwapQuote) => {
  mkdirSync(FIXTURES_DIR, { recursive: true })
  const path = resolvePath(FIXTURES_DIR, `${name}.json`)
  writeFileSync(path, JSON.stringify({ request, quote }, jsonReplacer, 2))
  console.log(`✓ ${name} → ${path}`)
}

/** Picks the first non-CoW quote so the on-chain swapper path is exercised. */
const pickConcreteQuote = (quotes: SwapQuote[], scenario: string): SwapQuote => {
  const concrete = quotes.find(q => !q.route.some(hop => hop.providerName?.toLowerCase().includes('cow')))
  if (!concrete) throw new Error(`${scenario}: only CoW quotes returned`)
  return concrete
}

// Only the two swap quotes the canary suite consumes are fetched here. If the
// canary is expanded to another swap operation, add its scenario back.
async function main() {
  // --- Collateral swap (planSwapCollateral)
  //
  // SDK fetchDepositQuote with isRepay=false, EXACT_IN. Verify type is SkimMin.
  {
    const args = {
      chainId: CHAIN_ID,
      fromVault: ADDR.vaultUsdc,
      toVault: ADDR.vaultDai,
      fromAccount: ADDR.subAccount1,
      toAccount: ADDR.subAccount1,
      fromAsset: ADDR.assetUsdc,
      toAsset: ADDR.assetDai,
      amount: 1_000_000n,
      origin: ADDR.user,
      slippage: SLIPPAGE,
      deadline: FIXED_DEADLINE,
    } as const
    const quotes = await swapService.fetchDepositQuote(args)
    writeFixture('swap-collateral-usdc-to-dai', args, pickConcreteQuote(quotes, 'swapCollateral'))
  }

  // --- Multiply with swap (planMultiplyWithSwap)
  //
  // The swap input is funded by a borrow on `vaultIn` (the liability vault).
  // Output is skimmed into `receiver` (the long collateral vault). Verify
  // type SkimMin. accountIn must equal accountOut for the SDK.
  {
    const args = {
      chainId: CHAIN_ID,
      tokenIn: ADDR.assetUsdc, // liability asset (the borrowed token)
      tokenOut: ADDR.assetDai, // long asset
      amount: 500_000n,
      vaultIn: ADDR.vaultUsdc, // liability vault
      receiver: ADDR.vaultDai, // long vault
      origin: ADDR.user,
      accountIn: ADDR.subAccount1,
      accountOut: ADDR.subAccount1,
      slippage: SLIPPAGE,
      swapperMode: SwapperMode.EXACT_IN,
      isRepay: false,
      targetDebt: 0n,
      currentDebt: 0n,
      deadline: FIXED_DEADLINE,
    } as const
    const quotes = await swapService.fetchSwapQuotes(args)
    writeFixture('swap-multiply-usdc-to-dai', args, pickConcreteQuote(quotes, 'multiply'))
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
