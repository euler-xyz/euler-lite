import { getVaultUtilization, getSupplyCapPercentage, getBorrowCapPercentage, isCyclicalNoteVault, isEVKVault, type SecuritizeVault, type Vault } from '~/entities/vault'
import {
  findBlockingDisabledOp,
  getOpMeta,
  isOpDisabled,
  isOpHooked,
  OP_BORROW,
  OP_DEPOSIT,
  OP_MINT,
  OP_REDEEM,
  OP_REPAY,
  OP_REPAY_WITH_SHARES,
  OP_SKIM,
  OP_TRANSFER,
  OP_VAULT_STATUS_CHECK,
  OP_WITHDRAW,
  type PlannedOp,
  type VaultOperation,
} from '~/utils/vault-hooks'

export type WarningLevel = 'info' | 'high' | 'critical'
export type WarningContext = 'lend' | 'borrow' | 'repay' | 'general'

export interface VaultWarning {
  level: WarningLevel
  title: string
  message: string
  tone?: 'success'
}

const UTILISATION_HIGH = 95
const UTILISATION_CRITICAL = 99

const CAP_HIGH = 95
const CAP_CRITICAL = 99

const utilisationMessages: Record<WarningContext, Record<'high' | 'critical', { title: string, message: string }>> = {
  lend: {
    high: {
      title: 'High utilisation',
      message: 'Utilisation is high on this market. Available liquidity is limited, which may affect your ability to withdraw.',
    },
    critical: {
      title: 'Critical utilisation',
      message: 'Utilisation is critically high. Nearly all liquidity has been borrowed. Withdrawals may fail until borrowers repay.',
    },
  },
  borrow: {
    high: {
      title: 'High utilisation',
      message: 'Utilisation is high on this market. Interest rates are elevated and may be volatile.',
    },
    critical: {
      title: 'Critical utilisation',
      message: 'Utilisation is critically high. Interest rates are very elevated. Available liquidity is near zero.',
    },
  },
  repay: {
    high: {
      title: 'High utilisation',
      message: 'Utilisation is high on this collateral market. Available liquidity is limited, so repaying with collateral may be constrained.',
    },
    critical: {
      title: 'Critical utilisation',
      message: 'Utilisation is critically high on this collateral market. Available liquidity is near zero, so repaying with collateral may fail.',
    },
  },
  general: {
    high: {
      title: 'High utilisation',
      message: 'High utilisation on this market. A large proportion of the available liquidity has been borrowed.',
    },
    critical: {
      title: 'Critical utilisation',
      message: 'Utilisation is critically high. Nearly all available liquidity has been borrowed.',
    },
  },
}

const targetUtilisationMessage = {
  title: 'Target utilisation',
  message: 'Cyclical Note markets are designed to run near full utilization. Withdrawal liquidity opens up at the end of each cycle, when borrowers are pushed to repay.',
}

const getUtilisationLevel = (utilisation: number): 'high' | 'critical' | null => {
  if (utilisation >= UTILISATION_CRITICAL) return 'critical'
  if (utilisation >= UTILISATION_HIGH) return 'high'
  return null
}

const getCapLevel = (percentage: number): WarningLevel | null => {
  if (percentage >= CAP_CRITICAL) return 'critical'
  if (percentage >= CAP_HIGH) return 'high'
  return null
}

export const getUtilisationWarning = (
  vault: EVault,
  context: WarningContext = 'general',
): VaultWarning | null => {
  const utilisation = vault.utilization
  const level = getUtilisationLevel(utilisation)
  if (!level) return null

  if (context !== 'repay' && isCyclicalNoteVault(vault)) {
    return { level: 'info', tone: 'success', ...targetUtilisationMessage }
  }

  const { title, message } = utilisationMessages[context][level]
  return { level, title, message }
}

export const getSupplyCapWarning = (vault: EVault): VaultWarning | null => {
  const percentage = vault.caps.supplyCapUtilization
  const level = getCapLevel(percentage)
  if (!level) return null

  const title = percentage >= 100
    ? 'Supply cap reached'
    : percentage >= CAP_CRITICAL
      ? 'Supply cap nearly reached'
      : 'Supply cap approaching limit'
  const message = percentage >= 100
    ? 'The supply cap has been reached. New deposits will fail.'
    : percentage >= CAP_CRITICAL
      ? 'The supply cap is nearly reached. New deposits may be limited or fail.'
      : 'The supply cap is approaching its limit. Available capacity for new deposits is limited.'

  // Cap level only determines the message text, not the visual severity.
  // Reaching a cap means the vault is popular, not that something is wrong.
  return { level: 'info', title, message }
}

export const getCollateralSupplyCapWarning = (vault: EVault | SecuritizeCollateralVault): VaultWarning | null => {
  if (isSecuritizeCollateralVault(vault)) return null
  if (!('caps' in vault) || !vault.caps) return null

  const percentage = vault.caps.supplyCapUtilization
  const level = getCapLevel(percentage)
  if (!level) return null

  const title = percentage >= 100
    ? 'Collateral supply cap reached'
    : percentage >= CAP_CRITICAL
      ? 'Collateral supply cap nearly reached'
      : 'Collateral supply cap approaching limit'
  const message = percentage >= 100
    ? 'The collateral supply cap has been reached. New deposits will fail.'
    : percentage >= CAP_CRITICAL
      ? 'The collateral supply cap is nearly reached. New deposits may be limited or fail.'
      : 'The collateral supply cap is approaching its limit. Available capacity for new deposits is limited.'

  return { level: 'info', title, message }
}

