import { zeroAddress } from 'viem'
import type { Vault } from '~/entities/vault'

// EVK hook operation bit constants. Source of truth:
// euler-vault-kit/src/EVault/shared/Constants.sol
export const OP_DEPOSIT = 1n
export const OP_MINT = 2n
export const OP_WITHDRAW = 4n
export const OP_REDEEM = 8n
export const OP_TRANSFER = 16n
export const OP_SKIM = 32n
export const OP_BORROW = 64n
export const OP_REPAY = 128n
export const OP_REPAY_WITH_SHARES = 256n
export const OP_PULL_DEBT = 512n
export const OP_CONVERT_FEES = 1024n
export const OP_LIQUIDATE = 2048n
export const OP_FLASHLOAN = 4096n
export const OP_TOUCH = 8192n
export const OP_VAULT_STATUS_CHECK = 16384n

export interface VaultOpMeta {
  bit: bigint
  name: string
  description: string
  affectedFlows: string[]
  internal: boolean
}

// Human-facing metadata for every EVK hook operation.
// `affectedFlows` lists the euler-lite user flows that call the op; used to
// explain blast-radius when a governor has paused or hooked the op.
export const VAULT_OPS: readonly VaultOpMeta[] = [
  {
    bit: OP_DEPOSIT,
    name: 'Deposit',
    description: 'Depositing assets into the vault',
    affectedFlows: ['Supply', 'Borrow (collateral)', 'Multiply'],
    internal: false,
  },
  {
    bit: OP_MINT,
    name: 'Mint',
    description: 'Minting vault shares directly',
    affectedFlows: [],
    internal: false,
  },
  {
    bit: OP_WITHDRAW,
    name: 'Withdraw',
    description: 'Withdrawing assets from the vault',
    affectedFlows: ['Withdraw', 'Repay with shares', 'Same-asset swap', 'Cross-asset swap', 'Savings repay'],
    internal: false,
  },
  {
    bit: OP_REDEEM,
    name: 'Redeem',
    description: 'Redeeming vault shares for assets',
    affectedFlows: ['Redeem shares', 'Same-asset swap (redeem path)'],
    internal: false,
  },
  {
    bit: OP_TRANSFER,
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
    bit: OP_SKIM,
    name: 'Skim',
    description: 'Pulling unaccounted assets into the vault',
    affectedFlows: ['Same-asset swap (target)', 'Savings repay', 'Repay with shares', 'Swap & borrow (supply side)'],
    internal: false,
  },
  {
    bit: OP_BORROW,
    name: 'Borrow',
    description: 'Borrowing assets from the vault',
    affectedFlows: ['Borrow', 'Multiply', 'Swap & borrow', 'Borrow-by-saving'],
    internal: false,
  },
  {
    bit: OP_REPAY,
    name: 'Repay',
    description: 'Repaying debt',
    affectedFlows: ['Repay', 'Swap & repay'],
    internal: false,
  },
  {
    bit: OP_REPAY_WITH_SHARES,
    name: 'Repay with shares',
    description: 'Repaying debt using vault shares (same-asset / savings repay)',
    affectedFlows: ['Repay with shares', 'Savings repay'],
    internal: false,
  },
  {
    bit: OP_PULL_DEBT,
    name: 'Pull debt',
    description: 'Pulling debt from another account',
    affectedFlows: [],
    internal: false,
  },
  {
    bit: OP_LIQUIDATE,
    name: 'Liquidate',
    description: 'Liquidating unhealthy positions',
    affectedFlows: ['Liquidation'],
    internal: false,
  },
  {
    bit: OP_FLASHLOAN,
    name: 'Flash loan',
    description: 'Executing flash loans (not used by euler-lite directly)',
    affectedFlows: [],
    internal: false,
  },
  {
    bit: OP_CONVERT_FEES,
    name: 'Convert fees',
    description: 'Converting accrued fees into shares',
    affectedFlows: [],
    internal: true,
  },
  {
    bit: OP_TOUCH,
    name: 'Touch',
    description: 'Updating interest accrual',
    affectedFlows: [],
    internal: true,
  },
  {
    bit: OP_VAULT_STATUS_CHECK,
    name: 'Vault status check',
    description: 'Validating vault invariants',
    affectedFlows: [],
    internal: true,
  },
] as const

const ALL_USER_OPS_MASK = VAULT_OPS
  .filter(op => !op.internal)
  .reduce((acc, op) => acc | op.bit, 0n)

export const isHookDisabling = (vault: Vault): boolean =>
  vault.hookTarget === zeroAddress

export const isOpHooked = (vault: Vault, bit: bigint): boolean =>
  (vault.hookedOps & bit) !== 0n

export const isOpDisabled = (vault: Vault, bit: bigint): boolean =>
  isOpHooked(vault, bit) && isHookDisabling(vault)

