import { getAddress, isAddress, zeroAddress, type Address } from 'viem'
import type { OperationIntent, PlannerName } from '~/features/reviewed-execution/domain/intents'

const address = (value: unknown): Address[] =>
  typeof value === 'string' && isAddress(value) && getAddress(value) !== zeroAddress
    ? [getAddress(value)]
    : []

const quoteTarget = (value: unknown): Address[] => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const verify = (value as Record<string, unknown>).verify
  return verify && typeof verify === 'object' && !Array.isArray(verify)
    ? address((verify as Record<string, unknown>).vault)
    : []
}

const quoteDepositTarget = (value: unknown): Address[] => {
  const quote = record(value)
  const receiver = address(quote?.receiver)
  const accountOut = address(quote?.accountOut)
  return receiver.length && receiver[0] !== accountOut[0] ? receiver : quoteTarget(value)
}

const unique = (values: readonly Address[]) =>
  [...new Map(values.map(value => [value.toLowerCase(), value])).values()]

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const legTargets = (value: unknown, targets: (name: PlannerName, args: Record<string, unknown>) => Address[]): Address[] => {
  const leg = record(value)
  const args = record(leg?.args)
  return typeof leg?.planner === 'string' && args ? targets(leg.planner as PlannerName, args) : []
}

/** Targets that gain a new deposit or collateral position in the reviewed intent. */
const depositTargets = (name: PlannerName, args: Record<string, unknown>): Address[] => {
  switch (name) {
    case 'borrow': {
      const collateral = record(args.collateral)
      return collateral?.source === 'savings' ? [] : address(collateral?.vault)
    }
    case 'deposit': return address(args.vaultAddress)
    case 'deposit-with-swap':
    case 'swap-collateral': return quoteDepositTarget(args.swapQuote)
    case 'migrate-same-asset-collateral': return address(args.toVault)
    case 'swap-and-borrow': return address(args.collateralVault)
    case 'multiply-with-swap': return unique([
      ...(args.collateralShareSource || args.collateralAmount === 0n ? [] : address(args.collateralVault)),
      ...quoteDepositTarget(args.swapQuote),
    ])
    case 'multiply-same-asset': return unique([
      ...(args.collateralShareSource || args.collateralAmount === 0n ? [] : address(args.collateralVault)),
      ...address(args.longVault),
    ])
    case 'refinance-position': return legTargets(args.collateral, depositTargets)
    case 'cross-protocol-migration': return args.direction === 'external-to-euler'
      ? address(record(args.target)?.collateralVault)
      : []
    default: return []
  }
}
export const depositTargetVaults = (intent: OperationIntent): Address[] =>
  depositTargets(intent.planner.name, intent.planner.args)

/** Pending review blocks newly acquired exposure but never a simple exit. */
const exposureTargets = (name: PlannerName, args: Record<string, unknown>): Address[] => {
  if (['withdraw', 'redeem', 'withdraw-and-swap', 'redeem-and-swap', 'repay-from-wallet', 'repay-from-deposit', 'repay-with-swap', 'swap-and-repay', 'cleanup', 'reward-claim', 'reul-unlock'].includes(name)) return []
  if (name === 'borrow') return unique([...address(args.vaultAddress), ...address(record(args.collateral)?.vault)])
  if (name === 'swap-and-borrow') return unique([...depositTargets(name, args), ...address(args.borrowVault)])
  if (name === 'multiply-with-swap' || name === 'multiply-same-asset') return unique([
    ...depositTargets(name, args), ...address(args.collateralVault), ...address(args.liabilityVault),
  ])
  if (name === 'migrate-same-asset-debt') return address(args.newLiabilityVault)
  if (name === 'swap-debt') return quoteTarget(args.swapQuote)
  if (name === 'refinance-position') return unique([...legTargets(args.collateral, exposureTargets), ...legTargets(args.debt, exposureTargets)])
  if (name === 'cross-protocol-migration') return args.direction === 'external-to-euler'
    ? unique([...address(record(args.target)?.collateralVault), ...address(record(args.target)?.borrowVault)])
    : []
  return depositTargets(name, args)
}
export const newExposureVaults = (intent: OperationIntent): Address[] =>
  exposureTargets(intent.planner.name, intent.planner.args)
