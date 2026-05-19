import type { EVaultHookedOperations, EVault } from '@eulerxyz/euler-v2-sdk'
import { zeroAddress, getAddress } from 'viem'

export type VaultOperation = keyof EVaultHookedOperations

export const OP_DEPOSIT = 'deposit' satisfies VaultOperation
export const OP_MINT = 'mint' satisfies VaultOperation
export const OP_WITHDRAW = 'withdraw' satisfies VaultOperation
export const OP_REDEEM = 'redeem' satisfies VaultOperation
export const OP_TRANSFER = 'transfer' satisfies VaultOperation
export const OP_SKIM = 'skim' satisfies VaultOperation
export const OP_BORROW = 'borrow' satisfies VaultOperation
export const OP_REPAY = 'repay' satisfies VaultOperation
export const OP_REPAY_WITH_SHARES = 'repayWithShares' satisfies VaultOperation
export const OP_PULL_DEBT = 'pullDebt' satisfies VaultOperation
export const OP_CONVERT_FEES = 'convertFees' satisfies VaultOperation
export const OP_LIQUIDATE = 'liquidate' satisfies VaultOperation
export const OP_FLASHLOAN = 'flashloan' satisfies VaultOperation
export const OP_TOUCH = 'touch' satisfies VaultOperation
export const OP_VAULT_STATUS_CHECK = 'vaultStatusCheck' satisfies VaultOperation

export interface VaultOpMeta {
  op: VaultOperation
  name: string
  description: string
  affectedFlows: string[]
  internal: boolean
}

// Human-facing metadata for every EVault hook operation.
// `affectedFlows` lists the euler-lite user flows that call the op; used to
// explain blast-radius when a risk manager has paused or hooked the op.
export const VAULT_OPS: readonly VaultOpMeta[] = [
  {
    op: OP_DEPOSIT,
    name: 'Deposit',
    description: 'Depositing assets into the vault',
    affectedFlows: ['Supply', 'Borrow (collateral)', 'Multiply'],
    internal: false,
  },
  {
    op: OP_MINT,
    name: 'Mint',
    description: 'Minting vault shares directly',
    affectedFlows: [],
    internal: false,
  },
  {
    op: OP_WITHDRAW,
    name: 'Withdraw',
    description: 'Withdrawing assets from the vault',
    affectedFlows: ['Withdraw', 'Same-asset repay', 'Same-asset swap', 'Cross-asset swap', 'Savings repay'],
    internal: false,
  },
  {
    op: OP_REDEEM,
    name: 'Redeem',
    description: 'Redeeming vault shares for assets',
    affectedFlows: ['Redeem shares', 'Same-asset swap (redeem path)'],
    internal: false,
  },
  {
    op: OP_TRANSFER,
    name: 'Transfer',
    description:
      'Transferring vault shares between accounts. Central to euler-lite: borrow and multiply route shares through sub-accounts, and full-repay / disable-collateral sweep residual shares back to the main account via transferFromMax.',
    affectedFlows: [
      'Borrow (collateral share transfer)',
      'Borrow-by-saving',
      'Multiply (savings-sourced)',
      'Disable collateral',
      'Full repay (sweep-back)',
      'Cross-asset swap',
      'Swap & repay',
    ],
    internal: false,
  },
  {
    op: OP_SKIM,
    name: 'Skim',
    description: 'Minting shares to a recipient for assets already transferred into the vault but not yet accounted for',
    affectedFlows: ['Same-asset swap (target)', 'Savings repay', 'Same-asset repay', 'Swap & borrow (supply side)'],
    internal: false,
  },
  {
    op: OP_BORROW,
    name: 'Borrow',
    description: 'Borrowing assets from the vault',
    affectedFlows: ['Borrow', 'Multiply', 'Swap & borrow', 'Borrow-by-saving'],
    internal: false,
  },
  {
    op: OP_REPAY,
    name: 'Repay',
    description: 'Repaying debt',
    affectedFlows: ['Wallet repay', 'Swap & repay'],
    internal: false,
  },
  {
    op: OP_REPAY_WITH_SHARES,
    name: 'Repay with shares',
    description: 'Repaying debt using vault shares',
    affectedFlows: ['Same-asset repay', 'Savings repay'],
    internal: false,
  },
  {
    op: OP_PULL_DEBT,
    name: 'Pull debt',
    description: 'Pulling debt from another account',
    affectedFlows: [],
    internal: false,
  },
  {
    op: OP_LIQUIDATE,
    name: 'Liquidate',
    description: 'Liquidating unhealthy positions',
    affectedFlows: [],
    internal: false,
  },
  {
    op: OP_FLASHLOAN,
    name: 'Flash loan',
    description: 'Executing flash loans',
    affectedFlows: [],
    internal: false,
  },
  {
    op: OP_CONVERT_FEES,
    name: 'Convert fees',
    description: 'Converting accrued fees into shares',
    affectedFlows: [],
    internal: true,
  },
  {
    op: OP_TOUCH,
    name: 'Touch',
    description: 'Updating interest accrual',
    affectedFlows: [],
    internal: true,
  },
  {
    op: OP_VAULT_STATUS_CHECK,
    name: 'Vault status check',
    description: 'Validating vault invariants',
    affectedFlows: [],
    internal: true,
  },
] as const

export const getVaultHookedOperations = (vault: EVault): EVaultHookedOperations =>
  vault.hooks.hookedOperations

export const getVaultHookTarget = (vault: EVault): string =>
  vault.hooks.hookTarget ?? zeroAddress

