/* eslint-disable no-console -- this script's whole job is console output */
/**
 * Fetches swap quotes from swap-dev.euler.finance via the SDK's SwapService,
 * validated against the deployment in euler-interfaces `EulerChains.json`, and
 * writes the quotes and that deployment to `tests/golden/fixtures/`.
 *
 *   npm run test:golden:fetch-fixtures
 *
 * Regenerate whenever an SDK validation rule changes (verifier args, slippage
 * rounding, etc.), the deployment is redeployed, or a swap scenario is added.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DeploymentService,
  SwapService,
  SwapperMode,
  type Deployment,
  type SwapQuote,
} from '@eulerxyz/euler-v2-sdk'

import { eulerInterfacesRawUrl } from '../../server/utils/euler-interfaces'
import { ADDR, CHAIN_ID } from './harness'
import { DEPLOYMENT_FIXTURE, type GoldenDeployment } from './load-fixture'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = resolvePath(__dirname, 'fixtures')

const SWAP_API_URL = process.env.GOLDEN_SWAP_API_URL ?? 'https://swap-dev.euler.finance'
const DEPLOYMENTS_URL = eulerInterfacesRawUrl('EulerChains.json')
const SLIPPAGE = 0.5
const FIXED_DEADLINE = 4_000_000_000 // year ~2096, in seconds — keeps fixtures deterministic across regenerations

// JSON serializer that preserves bigint values for round-trip.
const jsonReplacer = (_k: string, v: unknown): unknown =>
  typeof v === 'bigint' ? { $bigint: v.toString() } : v

const writeJsonFixture = (name: string, data: unknown) => {
  mkdirSync(FIXTURES_DIR, { recursive: true })
  const path = resolvePath(FIXTURES_DIR, `${name}.json`)
  writeFileSync(path, JSON.stringify(data, jsonReplacer, 2))
  console.log(`✓ ${name} → ${path}`)
}

const writeFixture = (name: string, request: unknown, quote: SwapQuote) => writeJsonFixture(name, { request, quote })

const toGoldenDeployment = ({ addresses }: Deployment): GoldenDeployment => {
  const { swapper, swapVerifier } = addresses.peripheryAddrs ?? {}
  if (!swapper || !swapVerifier) throw new Error(`chain ${CHAIN_ID}: ${DEPLOYMENTS_URL} has no swapper or swapVerifier`)
  return {
    evc: addresses.coreAddrs.evc,
    permit2: addresses.coreAddrs.permit2,
    swapper,
    swapVerifier,
    accountLens: addresses.lensAddrs.accountLens,
  }
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
  const deploymentService = await DeploymentService.build({ deploymentsUrl: DEPLOYMENTS_URL })
  const deployment = toGoldenDeployment(deploymentService.getDeployment(CHAIN_ID))
  const swapService = new SwapService({ swapApiUrl: SWAP_API_URL }, deploymentService)

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

  writeJsonFixture(DEPLOYMENT_FIXTURE, { chainId: CHAIN_ID, ...deployment })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
