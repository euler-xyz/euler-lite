import { getAddress, type Address, type Hash } from 'viem'
import type { SwapQuote } from '@eulerxyz/euler-v2-sdk'
import { canonicalDigest, deepFreezeSerializable, toCanonicalValue, type CanonicalValue } from './canonical'
import type { IntentConstraint, OperationIntent, OperationIntentKind, PlannerName } from './intents'
import { normalizeIntentSwapQuote, type IntentSwapQuote } from './swap-quote'
import { assertOperationIntent } from './schemas'

export interface CreateOperationIntentInput {
  kind: OperationIntentKind
  planner: PlannerName
  args: Readonly<Record<string, unknown>>
  chainId: number
  account: Address
  subAccounts?: readonly Address[]
  source: string
  constraints?: readonly IntentConstraint[]
  intentId?: string
  revision?: number
  createdAt?: number
  quoteId?: string
  quoteCalldataDigest?: Hash
}

const SWAP_QUOTE_KEYS = new Set(['swapQuote', 'collateralSwapQuote', 'debtSwapQuote'])

const normalizeArgValue = (key: string, value: unknown, path: string): CanonicalValue => {
  if (SWAP_QUOTE_KEYS.has(key)) return normalizeIntentSwapQuote(value as SwapQuote) as unknown as CanonicalValue
  if (Array.isArray(value)) return value.map((entry, index) => normalizeArgValue('', entry, `${path}[${index}]`))
  if (value && typeof value === 'object') {
    const result: Record<string, CanonicalValue> = {}
    for (const [childKey, child] of Object.entries(value)) {
      if (child === undefined || childKey === 'account' || childKey === 'subAccountSnapshotApplied') continue
      result[childKey] = normalizeArgValue(childKey, child, `${path}.${childKey}`)
    }
    return result
  }
  return toCanonicalValue(value, path)
}

const normalizeArgs = (args: Readonly<Record<string, unknown>>): Record<string, CanonicalValue> => {
  const normalized: Record<string, CanonicalValue> = {}
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || key === 'account' || key === 'subAccountSnapshotApplied') continue
    normalized[key] = normalizeArgValue(key, value, `intent.planner.args.${key}`)
  }
  return normalized
}

const quoteFrom = (args: Readonly<Record<string, CanonicalValue>>): IntentSwapQuote | undefined => {
  const value = args.swapQuote
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as unknown as IntentSwapQuote
    : undefined
}

/**
 * Infer only limits already enforced by the public planner arguments. Callers
 * must provide explicit constraints for reward selection, rEUL loss, and
 * cross-protocol migration outcomes that cannot be derived locally.
 */
export const inferIntentConstraints = (
  planner: PlannerName,
  args: Readonly<Record<string, CanonicalValue>>,
): readonly IntentConstraint[] => {
  const quote = quoteFrom(args)
  if (quote) {
    return [
      { kind: 'maximum-input', token: quote.tokenIn.address, amount: quote.amountInMax },
      { kind: 'minimum-output', token: quote.tokenOut.address, amount: quote.amountOutMin },
      { kind: 'deadline', timestamp: quote.verify.deadline },
    ]
  }

  if (planner === 'deposit') {
    return [{ kind: 'exact-input', token: getAddress(args.assetAddress as string), amount: args.amount as bigint }]
  }
  if (planner === 'withdraw' || planner === 'redeem') {
    return [{
      kind: 'share-bound',
      vault: getAddress(args.vaultAddress as string),
      maximumShares: (args.shares ?? args.assets) as bigint,
    }]
  }
  if (planner === 'borrow') {
    return [{ kind: 'maximum-input', token: getAddress(args.assetAddress as string), amount: args.amount as bigint }]
  }
  if (planner === 'repay-from-wallet' || planner === 'repay-from-deposit') {
    return [{ kind: 'maximum-input', token: getAddress(args.liabilityAsset as string), amount: args.liabilityAmount as bigint }]
  }
  if (planner === 'migrate-same-asset-collateral') {
    return [{ kind: 'share-bound', vault: getAddress(args.fromVault as string), maximumShares: (args.maxShares ?? args.amount) as bigint }]
  }
  if (planner === 'migrate-same-asset-debt') {
    const amount = args.liabilityAmount
    if (typeof amount !== 'bigint') throw new Error('Debt migration requires an explicit liability amount bound')
    return [{ kind: 'maximum-input', token: getAddress(args.newLiabilityAsset as string), amount }]
  }
  if (planner === 'refinance-position') {
    const constraints: IntentConstraint[] = []
    for (const legName of ['collateral', 'debt'] as const) {
      const leg = args[legName]
      if (!leg || typeof leg !== 'object' || Array.isArray(leg)) continue
      const legRecord = leg as Record<string, CanonicalValue>
      const legPlanner = legRecord.planner
      const legArgs = legRecord.args
      if (typeof legPlanner !== 'string' || !legArgs || typeof legArgs !== 'object' || Array.isArray(legArgs)) {
        throw new Error(`Refinance ${legName} leg is malformed`)
      }
      constraints.push(...inferIntentConstraints(legPlanner as PlannerName, legArgs as Record<string, CanonicalValue>))
    }
    if (!constraints.length) throw new Error('Refinance intent has no bounded leg')
    return constraints
  }
  if (planner === 'multiply-same-asset') {
    return [{ kind: 'maximum-input', token: getAddress(args.collateralAsset as string), amount: args.liabilityAmount as bigint }]
  }
  if (planner === 'transfer') {
    return [{ kind: 'share-bound', vault: getAddress(args.vaultAddress as string), maximumShares: args.amount as bigint }]
  }
  throw new Error(`Planner ${planner} requires explicit execution constraints`)
}

const createIntentId = (body: CanonicalValue): string => {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ? `intent:${uuid}` : `intent:${canonicalDigest('operation-intent-id-v1', body)}`
}

/** Create the immutable DTO captured at the trusted form action boundary. */
export const createOperationIntent = (input: CreateOperationIntentInput): Readonly<OperationIntent> => {
  const args = normalizeArgs(input.args)
  const createdAt = input.createdAt ?? Date.now()
  const idBody = toCanonicalValue({
    kind: input.kind,
    planner: input.planner,
    args,
    chainId: input.chainId,
    account: getAddress(input.account),
    source: input.source,
    createdAt,
  })
  const intent: OperationIntent = {
    schemaVersion: 1,
    intentId: input.intentId ?? createIntentId(idBody),
    revision: input.revision ?? 1,
    kind: input.kind,
    chainId: input.chainId,
    account: getAddress(input.account),
    // `getAddress` accepts an optional chainId as its second argument. Passing
    // it directly to Array.map leaks the item index into that parameter and
    // produces EIP-1191 checksums that normal address validation rejects.
    subAccounts: [...new Set((input.subAccounts ?? [input.account]).map(value => getAddress(value)))],
    planner: { name: input.planner, args },
    constraints: input.constraints ? [...input.constraints] : [...inferIntentConstraints(input.planner, args)],
    metadata: {
      createdAt,
      source: input.source,
      ...(input.quoteId ? { quoteId: input.quoteId } : {}),
      ...(input.quoteCalldataDigest ? { quoteCalldataDigest: input.quoteCalldataDigest } : {}),
    },
  }
  assertOperationIntent(intent)
  return deepFreezeSerializable(intent) as Readonly<OperationIntent>
}
