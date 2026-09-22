import { describe, expect, it } from 'vitest'
import { decodeFunctionData, getAddress, type Hash } from 'viem'
import { SwapVerificationType, flattenBatchEntries, type SwapQuote, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { createOperationIntent } from '~/features/reviewed-execution/domain/factory'
import { createLiteIntentCompilerRegistry } from '~/features/reviewed-execution/planning/lite-compilers'
import { transactionPlanDigest } from '~/features/reviewed-execution/planning/plan-digest'
import type { PlanningSnapshot } from '~/features/reviewed-execution/planning/snapshot-loader'
import { ADDR, buildSdkAccount, buildSdkExecutionService } from '../golden/harness'

const HASH = `0x${'11'.repeat(32)}` as Hash
const SUB = ADDR.subAccount1
const SOURCE_VAULT = ADDR.vaultWeth
const DEST_VAULT = ADDR.vaultUsdc

const snapshot: PlanningSnapshot = {
  schemaVersion: 1,
  intentSetHash: HASH,
  owner: ADDR.user,
  chainId: 1,
  observedBlock: 1n,
  dataSourceVersions: {},
  records: {},
  digest: HASH,
}

const COLLATERAL_ABI = [
  { type: 'function', name: 'enableCollateral', stateMutability: 'payable', inputs: [{ name: 'account', type: 'address' }, { name: 'vault', type: 'address' }], outputs: [] },
  { type: 'function', name: 'disableCollateral', stateMutability: 'payable', inputs: [{ name: 'account', type: 'address' }, { name: 'vault', type: 'address' }], outputs: [] },
] as const

/** Names every EVC collateral toggle in the plan; other batch items are vault calls. */
const evcFunctionNames = (plan: TransactionPlan) => plan.flatMap(item => item.type === 'evcBatch'
  ? flattenBatchEntries(item.items).map((entry) => {
      if (getAddress(entry.targetContract) !== ADDR.evc) return 'vaultCall'
      const decoded = decodeFunctionData({ abi: COLLATERAL_ABI, data: entry.data })
      return `${decoded.functionName}(${getAddress(decoded.args[1]) === DEST_VAULT ? 'dest' : 'source'})`
    })
  : [item.type])

const crossAssetQuote = (): SwapQuote => ({
  amountIn: '1000',
  amountInMax: '1000',
  amountOut: '900',
  amountOutMin: '850',
  accountIn: SUB,
  accountOut: SUB,
  vaultIn: SOURCE_VAULT,
  receiver: DEST_VAULT,
  tokenIn: { address: ADDR.assetWeth, chainId: 1, decimals: 18, logoURI: '', name: 'WETH', symbol: 'WETH' },
  tokenOut: { address: ADDR.assetUsdc, chainId: 1, decimals: 6, logoURI: '', name: 'USDC', symbol: 'USDC' },
  slippage: 0.5,
  swap: { swapperAddress: ADDR.swapper, swapperData: '0x1234', multicallItems: [] },
  verify: { verifierAddress: ADDR.swapVerifier, verifierData: '0x1234', type: SwapVerificationType.SkimMin, vault: DEST_VAULT, account: SUB, amount: '850', deadline: 2_000_000_000 },
  route: [{ providerName: 'test' }],
})

/** Both vaults hold collateral and both are enabled on the real account. */
const realAccount = () => buildSdkAccount({
  positions: [
    { subAccount: SUB, vault: SOURCE_VAULT, asset: ADDR.assetWeth, shares: 1000n, assets: 1000n, isCollateral: true },
    { subAccount: SUB, vault: DEST_VAULT, asset: ADDR.assetUsdc, shares: 500n, assets: 500n, isCollateral: true },
  ],
})

/** What the batch simulator hands back after the withdraw entry ran: destination emptied and disabled. */
const accountAfterWithdraw = () => buildSdkAccount({
  positions: [
    { subAccount: SUB, vault: SOURCE_VAULT, asset: ADDR.assetWeth, shares: 1000n, assets: 1000n, isCollateral: true },
  ],
})

const withdrawIntent = () => createOperationIntent({
  kind: 'withdraw',
  planner: 'withdraw',
  args: { vaultAddress: DEST_VAULT, assets: 500n, owner: SUB, receiver: ADDR.user, disableCollateral: true },
  chainId: 1,
  account: ADDR.user,
  subAccounts: [SUB],
  source: 'test',
  createdAt: 1,
  intentId: 'withdraw-dest',
})

const refinanceIntent = () => createOperationIntent({
  kind: 'refinance',
  planner: 'refinance-position',
  args: { collateral: { planner: 'swap-collateral', args: { swapQuote: crossAssetQuote(), swapperMode: 0 } } },
  chainId: 1,
  account: ADDR.user,
  subAccounts: [SUB],
  source: 'test',
  createdAt: 2,
  intentId: 'refinance-into-dest',
})

// A cart previews each row against the simulated state left by the rows before
// it, while review preparation recompiles every intent against one fresh
// account. The SDK planners derive EVC collateral toggles from whichever
// account they receive, so the two compiles can disagree. These tests pin that
// divergence with the real planners; the preparation service refuses to seal
// when it happens (see the reviewed plan parity tests for the service).
describe('cart recompilation against the original account state', () => {
  const executionService = buildSdkExecutionService()
  const sdk = { executionService } as never
  const registry = createLiteIntentCompilerRegistry(sdk)

  it('contextual row planning re-enables the destination collateral', async () => {
    const compiled = await registry.compile([refinanceIntent()], {
      snapshot,
      runtime: { account: accountAfterWithdraw(), sdk },
    }, () => {})
    expect(evcFunctionNames(compiled.plan)).toContain('enableCollateral(dest)')
  })

  it('whole-cart compilation omits the enablement the preview showed', async () => {
    const compiled = await registry.compile([withdrawIntent(), refinanceIntent()], {
      snapshot,
      runtime: { account: realAccount(), sdk },
    }, () => {})
    const calls = evcFunctionNames(compiled.plan)
    // The withdraw disables the destination, the refinance disables the source
    // (isMax), and nothing re-enables the destination.
    expect(calls).toContain('disableCollateral(dest)')
    expect(calls).toContain('disableCollateral(source)')
    expect(calls).not.toContain('enableCollateral(dest)')
  })

  it('the reviewed plan digest tells the two compiles apart', async () => {
    const reviewed = await registry.compile([refinanceIntent()], {
      snapshot,
      runtime: { account: accountAfterWithdraw(), sdk },
    }, () => {})
    const recompiled = await registry.compile([withdrawIntent(), refinanceIntent()], {
      snapshot,
      runtime: { account: realAccount(), sdk },
    }, () => {})
    const recompiledRefinance = recompiled.intentPlans.find(entry => entry.intentId === 'refinance-into-dest')
    expect(recompiledRefinance).toBeDefined()
    expect(transactionPlanDigest(recompiledRefinance!.plan)).not.toBe(transactionPlanDigest(reviewed.plan))
  })
})
