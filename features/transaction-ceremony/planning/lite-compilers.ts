import type { Account, IHasVaultAddress, TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import type { Address } from 'viem'
import type { CanonicalValue } from '../domain/canonical'
import type { CeremonySwapQuote } from '../domain/swap-quote'
import { rehydrateCeremonySwapQuote } from '../domain/swap-quote'
import { IntentCompilerRegistry, type IntentCompiler, type IntentCompilerContext } from './compiler'
import type { OperationIntent, PlannerName } from '../domain/intents'

interface LiteExecutionService {
  mergePlans(plans: TransactionPlan[]): TransactionPlan
  planDeposit(args: never): TransactionPlan
  planWithdraw(args: never): TransactionPlan
  planRedeem(args: never): TransactionPlan
  planBorrow(args: never): TransactionPlan
  planRepayFromWallet(args: never): TransactionPlan
  planRepayFromDeposit(args: never): TransactionPlan
  planRepayWithSwap(args: never): TransactionPlan
  planDepositWithSwapFromWallet(args: never): TransactionPlan
  planSwapFromWallet(args: never): TransactionPlan
  planSwapAndBorrowFromWallet(args: never): TransactionPlan
  planSwapAndRepayFromWallet(args: never): TransactionPlan
  planWithdrawAndSwap(args: never): TransactionPlan
  planRedeemAndSwap(args: never): TransactionPlan
  planSwapCollateral(args: never): TransactionPlan
  planSwapDebt(args: never): TransactionPlan
  planMigrateSameAssetCollateral(args: never): TransactionPlan
  planMigrateSameAssetDebt(args: never): TransactionPlan
  planMultiplyWithSwap(args: never): TransactionPlan
  planMultiplySameAsset(args: never): TransactionPlan
  planTransfer(args: never): TransactionPlan
  planCleanup(args: never): TransactionPlan
}

export interface LiteCompilerSdk {
  executionService: LiteExecutionService
}

export interface LiteCompilerRuntime {
  account: Account<IHasVaultAddress>
  sdk: LiteCompilerSdk
  compileCrossProtocolMigration?: (intent: OperationIntent, context: IntentCompilerContext) => Promise<TransactionPlan>
  compileRewardClaim?: (intent: OperationIntent) => Promise<TransactionPlan>
  compileREULUnlock?: (intent: OperationIntent) => Promise<TransactionPlan>
}

const runtimeFrom = (context: IntentCompilerContext): LiteCompilerRuntime => {
  const runtime = context.runtime as unknown as Partial<LiteCompilerRuntime>
  if (!runtime.account || !runtime.sdk) throw new Error('The ceremony compiler runtime is incomplete')
  if (runtime.account.chainId !== context.snapshot.chainId || runtime.account.owner.toLowerCase() !== context.snapshot.owner.toLowerCase()) {
    throw new Error('The compiler account does not match the pinned planning snapshot')
  }
  return runtime as LiteCompilerRuntime
}

const plannerArgs = (intent: OperationIntent): Record<string, unknown> => {
  const args: Record<string, unknown> = { ...intent.planner.args }
  for (const key of ['swapQuote', 'collateralSwapQuote', 'debtSwapQuote']) {
    if (args[key]) args[key] = rehydrateCeremonySwapQuote(args[key] as CeremonySwapQuote)
  }
  return args
}

const rehydrateNestedPlannerArgs = (value: unknown): Record<string, unknown> => {
  const args = { ...(value as { args: Record<string, unknown> }).args }
  if (args.swapQuote) args.swapQuote = rehydrateCeremonySwapQuote(args.swapQuote as CeremonySwapQuote)
  return args
}

const withAccount = (intent: OperationIntent, context: IntentCompilerContext) => {
  const runtime = runtimeFrom(context)
  const args: Record<string, unknown> = { ...plannerArgs(intent), account: runtime.account }
  return { runtime, args }
}

const compilePublicPlanner = async (intent: OperationIntent, context: IntentCompilerContext): Promise<TransactionPlan> => {
  const { runtime, args } = withAccount(intent, context)
  const service = runtime.sdk.executionService
  if (intent.planner.name === 'refinance-position') {
    const plans: TransactionPlan[] = []
    const collateral = intent.planner.args.collateral
    const debt = intent.planner.args.debt
    if (collateral && typeof collateral === 'object' && !Array.isArray(collateral)) {
      const record = collateral as unknown as { planner: PlannerName, args: Record<string, unknown> }
      const legArgs = { ...rehydrateNestedPlannerArgs(record), account: runtime.account }
      plans.push(record.planner === 'swap-collateral'
        ? service.planSwapCollateral(legArgs as never)
        : service.planMigrateSameAssetCollateral(legArgs as never))
    }
    if (debt && typeof debt === 'object' && !Array.isArray(debt)) {
      const record = debt as unknown as { planner: PlannerName, args: Record<string, unknown> }
      const legArgs = { ...rehydrateNestedPlannerArgs(record), account: runtime.account }
      plans.push(record.planner === 'swap-debt'
        ? service.planSwapDebt(legArgs as never)
        : service.planMigrateSameAssetDebt(legArgs as never))
    }
    if (!plans.length) throw new Error('Refinance intent has no planner legs')
    return service.mergePlans(plans)
  }
  switch (intent.planner.name) {
    case 'deposit':
      return service.planDeposit({ ...args, vault: args.vaultAddress, asset: args.assetAddress } as never)
    case 'withdraw':
      return service.planWithdraw({ ...args, vault: args.vaultAddress } as never)
    case 'redeem':
      return service.planRedeem({ ...args, vault: args.vaultAddress } as never)
    case 'borrow': {
      const { assetAddress: _assetAddress, ...plannerInput } = args
      return service.planBorrow({ ...plannerInput, vault: args.vaultAddress } as never)
    }
    case 'repay-from-wallet': {
      const { liabilityAsset: _liabilityAsset, ...plannerInput } = args
      return service.planRepayFromWallet(plannerInput as never)
    }
    case 'repay-from-deposit': {
      const { liabilityAsset: _liabilityAsset, ...plannerInput } = args
      return service.planRepayFromDeposit(plannerInput as never)
    }
    case 'repay-with-swap':
      return service.planRepayWithSwap(args as never)
    case 'deposit-with-swap':
      return service.planDepositWithSwapFromWallet(args as never)
    case 'swap-from-wallet':
      return service.planSwapFromWallet(args as never)
    case 'swap-and-borrow':
      return service.planSwapAndBorrowFromWallet(args as never)
    case 'swap-and-repay':
      return service.planSwapAndRepayFromWallet(args as never)
    case 'withdraw-and-swap':
      return service.planWithdrawAndSwap({ ...args, vault: args.vaultAddress } as never)
    case 'redeem-and-swap':
      return service.planRedeemAndSwap({ ...args, vault: args.vaultAddress } as never)
    case 'swap-collateral':
      return service.planSwapCollateral(args as never)
    case 'swap-debt':
      return service.planSwapDebt(args as never)
    case 'migrate-same-asset-collateral':
      return service.planMigrateSameAssetCollateral(args as never)
    case 'migrate-same-asset-debt':
      return service.planMigrateSameAssetDebt(args as never)
    case 'multiply-with-swap':
      return service.planMultiplyWithSwap(args as never)
    case 'multiply-same-asset':
      return service.planMultiplySameAsset(args as never)
    case 'transfer':
      return service.planTransfer({ ...args, vault: args.vaultAddress } as never)
    case 'cleanup':
      return service.planCleanup(args as never)
    default:
      throw new Error(`Planner ${intent.planner.name} is not an ExecutionService planner`)
  }
}

const callbackCompiler = (key: 'compileCrossProtocolMigration' | 'compileRewardClaim' | 'compileREULUnlock'): IntentCompiler => ({
  async compile(intent, context) {
    const callback = runtimeFrom(context)[key]
    if (!callback) throw new Error(`Ceremony runtime callback ${key} is unavailable`)
    return callback(intent, context)
  },
})

const PUBLIC_PLANNERS: readonly PlannerName[] = [
  'deposit', 'deposit-with-swap', 'withdraw', 'redeem', 'withdraw-and-swap', 'redeem-and-swap',
  'borrow', 'swap-and-borrow', 'repay-from-wallet', 'repay-from-deposit', 'repay-with-swap',
  'swap-and-repay', 'swap-from-wallet', 'swap-collateral', 'swap-debt',
  'refinance-position',
  'migrate-same-asset-collateral', 'migrate-same-asset-debt', 'multiply-with-swap',
  'multiply-same-asset', 'transfer', 'cleanup',
]

export const createLiteIntentCompilerRegistry = (sdk: LiteCompilerSdk): IntentCompilerRegistry => {
  const publicCompiler: IntentCompiler = { compile: compilePublicPlanner }
  const compilers: Partial<Record<PlannerName, IntentCompiler>> = Object.fromEntries(
    PUBLIC_PLANNERS.map(name => [name, publicCompiler]),
  )
  compilers['cross-protocol-migration'] = callbackCompiler('compileCrossProtocolMigration')
  compilers['reward-claim'] = callbackCompiler('compileRewardClaim')
  compilers['reul-unlock'] = callbackCompiler('compileREULUnlock')
  return new IntentCompilerRegistry(compilers, plans => sdk.executionService.mergePlans([...plans]))
}

export const asCompilerRuntime = (runtime: LiteCompilerRuntime): Readonly<Record<string, unknown>> =>
  runtime as unknown as Readonly<Record<string, unknown>>

export const canonicalPlannerArgs = (intent: OperationIntent): Readonly<Record<string, CanonicalValue>> => intent.planner.args

export const compilerAccount = (context: IntentCompilerContext): Account<IHasVaultAddress> => runtimeFrom(context).account

export const compilerOwner = (context: IntentCompilerContext): Address => compilerAccount(context).owner