export const isHookDisabling = (vault: EVault): boolean => {
  try {
    return getAddress(getVaultHookTarget(vault)) === zeroAddress
  }
  catch {
    return false
  }
}

export const isOpHooked = (vault: EVault, op: VaultOperation): boolean =>
  getVaultHookedOperations(vault)[op] === true

// The EVC calls checkVaultStatus at the end of every batch that touches the
// vault. If vaultStatusCheck is hooked and the hook target is zero, EVERY user
// operation on the vault reverts.
export const isVaultEffectivelyPaused = (vault: EVault): boolean => {
  if (!isHookDisabling(vault)) return false
  if (isOpHooked(vault, OP_VAULT_STATUS_CHECK)) return true
  return areAllUserOpsHooked(getVaultHookedOperations(vault))
}

export const isOpDisabled = (vault: EVault, op: VaultOperation): boolean => {
  if (!isHookDisabling(vault)) return false
  return isOpHooked(vault, op) || isOpHooked(vault, OP_VAULT_STATUS_CHECK)
}

export const getHookedOperationMetas = (
  hookedOperations: EVaultHookedOperations,
  { includeInternal = false }: { includeInternal?: boolean } = {},
): VaultOpMeta[] =>
  VAULT_OPS.filter(meta => hookedOperations[meta.op] && (includeInternal || !meta.internal))

export const hasAnyHookedOperation = (
  hookedOperations: EVaultHookedOperations,
  { includeInternal = true }: { includeInternal?: boolean } = {},
): boolean =>
  VAULT_OPS.some(meta => hookedOperations[meta.op] && (includeInternal || !meta.internal))

export const areAllUserOpsHooked = (hookedOperations: EVaultHookedOperations): boolean =>
  VAULT_OPS.every(meta => meta.internal || hookedOperations[meta.op])

// Compact row value for the Risk parameters row.
// "None" | "Paused" | "Deposit" | "Deposit, Mint" | "Deposit, Mint & 3 more"
// "Paused" is emitted by the caller when the vault is effectively paused.
export const formatHookedOpsSummary = (ops: VaultOpMeta[]): string => {
  if (ops.length === 0) return 'None'
  if (ops.length === 1) return ops[0].name
  if (ops.length === 2) return `${ops[0].name}, ${ops[1].name}`
  return `${ops[0].name}, ${ops[1].name} & ${ops.length - 2} more`
}

export const getOpMeta = (op: VaultOperation): VaultOpMeta | undefined =>
  VAULT_OPS.find(meta => meta.op === op)

// Pre-submission validation for multi-step transaction plans.
//
// Each composable/page that submits an SDK plan declares the ordered (vault,
// op) pairs the resulting batch will touch. Running that list through
// findBlockingDisabledOp lets forms surface a pointed error before the user
// signs, instead of a cryptic on-chain revert. Keep the per-flow planned-ops
// map in sync when adding new flows. Reference mapping to SDK planners:
//
//   planDeposit                     [{ target, OP_DEPOSIT }]
//   planWithdraw / planRedeem       [{ target, OP_WITHDRAW / OP_REDEEM }]
//   planBorrow (wallet collateral)  [{ coll, OP_DEPOSIT }, { liab, OP_BORROW }]
//   planBorrow (savings collateral) [{ coll, OP_TRANSFER }, { liab, OP_BORROW }]
//   planRepayFromWallet             [{ liab, OP_REPAY }]  (+ { coll, OP_TRANSFER } on cleanupOnMax)
//   planRepayFromDeposit            [{ src, OP_WITHDRAW }, { liab, OP_SKIM }, { liab, OP_REPAY_WITH_SHARES }]
//   planRepayWithSwap               [{ src, OP_WITHDRAW }, { liab, OP_REPAY }]
//   planTransfer (disableCollateral) [{ coll, OP_TRANSFER }]
//   planMultiplyWithSwap (fresh)    [{ coll, OP_DEPOSIT }, { liab, OP_BORROW }, { long, OP_SKIM }]
//   planMultiplyWithSwap (savings)  [{ coll, OP_TRANSFER }, { liab, OP_BORROW }, { long, OP_SKIM }]
//   planMultiplySameAsset           [{ coll, OP_DEPOSIT }, { liab, OP_BORROW }]
//   planMigrateSameAssetCollateral  [{ from, OP_WITHDRAW / OP_REDEEM }, { to, OP_SKIM }]
//   planMigrateSameAssetDebt        [{ new, OP_BORROW }, { old, OP_SKIM }, { old, OP_REPAY_WITH_SHARES }]
//   planSwapCollateral              [{ from, OP_WITHDRAW }]
//   planDepositWithSwapFromWallet   [{ to, OP_DEPOSIT } via skim]
//   planWithdrawAndSwap/RedeemAndSwap [{ src, OP_WITHDRAW / OP_REDEEM }]
//   planSwapAndBorrowFromWallet     [{ liab, OP_BORROW }]
//   planSwapAndRepayFromWallet      [{ liab, OP_REPAY }]
//   planSwapDebt                    [{ new, OP_BORROW }, { old, OP_REPAY }]
export interface PlannedOp {
  vault: EVault
  op: VaultOperation
  label?: string
}

export const findBlockingDisabledOp = (
  steps: readonly PlannedOp[],
): PlannedOp | null => {
  for (const step of steps) {
    if (isOpDisabled(step.vault, step.op)) return step
  }
  return null
}
