import { getAddress, isAddress, zeroAddress, type Address, type Hash } from 'viem'
import { canonicalDigest, deepFreezeSerializable, toCanonicalValue } from '../domain/canonical'
import type { OperationIntent } from '../domain/intents'

export interface PlanningRequirements {
  schemaVersion: 1
  intentSetHash: Hash
  chainId: number
  owner: Address
  accounts: readonly Address[]
  vaults: readonly Address[]
  assets: readonly Address[]
  contracts: readonly Address[]
  quotes: readonly string[]
}

const VAULT_KEYS = new Set(['vaultAddress', 'borrowVault', 'collateralVault', 'liabilityVault', 'fromVault', 'toVault', 'oldLiabilityVault', 'newLiabilityVault', 'longVault', 'vaultIn'])
const ASSET_KEYS = new Set(['assetAddress', 'liabilityAsset', 'tokenIn', 'tokenOut', 'collateralAsset', 'debtAsset', 'fromAsset', 'toAsset', 'oldLiabilityAsset', 'newLiabilityAsset', 'wrappedTokenAddress', 'loanToken', 'collateralToken'])
const ACCOUNT_KEYS = new Set(['owner', 'receiver', 'borrowAccount', 'repayAccount', 'positionAccount', 'liabilityAccount', 'fromAccount', 'from', 'to', 'subAccount', 'accountIn', 'accountOut', 'account', 'eulerAccount'])

const collectNamedAddresses = (value: unknown, key: string | undefined, target: { accounts: Set<Address>, vaults: Set<Address>, assets: Set<Address>, contracts: Set<Address> }) => {
  if (typeof value === 'string' && isAddress(value)) {
    const address = getAddress(value)
    // SDK swap quotes use zero-address account/vault fields to mean that the
    // corresponding wallet-side leg is absent. They are transport sentinels,
    // not snapshot or policy dependencies.
    if (address === zeroAddress) return
    if (key && VAULT_KEYS.has(key)) target.vaults.add(address)
    else if (key && ASSET_KEYS.has(key)) target.assets.add(address)
    else if (key && ACCOUNT_KEYS.has(key)) target.accounts.add(address)
    else target.contracts.add(address)
    return
  }
  if (Array.isArray(value)) value.forEach(entry => collectNamedAddresses(entry, key, target))
  else if (value && typeof value === 'object') Object.entries(value).forEach(([childKey, entry]) => collectNamedAddresses(entry, childKey, target))
}

export const intentSetDigest = (intents: readonly OperationIntent[]): Hash =>
  canonicalDigest('operation-intent-set-v1', toCanonicalValue(intents))

export const collectPlanningRequirements = (intents: readonly OperationIntent[]): Readonly<PlanningRequirements> => {
  if (!intents.length) throw new Error('Cannot collect requirements for an empty intent set')
  const owner = getAddress(intents[0].account)
  const chainId = intents[0].chainId
  const collected = { accounts: new Set<Address>([owner]), vaults: new Set<Address>(), assets: new Set<Address>(), contracts: new Set<Address>() }
  const quotes = new Set<string>()
  for (const intent of intents) {
    if (intent.chainId !== chainId || getAddress(intent.account) !== owner) throw new Error('Planning requirements mix accounts or chains')
    intent.subAccounts.forEach(account => collected.accounts.add(getAddress(account)))
    collectNamedAddresses(intent.planner.args, undefined, collected)
    intent.constraints.forEach((constraint) => {
      if ('token' in constraint) collected.assets.add(getAddress(constraint.token))
      if ('vault' in constraint) collected.vaults.add(getAddress(constraint.vault))
    })
    if (intent.metadata.quoteId) quotes.add(intent.metadata.quoteId)
  }
  const sorted = (values: Set<Address>) => [...values].sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()))
  return deepFreezeSerializable({
    schemaVersion: 1,
    intentSetHash: intentSetDigest(intents),
    chainId,
    owner,
    accounts: sorted(collected.accounts),
    vaults: sorted(collected.vaults),
    assets: sorted(collected.assets),
    contracts: sorted(collected.contracts),
    quotes: [...quotes].sort(),
  }) as Readonly<PlanningRequirements>
}