export const decodeHookedOps = (
  hookedOps: bigint,
  { includeInternal = false }: { includeInternal?: boolean } = {},
): VaultOpMeta[] =>
  VAULT_OPS.filter(op => (hookedOps & op.bit) !== 0n && (includeInternal || !op.internal))

export const areAllUserOpsHooked = (hookedOps: bigint): boolean =>
  (hookedOps & ALL_USER_OPS_MASK) === ALL_USER_OPS_MASK

// Compact row value for the Risk parameters row.
// "None" | "Paused" | "Deposit" | "Deposit, Mint" | "Deposit, Mint & 3 more"
// "Paused" is emitted by the caller when areAllUserOpsHooked(hookedOps) holds;
// this helper handles only the subset path.
export const formatHookedOpsSummary = (ops: VaultOpMeta[]): string => {
  if (ops.length === 0) return 'None'
  if (ops.length === 1) return ops[0].name
  if (ops.length === 2) return `${ops[0].name}, ${ops[1].name}`
  return `${ops[0].name}, ${ops[1].name} & ${ops.length - 2} more`
}

export const getOpMeta = (bit: bigint): VaultOpMeta | undefined =>
  VAULT_OPS.find(op => op.bit === bit)

// Pre-submission validation for multi-step transaction plans.
//
// Each build*Plan in composables/useEulerOperations/ emits an ordered list of
// (vault, op) pairs for the vault operations it triggers. Running that list
// through findBlockingDisabledOp lets forms surface a pointed error before the
// user signs, instead of a cryptic on-chain revert. Keep this builder → ops
// map in sync when adding new flows:
//
//   buildSupplyPlan              [{ target, OP_DEPOSIT }]
//   buildWithdrawPlan            [{ target, OP_WITHDRAW }]
//   buildRedeemPlan              [{ target, OP_REDEEM }]
//   buildBorrowPlan (fresh)      [{ coll, OP_DEPOSIT }, { coll, OP_TRANSFER }, { liab, OP_BORROW }]
//   buildBorrowPlan (shares)     [{ coll, OP_TRANSFER }, { liab, OP_BORROW }]
//   buildRepayPlan               [{ liab, OP_REPAY }]
//   buildFullRepayPlan           [{ liab, OP_REPAY }, { coll, OP_TRANSFER }]
//   buildSameAsset*Repay         [{ savings, OP_WITHDRAW }, { liab, OP_SKIM }, { liab, OP_REPAY_WITH_SHARES }]
//   buildSavingsFullRepayPlan    [{ savings, OP_WITHDRAW }, { savings, OP_TRANSFER }, { liab, OP_REPAY_WITH_SHARES }]
//   buildDisableCollateralPlan   [{ coll, OP_TRANSFER }]
//   buildMultiplyPlan (fresh)    [{ coll, OP_DEPOSIT }, { liab, OP_BORROW }] (+ { long, OP_SKIM } when SkimMin verifier)
//   buildMultiplyPlan (savings)  [{ coll, OP_TRANSFER }, { liab, OP_BORROW }] (+ { long, OP_SKIM } when SkimMin verifier)
//   buildSameAssetSwapPlan       [{ from, OP_WITHDRAW|OP_REDEEM }, { to, OP_SKIM }]
//   buildSwapPlan (cross-asset)  [{ from, OP_WITHDRAW }]
//   buildWithdraw/RedeemAndSwap  [{ src, OP_WITHDRAW|OP_REDEEM }]
//   buildSwapAndBorrowPlan       [{ liab, OP_BORROW }]
//   buildSwapAndRepayPlan        [{ liab, OP_REPAY }]
//   buildBorrowBySavingPlan      [{ savings, OP_TRANSFER }, { liab, OP_BORROW }]
export interface PlannedOp {
  vault: Vault
  op: bigint
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

const getVaultDisplayName = (vault: Vault): string =>
  vault.name || vault.symbol || vault.asset?.symbol || 'vault'

// Human-readable reason for a single (vault, op) pair that would revert.
// `null` when the op is not disabled. Used as a tooltip / inline error.
export const getOpBlockedReason = (vault: Vault, op: bigint): string | null => {
  if (!isOpDisabled(vault, op)) return null
  const meta = getOpMeta(op)
  const name = meta?.name ?? 'This operation'
  return `${name} is currently disabled on the ${getVaultDisplayName(vault)} vault.`
}

// Human-readable reason for a multi-step flow. Returns the first blocking op.
export const getPlanBlockedReason = (steps: readonly PlannedOp[]): string | null => {
  const blocking = findBlockingDisabledOp(steps)
  if (!blocking) return null
  return getOpBlockedReason(blocking.vault, blocking.op)
}