export const getIsSupplyCapReached = (vault: EVault): boolean => {
  const percentage = vault.caps.supplyCapUtilization

  return percentage >= 100
}

export const getBorrowCapWarning = (vault: EVault): VaultWarning | null => {
  const percentage = vault.caps.borrowCapUtilization
  const level = getCapLevel(percentage)
  if (!level) return null

  const title = percentage >= 100
    ? 'Borrow cap reached'
    : percentage >= CAP_CRITICAL
      ? 'Borrow cap nearly reached'
      : 'Borrow cap approaching limit'
  const message = percentage >= 100
    ? 'The borrow cap has been reached. New borrows will fail.'
    : percentage >= CAP_CRITICAL
      ? 'The borrow cap is nearly reached. New borrows may be limited or fail.'
      : 'The borrow cap is approaching its limit. Available capacity for new borrows is limited.'

  // Cap level only determines the message text, not the visual severity.
  // Reaching a cap means the vault is popular, not that something is wrong.
  return { level: 'info', title, message }
}

export const getIsBorrowCapReached = (vault: EVault): boolean => {
  const percentage = vault.caps.borrowCapUtilization

  return percentage >= 100
}

// Copy for every user-facing op. Some ops (OP_MINT, OP_REDEEM, OP_TRANSFER,
// OP_SKIM, OP_REPAY_WITH_SHARES) aren't checked as primary form-level ops
// today but are included here so that getPlanHookDisabledWarning can surface
// them when they appear as secondary steps in multi-step PlannedOp lists.
const hookDisabledCopy = (op: VaultOperation): { title: string, message: string } | null => {
  switch (op) {
    case OP_DEPOSIT:
      return { title: 'Deposits disabled', message: 'The vault risk manager has disabled deposits. New deposits will fail.' }
    case OP_MINT:
      return { title: 'Minting disabled', message: 'The vault risk manager has disabled share minting. Minting shares directly will fail.' }
    case OP_WITHDRAW:
      return { title: 'Withdrawals disabled', message: 'The vault risk manager has disabled withdrawals. Withdrawals will fail.' }
    case OP_REDEEM:
      return { title: 'Redemptions disabled', message: 'The vault risk manager has disabled share redemptions. Redemptions will fail.' }
    case OP_TRANSFER:
      return { title: 'Share transfers disabled', message: 'The vault risk manager has disabled share transfers. Flows that route shares between sub-accounts will fail.' }
    case OP_SKIM:
      return { title: 'Skim disabled', message: 'The vault risk manager has disabled skim. Flows that mint shares for unaccounted assets (repay with shares, same-asset swap) will fail.' }
    case OP_BORROW:
      return { title: 'Borrowing disabled', message: 'The vault risk manager has disabled borrowing. New borrows will fail.' }
    case OP_REPAY:
      return { title: 'Repayments disabled', message: 'The vault risk manager has disabled repayments. Repayments will fail.' }
    case OP_REPAY_WITH_SHARES:
      return { title: 'Repay with shares disabled', message: 'The vault risk manager has disabled repaying debt with vault shares. Same-asset and savings repay flows will fail.' }
    // OP_PULL_DEBT, OP_LIQUIDATE, and OP_FLASHLOAN are intentionally omitted:
    // they are not triggered by any euler-lite user flow.
    default:
      return null
  }
}

export const getHookDisabledWarning = (vault: EVault, op: VaultOperation): VaultWarning | null => {
  if (!isOpDisabled(vault, op)) return null
  // When vaultStatusCheck is hooked the entire vault is effectively
  // paused — show a generic "paused" message instead of op-specific copy.
  if (isOpHooked(vault, OP_VAULT_STATUS_CHECK)) {
    return { level: 'critical', title: 'Vault paused', message: 'All operations on this vault are currently disabled because the vault-status check has been paused by the risk manager.' }
  }
  const copy = hookDisabledCopy(op) ?? { title: 'Operation disabled', message: 'This operation is currently disabled on the vault.' }
  return { level: 'critical', ...copy }
}

export const getPlanHookDisabledWarning = (steps: readonly PlannedOp[]): VaultWarning | null => {
  const blocking = findBlockingDisabledOp(steps)
  if (!blocking) return null
  return getHookDisabledWarning(blocking.vault, blocking.op)
}

export const getStrategyHookWarning = (strategyVault: EVault): VaultWarning | null => {
  const strategyOperations: readonly VaultOperation[] = [OP_DEPOSIT, OP_MINT, OP_WITHDRAW, OP_REDEEM]
  const operations = strategyOperations.filter(op => isOpDisabled(strategyVault, op))
  if (operations.length === 0) return null
  const names = operations.map(op => getOpMeta(op)?.name).filter(Boolean) as string[]
  const verb = names.length === 1 ? 'is' : 'are'
  return {
    level: 'critical',
    title: 'Strategy operations disabled',
    message: `${names.join(', ')} ${verb} disabled on this strategy. The Earn vault may be unable to deposit into or withdraw from it, which can affect allocation and exits.`,
  }
}
