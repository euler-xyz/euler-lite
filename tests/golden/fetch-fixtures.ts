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

async function main() {
  // --- 1. Collateral swap (planSwapCollateral / buildSwapPlan)
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

  // --- 2. Wallet swap (planSwapFromWallet / buildSwapAndSupplyPlan no-deposit branch)
  //
  // SDK fetchWalletSwapQuote — transferOutputToReceiver=true so verify type is
  // TransferMin (output is sent to receiver wallet, not deposited).
  {
    const args = {
      chainId: CHAIN_ID,
      fromAsset: ADDR.assetUsdc,
      toAsset: ADDR.assetDai,
      amount: 500_000n,
      receiver: ADDR.user,
      origin: ADDR.user,
      slippage: SLIPPAGE,
      deadline: FIXED_DEADLINE,
    } as const
    const quotes = await swapService.fetchWalletSwapQuote(args)
    writeFixture('swap-wallet-usdc-to-dai', args, pickConcreteQuote(quotes, 'walletSwap'))
  }

  // --- 3. Wallet-to-vault deposit (planDepositWithSwapFromWallet / buildSwapAndSupplyPlan)
  //
  // SDK fetchDepositQuote with fromAccount=fromVault=zero (wallet input) and
  // toAccount/toVault = destination vault. Verify type is SkimMin.
  {
    const args = {
      chainId: CHAIN_ID,
      fromVault: zeroAddress as Address,
      toVault: ADDR.vaultDai,
      fromAccount: zeroAddress as Address,
      toAccount: ADDR.subAccount1,
      fromAsset: ADDR.assetUsdc,
      toAsset: ADDR.assetDai,
      amount: 500_000n,
      origin: ADDR.user,
      slippage: SLIPPAGE,
      deadline: FIXED_DEADLINE,
      unusedInputReceiver: ADDR.user,
    } as const
    const quotes = await swapService.fetchDepositQuote(args)
    writeFixture('swap-wallet-deposit-usdc-to-dai', args, pickConcreteQuote(quotes, 'walletDeposit'))
  }

  // --- 4. Repay with collateral swap (planRepayWithSwap / buildRepayWithSwap)
  //
  // SDK fetchRepayQuotes EXACT_IN: swap a fixed amount of USDC collateral
  // into DAI and forward the output to the DAI liability vault. Verify type
  // DebtMax. currentDebt is expressed in DAI's 18 decimals — sized so the
  // swap output is a partial repay (resolvedIsMax stays false).
  {
    const currentDebt = 10_000_000_000_000_000_000n // 10 DAI
    const args = {
      chainId: CHAIN_ID,
      fromVault: ADDR.vaultUsdc,
      fromAsset: ADDR.assetUsdc,
      fromAccount: ADDR.subAccount1,
      liabilityVault: ADDR.vaultDai,
      liabilityAsset: ADDR.assetDai,
      currentDebt,
      toAccount: ADDR.subAccount1,
      origin: ADDR.user,
      swapperMode: SwapperMode.EXACT_IN,
      slippage: SLIPPAGE,
      collateralAmount: 900_000n,
      deadline: FIXED_DEADLINE,
    } as const
    const quotes = await swapService.fetchRepayQuotes(args)
    writeFixture('swap-repay-partial-usdc-to-dai', args, pickConcreteQuote(quotes, 'repayPartial'))
  }

  // --- 5. Withdraw-and-swap (planWithdrawAndSwap / buildWithdrawAndSwapPlan)
  //
  // Withdraw underlying from a vault, swap it, transfer output to receiver.
  // Equivalent to a wallet swap whose input is a vault withdraw — handled by
  // fetchDepositQuote with transferOutputToReceiver.
  // The SDK's fetchDepositQuote doesn't expose transferOutputToReceiver directly;
  // we hit fetchSwapQuotes for it.
  {
    const args = {
      chainId: CHAIN_ID,
      tokenIn: ADDR.assetUsdc,
      tokenOut: ADDR.assetDai,
      amount: 750_000n,
      vaultIn: ADDR.vaultUsdc,
      receiver: ADDR.user,
      origin: ADDR.user,
      accountIn: ADDR.subAccount1,
      accountOut: zeroAddress as Address,
      slippage: SLIPPAGE,
      swapperMode: SwapperMode.EXACT_IN,
      isRepay: false,
      targetDebt: 0n,
      currentDebt: 0n,
      deadline: FIXED_DEADLINE,
      transferOutputToReceiver: true,
      skipSweepDepositOut: true,
    } as const
    const quotes = await swapService.fetchSwapQuotes(args)
    writeFixture('swap-withdraw-and-swap-usdc-to-dai', args, pickConcreteQuote(quotes, 'withdrawAndSwap'))
  }

  // --- (extra) Cross-asset debt swap (planSwapDebt / buildSwapPlan with isDebtSwap)
  //
  // Borrow from new liability vault, swap output into old liability asset,
  // forward to old vault to repay. Verify type DebtMax. Pass an arbitrarily
  // small `currentDebt` so the swap output exceeds it — SDK then treats this
  // as a max repay and emits disableController, matching legacy's
  // unconditional disableController(receiver) for cross-asset debt swaps.
  {
    const currentDebt = 1n
    const args = {
      chainId: CHAIN_ID,
      tokenIn: ADDR.assetUsdc,
      tokenOut: ADDR.assetDai,
      amount: 500_000n,
      vaultIn: ADDR.vaultUsdc, // new liability (borrow source)
      receiver: ADDR.vaultDai, // old liability (repay target)
      origin: ADDR.user,
      accountIn: ADDR.subAccount1,
      accountOut: ADDR.subAccount1,
      slippage: SLIPPAGE,
      swapperMode: SwapperMode.EXACT_IN,
      isRepay: true,
      targetDebt: 0n,
      currentDebt,
      deadline: FIXED_DEADLINE,
    } as const
    const quotes = await swapService.fetchSwapQuotes(args)
    writeFixture('swap-debt-usdc-to-dai', args, pickConcreteQuote(quotes, 'swapDebt'))
  }

  // --- (extra) Multiply with swap (planMultiplyWithSwap / buildMultiplyPlan swap path)
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

  // --- (extra) Swap-and-borrow (planSwapAndBorrowFromWallet / buildSwapAndBorrowPlan)
  //
  // Wallet input gets swapped & deposited into a collateral vault, then a
  // borrow is opened against it. Same SkimMin shape as plain deposit.
  {
    const args = {
      chainId: CHAIN_ID,
      fromVault: zeroAddress as Address,
      toVault: ADDR.vaultDai,
      fromAccount: zeroAddress as Address,
      toAccount: ADDR.subAccount1,
      fromAsset: ADDR.assetUsdc,
      toAsset: ADDR.assetDai,
      amount: 500_000n,
      origin: ADDR.user,
      slippage: SLIPPAGE,
      deadline: FIXED_DEADLINE,
      unusedInputReceiver: ADDR.user,
    } as const
    const quotes = await swapService.fetchDepositQuote(args)
    writeFixture('swap-and-borrow-usdc-to-dai', args, pickConcreteQuote(quotes, 'swapAndBorrow'))
  }

  // --- 6. Repay from wallet via swap (planSwapAndRepayFromWallet / buildSwapAndRepayPlan)
  //
  // Wallet token (USDC, 6 decimals) gets swapped into the liability asset
  // (DAI, 18 decimals) and forwarded as a repay. Verify type DebtMax.
  // currentDebt is expressed in DAI's 18 decimals — large enough that the
  // SDK won't treat the partial swap as a full payoff.
  {
    const currentDebt = 10_000_000_000_000_000_000n // 10 DAI
    const args = {
      chainId: CHAIN_ID,
      tokenIn: ADDR.assetUsdc,
      tokenOut: ADDR.assetDai,
      amount: 800_000n,
      vaultIn: zeroAddress as Address,
      receiver: ADDR.vaultDai,
      origin: ADDR.user,
      accountIn: zeroAddress as Address,
      accountOut: ADDR.subAccount1,
      slippage: SLIPPAGE,
      swapperMode: SwapperMode.EXACT_IN,
      isRepay: true,
      targetDebt: 0n,
      currentDebt,
      deadline: FIXED_DEADLINE,
      unusedInputReceiver: ADDR.user,
    } as const
    const quotes = await swapService.fetchSwapQuotes(args)
    writeFixture('swap-wallet-repay-usdc-to-dai', args, pickConcreteQuote(quotes, 'walletRepay'))
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
