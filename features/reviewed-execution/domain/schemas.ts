import { getAddress, isAddress, isHash, isHex, type Address } from 'viem'
import { assertCanonicalValue } from './canonical'
import { OPERATION_INTENT_KINDS } from './intents'
import type { IntentConstraint, PlannerName, OperationIntent } from './intents'
import type { ReviewedExecution, ReviewedRequestSet } from './reviewed-execution'
import type { EffectNode, TypedEffect } from './effects'

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be a plain object`)
  if ('__v_isRef' in value) throw new Error(`${path} must not be a Vue ref`)
}

const assertExactKeys = (value: Record<string, unknown>, allowed: readonly string[], path: string) => {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`${path}.${key} is not supported`)
  }
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${path} must be a non-empty string`)
}

function assertSafeInteger(value: unknown, path: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${path} must be a safe integer >= ${minimum}`)
  }
}

function assertAddress(value: unknown, path: string): asserts value is Address {
  if (typeof value !== 'string' || !isAddress(value)) throw new Error(`${path} must be an address`)
  getAddress(value)
}

const assertHash = (value: unknown, path: string) => {
  if (typeof value !== 'string' || !isHash(value)) throw new Error(`${path} must be a hash`)
}

const assertHex = (value: unknown, path: string) => {
  if (typeof value !== 'string' || !isHex(value)) throw new Error(`${path} must be hex data`)
}

const assertBoolean = (value: unknown, path: string) => {
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`)
}

const assertBigInt = (value: unknown, path: string, minimum = 0n) => {
  if (typeof value !== 'bigint' || value < minimum) throw new Error(`${path} must be a bigint >= ${minimum}`)
}

const assertOptional = (value: unknown, path: string, assertion: (candidate: unknown, candidatePath: string) => void) => {
  if (value !== undefined) assertion(value, path)
}

function assertStringArray(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`)
  value.forEach((entry, index) => assertString(entry, `${path}[${index}]`))
}

const assertAddressArray = (value: unknown, path: string) => {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`)
  value.forEach((entry, index) => assertAddress(entry, `${path}[${index}]`))
}

const assertSwapToken = (value: unknown, path: string) => {
  assertRecord(value, path)
  assertExactKeys(value, ['address', 'chainId', 'decimals', 'logoURI', 'name', 'symbol'], path)
  assertAddress(value.address, `${path}.address`)
  assertSafeInteger(value.chainId, `${path}.chainId`, 1)
  assertSafeInteger(value.decimals, `${path}.decimals`)
  if (typeof value.logoURI !== 'string') throw new Error(`${path}.logoURI must be a string`)
  assertString(value.name, `${path}.name`)
  assertString(value.symbol, `${path}.symbol`)
}

const assertIntentSwapQuote = (value: unknown, path: string) => {
  assertRecord(value, path)
  assertExactKeys(value, [
    'schemaVersion', 'amountIn', 'amountInMax', 'amountOut', 'amountOutMin', 'accountIn', 'accountOut',
    'vaultIn', 'receiver', 'tokenIn', 'tokenOut', 'slippageBps', 'swap', 'verify', 'route',
    'providerData', 'transferOutputToReceiver',
  ], path)
  if (value.schemaVersion !== 1) throw new Error(`${path}.schemaVersion is unsupported`)
  for (const key of ['amountIn', 'amountInMax', 'amountOut', 'amountOutMin'] as const) assertBigInt(value[key], `${path}.${key}`)
  for (const key of ['accountIn', 'accountOut', 'vaultIn', 'receiver'] as const) assertAddress(value[key], `${path}.${key}`)
  assertSwapToken(value.tokenIn, `${path}.tokenIn`)
  assertSwapToken(value.tokenOut, `${path}.tokenOut`)
  assertSafeInteger(value.slippageBps, `${path}.slippageBps`)
  if ((value.slippageBps as number) > 10_000) throw new Error(`${path}.slippageBps is out of range`)
  assertRecord(value.swap, `${path}.swap`)
  assertExactKeys(value.swap, ['swapperAddress', 'swapperData', 'multicallItems'], `${path}.swap`)
  assertAddress(value.swap.swapperAddress, `${path}.swap.swapperAddress`)
  assertHex(value.swap.swapperData, `${path}.swap.swapperData`)
  if (!Array.isArray(value.swap.multicallItems)) throw new Error(`${path}.swap.multicallItems must be an array`)
  value.swap.multicallItems.forEach((item, index) => {
    const itemPath = `${path}.swap.multicallItems[${index}]`
    assertRecord(item, itemPath)
    assertExactKeys(item, ['functionName', 'args', 'data'], itemPath)
    assertString(item.functionName, `${itemPath}.functionName`)
    if (!Array.isArray(item.args)) throw new Error(`${itemPath}.args must be an array`)
    item.args.forEach((arg, argIndex) => assertCanonicalValue(arg, `${itemPath}.args[${argIndex}]`))
    assertHex(item.data, `${itemPath}.data`)
  })
  assertRecord(value.verify, `${path}.verify`)
  assertExactKeys(value.verify, ['verifierAddress', 'verifierData', 'type', 'vault', 'account', 'amount', 'deadline'], `${path}.verify`)
  assertAddress(value.verify.verifierAddress, `${path}.verify.verifierAddress`)
  assertHex(value.verify.verifierData, `${path}.verify.verifierData`)
  if (!['skimMin', 'debtMax', 'transferMin'].includes(value.verify.type as string)) throw new Error(`${path}.verify.type is unsupported`)
  assertAddress(value.verify.vault, `${path}.verify.vault`)
  assertAddress(value.verify.account, `${path}.verify.account`)
  assertBigInt(value.verify.amount, `${path}.verify.amount`)
  assertSafeInteger(value.verify.deadline, `${path}.verify.deadline`, 1)
  if (!Array.isArray(value.route)) throw new Error(`${path}.route must be an array`)
  value.route.forEach((hop, index) => {
    const hopPath = `${path}.route[${index}]`
    assertRecord(hop, hopPath)
    assertExactKeys(hop, ['providerName'], hopPath)
    assertString(hop.providerName, `${hopPath}.providerName`)
  })
  if (value.providerData !== undefined) {
    assertRecord(value.providerData, `${path}.providerData`)
    assertExactKeys(value.providerData, ['quoteId', 'sellAmount', 'buyAmount', 'feeAmount'], `${path}.providerData`)
    assertOptional(value.providerData.quoteId, `${path}.providerData.quoteId`, assertString)
    for (const key of ['sellAmount', 'buyAmount', 'feeAmount'] as const) assertOptional(value.providerData[key], `${path}.providerData.${key}`, assertBigInt)
  }
  assertOptional(value.transferOutputToReceiver, `${path}.transferOutputToReceiver`, assertBoolean)
}

const assertWrappedNativeInfo = (value: unknown, path: string) => {
  assertRecord(value, path)
  assertExactKeys(value, ['wrappedTokenAddress', 'nativeAmount'], path)
  assertAddress(value.wrappedTokenAddress, `${path}.wrappedTokenAddress`)
  assertBigInt(value.nativeAmount, `${path}.nativeAmount`)
}

const assertCollateralShareSource = (value: unknown, path: string) => {
  assertRecord(value, path)
  assertExactKeys(value, ['from', 'shares', 'disableCollateralFrom'], path)
  assertAddress(value.from, `${path}.from`)
  assertBigInt(value.shares, `${path}.shares`)
  assertOptional(value.disableCollateralFrom, `${path}.disableCollateralFrom`, assertBoolean)
}

const assertBorrowCollateral = (value: unknown, path: string) => {
  assertRecord(value, path)
  if (value.source === 'savings') {
    assertExactKeys(value, ['vault', 'amount', 'source', 'from', 'disableCollateralFrom'], path)
    assertAddress(value.vault, `${path}.vault`)
    assertBigInt(value.amount, `${path}.amount`)
    assertAddress(value.from, `${path}.from`)
    assertOptional(value.disableCollateralFrom, `${path}.disableCollateralFrom`, assertBoolean)
    return
  }
  assertExactKeys(value, ['vault', 'amount', 'asset', 'source', 'wrappedNativeInfo'], path)
  assertAddress(value.vault, `${path}.vault`)
  assertBigInt(value.amount, `${path}.amount`)
  assertAddress(value.asset, `${path}.asset`)
  if (value.source !== undefined && value.source !== 'wallet') throw new Error(`${path}.source is unsupported`)
  assertOptional(value.wrappedNativeInfo, `${path}.wrappedNativeInfo`, assertWrappedNativeInfo)
}

const assertEulerMigrationTarget = (value: unknown, path: string) => {
  assertRecord(value, path)
  assertExactKeys(value, ['eulerAccount', 'borrowVault', 'collateralVault', 'swapper', 'borrowAmount', 'interestBufferBps', 'minCollateralAssets', 'enableController', 'enableCollateral', 'collateralSwapVerification'], path)
  assertAddress(value.eulerAccount, `${path}.eulerAccount`)
  assertOptional(value.borrowVault, `${path}.borrowVault`, assertAddress)
  assertAddress(value.collateralVault, `${path}.collateralVault`)
  assertOptional(value.swapper, `${path}.swapper`, assertAddress)
  for (const key of ['borrowAmount', 'interestBufferBps', 'minCollateralAssets'] as const) assertOptional(value[key], `${path}.${key}`, assertBigInt)
  for (const key of ['enableController', 'enableCollateral'] as const) assertOptional(value[key], `${path}.${key}`, assertBoolean)
  if (value.collateralSwapVerification !== undefined && value.collateralSwapVerification !== 'skim' && value.collateralSwapVerification !== 'deposit') throw new Error(`${path}.collateralSwapVerification is unsupported`)
}

const assertEulerMigrationSource = (value: unknown, path: string) => {
  assertRecord(value, path)
  assertExactKeys(value, ['eulerAccount', 'borrowVault', 'collateralVault', 'swapper', 'debtAmount', 'collateralAmount', 'collateralShares'], path)
  assertAddress(value.eulerAccount, `${path}.eulerAccount`)
  assertAddress(value.borrowVault, `${path}.borrowVault`)
  assertAddress(value.collateralVault, `${path}.collateralVault`)
  assertOptional(value.swapper, `${path}.swapper`, assertAddress)
  for (const key of ['debtAmount', 'collateralAmount', 'collateralShares'] as const) assertOptional(value[key], `${path}.${key}`, assertBigInt)
}

const assertExternalMigrationTarget = (value: unknown, path: string) => {
  assertRecord(value, path)
  assertExactKeys(value, ['positionRef', 'borrowAmount', 'collateralAmount', 'repayAmount', 'interestBufferBps'], path)
  assertOptional(value.positionRef, `${path}.positionRef`, assertMigrationPositionRef)
  for (const key of ['borrowAmount', 'collateralAmount', 'repayAmount', 'interestBufferBps'] as const) assertOptional(value[key], `${path}.${key}`, assertBigInt)
}

function assertMigrationPositionRef(value: unknown, path: string) {
  if (typeof value === 'string') {
    assertString(value, path)
    return
  }
  assertRecord(value, path)
  const keys = Object.keys(value)
  if (keys.includes('collateralAsset')) {
    assertExactKeys(value, ['collateralAsset', 'debtAsset', 'pool'], path)
    assertAddress(value.collateralAsset, `${path}.collateralAsset`)
    assertOptional(value.debtAsset, `${path}.debtAsset`, assertAddress)
    assertOptional(value.pool, `${path}.pool`, assertAddress)
    return
  }
  if (keys.includes('loanToken')) {
    assertExactKeys(value, ['loanToken', 'collateralToken', 'oracle', 'irm', 'lltv'], path)
    for (const key of ['loanToken', 'collateralToken', 'oracle', 'irm'] as const) assertAddress(value[key], `${path}.${key}`)
    assertBigInt(value.lltv, `${path}.lltv`)
    return
  }
  if (keys.includes('vault')) {
    assertExactKeys(value, ['vault', 'version'], path)
    assertAddress(value.vault, `${path}.vault`)
    if (value.version !== 'v1' && value.version !== 'v2') throw new Error(`${path}.version is unsupported`)
    return
  }
  throw new Error(`${path} is not a supported migration position reference`)
}

const PLANNER_NAMES: readonly PlannerName[] = [
  'deposit', 'deposit-with-swap', 'withdraw', 'redeem', 'withdraw-and-swap', 'redeem-and-swap',
  'borrow', 'swap-and-borrow', 'repay-from-wallet', 'repay-from-deposit', 'repay-with-swap',
  'swap-and-repay', 'swap-from-wallet', 'swap-collateral', 'swap-debt',
  'refinance-position',
  'migrate-same-asset-collateral', 'migrate-same-asset-debt', 'multiply-with-swap',
  'multiply-same-asset', 'transfer', 'cleanup', 'cross-protocol-migration', 'reward-claim', 'reul-unlock',
]

const PLANNER_ARGUMENT_KEYS: Readonly<Record<PlannerName, readonly string[]>> = {
  'deposit': ['vaultAddress', 'assetAddress', 'amount', 'receiver', 'enableCollateral', 'wrappedNativeInfo'],
  'deposit-with-swap': ['swapQuote', 'amount', 'tokenIn', 'enableCollateral', 'wrappedNativeInfo'],
  'withdraw': ['vaultAddress', 'assets', 'owner', 'receiver', 'disableCollateral'],
  'redeem': ['vaultAddress', 'owner', 'receiver', 'disableCollateral', 'shares', 'assets'],
  'withdraw-and-swap': ['swapQuote', 'vaultAddress', 'assets', 'owner'],
  'redeem-and-swap': ['swapQuote', 'vaultAddress', 'shares', 'owner'],
  'borrow': ['vaultAddress', 'assetAddress', 'amount', 'borrowAccount', 'receiver', 'skipCleanup', 'subAccountSnapshotApplied', 'collateral'],
  'swap-and-borrow': ['swapQuote', 'amount', 'tokenIn', 'borrowVault', 'borrowAmount', 'borrowAccount', 'collateralVault', 'receiver', 'wrappedNativeInfo', 'skipCleanup', 'subAccountSnapshotApplied'],
  'repay-from-wallet': ['liabilityVault', 'liabilityAsset', 'liabilityAmount', 'receiver', 'cleanupOnMax'],
  'repay-from-deposit': ['liabilityVault', 'liabilityAsset', 'liabilityAmount', 'receiver', 'fromVault', 'fromAccount', 'cleanupOnMax'],
  'repay-with-swap': ['swapQuote', 'cleanupOnMax', 'swapperMode'],
  'swap-and-repay': ['swapQuote', 'amount', 'tokenIn', 'liabilityVault', 'repayAccount', 'isMax', 'cleanupOnMax', 'wrappedNativeInfo'],
  'swap-from-wallet': ['swapQuote', 'amount', 'tokenIn', 'wrappedNativeInfo'],
  'swap-collateral': ['swapQuote', 'swapperMode'],
  'swap-debt': ['swapQuote', 'swapperMode'],
  'refinance-position': ['collateral', 'debt'],
  'migrate-same-asset-collateral': ['fromVault', 'toVault', 'amount', 'positionAccount', 'fromAsset', 'toAsset', 'isMax', 'maxShares', 'enableCollateralTo', 'disableCollateralFrom'],
  'migrate-same-asset-debt': ['oldLiabilityVault', 'newLiabilityVault', 'liabilityAccount', 'liabilityAmount', 'oldLiabilityAsset', 'newLiabilityAsset', 'sweepExcess', 'transferRemainingSharesToOwner'],
  'multiply-with-swap': ['collateralVault', 'collateralAmount', 'collateralAsset', 'collateralShareSource', 'collateralWrappedNativeInfo', 'swapQuote', 'swapperMode', 'skipCleanup', 'subAccountSnapshotApplied'],
  'multiply-same-asset': ['collateralVault', 'collateralAmount', 'collateralAsset', 'collateralShareSource', 'collateralWrappedNativeInfo', 'longVault', 'liabilityVault', 'liabilityAmount', 'receiver', 'skipCleanup', 'subAccountSnapshotApplied'],
  'transfer': ['vaultAddress', 'from', 'to', 'amount', 'enableCollateralTo', 'disableCollateralFrom'],
  'cleanup': ['subAccount'],
  'cross-protocol-migration': ['direction', 'connectorId', 'owner', 'positionRef', 'target', 'source', 'externalTarget', 'collateralSwapQuote', 'debtSwapQuote', 'deadline', 'validateEulerVaults', 'removeAuthorizationAfterMigration', 'cleanupEulerPosition', 'operationName', 'authorizationKind', 'authorizationEvidenceDigest'],
  'reward-claim': ['claimIds', 'provider', 'rewardsDigest'],
  'reul-unlock': ['lockTimestamps', 'lockAmounts', 'remainderLossMaximum'],
}

const REQUIRED_PLANNER_ARGUMENT_KEYS: Readonly<Record<PlannerName, readonly string[]>> = {
  'deposit': ['vaultAddress', 'assetAddress', 'amount'],
  'deposit-with-swap': ['swapQuote', 'amount', 'tokenIn'],
  'withdraw': ['vaultAddress', 'assets', 'owner'],
  'redeem': ['vaultAddress', 'owner'],
  'withdraw-and-swap': ['swapQuote', 'vaultAddress', 'assets', 'owner'],
  'redeem-and-swap': ['swapQuote', 'vaultAddress', 'shares', 'owner'],
  'borrow': ['vaultAddress', 'assetAddress', 'amount', 'borrowAccount'],
  'swap-and-borrow': ['swapQuote', 'amount', 'tokenIn', 'borrowVault', 'borrowAmount'],
  'repay-from-wallet': ['liabilityVault', 'liabilityAsset', 'liabilityAmount', 'receiver'],
  'repay-from-deposit': ['liabilityVault', 'liabilityAsset', 'liabilityAmount', 'receiver', 'fromVault', 'fromAccount'],
  'repay-with-swap': ['swapQuote'],
  'swap-and-repay': ['swapQuote', 'amount', 'tokenIn'],
  'swap-from-wallet': ['swapQuote', 'amount', 'tokenIn'],
  'swap-collateral': ['swapQuote'],
  'swap-debt': ['swapQuote'],
  'refinance-position': [],
  'migrate-same-asset-collateral': ['fromVault', 'toVault', 'amount', 'positionAccount', 'toAsset'],
  'migrate-same-asset-debt': ['oldLiabilityVault', 'newLiabilityVault', 'liabilityAccount', 'newLiabilityAsset'],
  'multiply-with-swap': ['collateralVault', 'collateralAmount', 'collateralAsset', 'swapQuote'],
  'multiply-same-asset': ['collateralVault', 'collateralAmount', 'collateralAsset', 'longVault', 'liabilityVault', 'liabilityAmount', 'receiver'],
  'transfer': ['vaultAddress', 'from', 'to', 'amount'],
  'cleanup': ['subAccount'],
  'cross-protocol-migration': ['direction', 'connectorId', 'owner', 'positionRef', 'deadline', 'authorizationEvidenceDigest'],
  'reward-claim': ['claimIds', 'provider', 'rewardsDigest'],
  'reul-unlock': ['lockTimestamps', 'lockAmounts', 'remainderLossMaximum'],
}

const ADDRESS_ARGUMENT_KEYS = new Set([
  'vaultAddress', 'assetAddress', 'receiver', 'owner', 'borrowAccount', 'tokenIn', 'borrowVault',
  'collateralVault', 'liabilityVault', 'repayAccount', 'fromVault', 'fromAccount', 'positionAccount',
  'fromAsset', 'toAsset', 'oldLiabilityVault', 'newLiabilityVault', 'liabilityAccount',
  'oldLiabilityAsset', 'newLiabilityAsset', 'liabilityAsset', 'collateralAsset', 'longVault', 'from', 'to', 'subAccount',
])

const BIGINT_ARGUMENT_KEYS = new Set([
  'amount', 'assets', 'shares', 'borrowAmount', 'liabilityAmount', 'maxShares', 'collateralAmount',
  'remainderLossMaximum', 'deadline',
])

const BOOLEAN_ARGUMENT_KEYS = new Set([
  'enableCollateral', 'disableCollateral', 'skipCleanup', 'subAccountSnapshotApplied', 'cleanupOnMax',
  'isMax', 'enableCollateralTo', 'disableCollateralFrom', 'sweepExcess', 'transferRemainingSharesToOwner',
  'validateEulerVaults', 'removeAuthorizationAfterMigration', 'cleanupEulerPosition',
])

const assertPlannerArgs = (planner: Record<string, unknown>) => {
  const name = planner.name as PlannerName
  if (!PLANNER_NAMES.includes(name)) throw new Error('intent.planner.name is unsupported')
  assertRecord(planner.args, 'intent.planner.args')
  assertExactKeys(planner.args, PLANNER_ARGUMENT_KEYS[name], 'intent.planner.args')
  for (const required of REQUIRED_PLANNER_ARGUMENT_KEYS[name]) {
    if (planner.args[required] === undefined) throw new Error(`intent.planner.args.${required} is required`)
  }
  for (const [key, candidate] of Object.entries(planner.args)) {
    if (key === 'swapQuote' || key === 'collateralSwapQuote' || key === 'debtSwapQuote') assertIntentSwapQuote(candidate, `intent.planner.args.${key}`)
    else if (key === 'wrappedNativeInfo' || key === 'collateralWrappedNativeInfo') assertWrappedNativeInfo(candidate, `intent.planner.args.${key}`)
    else if (key === 'collateralShareSource') assertCollateralShareSource(candidate, `intent.planner.args.${key}`)
    else if (name === 'refinance-position' && (key === 'collateral' || key === 'debt')) {
      assertRecord(candidate, `intent.planner.args.${key}`)
      assertExactKeys(candidate, ['planner', 'args'], `intent.planner.args.${key}`)
      const expected = key === 'collateral'
        ? ['swap-collateral', 'migrate-same-asset-collateral']
        : ['swap-debt', 'migrate-same-asset-debt']
      if (!expected.includes(candidate.planner as string)) throw new Error(`intent.planner.args.${key}.planner is unsupported`)
      assertPlannerArgs({ name: candidate.planner, args: candidate.args })
    }
    else if (key === 'collateral') assertBorrowCollateral(candidate, `intent.planner.args.${key}`)
    else if (key === 'target') assertEulerMigrationTarget(candidate, `intent.planner.args.${key}`)
    else if (key === 'source') assertEulerMigrationSource(candidate, `intent.planner.args.${key}`)
    else if (key === 'externalTarget') assertExternalMigrationTarget(candidate, `intent.planner.args.${key}`)
    else if (key === 'positionRef') assertMigrationPositionRef(candidate, `intent.planner.args.${key}`)
    else if (ADDRESS_ARGUMENT_KEYS.has(key)) assertAddress(candidate, `intent.planner.args.${key}`)
    else if (BIGINT_ARGUMENT_KEYS.has(key)) assertBigInt(candidate, `intent.planner.args.${key}`)
    else if (BOOLEAN_ARGUMENT_KEYS.has(key)) assertBoolean(candidate, `intent.planner.args.${key}`)
    else assertCanonicalValue(candidate, `intent.planner.args.${key}`)
  }
  if (name === 'redeem' && (planner.args.shares === undefined) === (planner.args.assets === undefined)) {
    throw new Error('redeem intent must specify exactly one of shares or assets')
  }
  if (name === 'reward-claim') assertStringArray(planner.args.claimIds, 'intent.planner.args.claimIds')
  if (name === 'reward-claim') {
    assertString(planner.args.provider, 'intent.planner.args.provider')
    assertHash(planner.args.rewardsDigest, 'intent.planner.args.rewardsDigest')
  }
  if (name === 'cross-protocol-migration') {
    if (planner.args.direction !== 'external-to-euler' && planner.args.direction !== 'euler-to-external') throw new Error('intent.planner.args.direction is unsupported')
    assertString(planner.args.connectorId, 'intent.planner.args.connectorId')
    if (planner.args.authorizationKind !== undefined && planner.args.authorizationKind !== 'typedData' && planner.args.authorizationKind !== 'transaction') throw new Error('intent.planner.args.authorizationKind is unsupported')
    assertHash(planner.args.authorizationEvidenceDigest, 'intent.planner.args.authorizationEvidenceDigest')
  }
  if (name === 'refinance-position' && planner.args.collateral === undefined && planner.args.debt === undefined) {
    throw new Error('refinance intent must contain a collateral or debt leg')
  }
  if (name === 'reul-unlock') {
    if (!Array.isArray(planner.args.lockTimestamps) || !Array.isArray(planner.args.lockAmounts)) throw new Error('rEUL lock fields must be arrays')
    planner.args.lockTimestamps.forEach((entry, index) => assertSafeInteger(entry, `intent.planner.args.lockTimestamps[${index}]`))
    planner.args.lockAmounts.forEach((entry, index) => assertBigInt(entry, `intent.planner.args.lockAmounts[${index}]`))
    if (planner.args.lockTimestamps.length !== planner.args.lockAmounts.length || planner.args.lockTimestamps.length === 0) throw new Error('rEUL lock identities and amounts must align')
  }
}

const assertIntentConstraint = (value: unknown, path: string): asserts value is IntentConstraint => {
  assertRecord(value, path)
  assertString(value.kind, `${path}.kind`)
  if (value.kind === 'exact-input' || value.kind === 'maximum-input' || value.kind === 'minimum-output') {
    assertExactKeys(value, ['kind', 'token', 'amount'], path)
    assertAddress(value.token, `${path}.token`)
    assertBigInt(value.amount, `${path}.amount`)
  }
  else if (value.kind === 'remainder-loss') {
    assertExactKeys(value, ['kind', 'token', 'maximumLoss'], path)
    assertAddress(value.token, `${path}.token`)
    assertBigInt(value.maximumLoss, `${path}.maximumLoss`)
  }
  else if (value.kind === 'share-bound') {
    assertExactKeys(value, ['kind', 'vault', 'maximumShares'], path)
    assertAddress(value.vault, `${path}.vault`)
    assertBigInt(value.maximumShares, `${path}.maximumShares`)
  }
  else if (value.kind === 'deadline') {
    assertExactKeys(value, ['kind', 'timestamp'], path)
    assertSafeInteger(value.timestamp, `${path}.timestamp`, 1)
  }
  else if (value.kind === 'selected-rewards') {
    assertExactKeys(value, ['kind', 'claimIds'], path)
    assertStringArray(value.claimIds, `${path}.claimIds`)
    if (!value.claimIds.length) throw new Error(`${path}.claimIds must be non-empty`)
  }
  else throw new Error(`${path}.kind is unsupported`)
}

const assertPolicyState = (value: unknown, path: string) => {
  assertRecord(value, path)
  assertString(value.state, `${path}.state`)
  if (value.state === 'allowed') {
    assertExactKeys(value, ['state', 'version', 'observedAt', 'expiresAt'], path)
    assertString(value.version, `${path}.version`)
    assertSafeInteger(value.observedAt, `${path}.observedAt`)
    assertOptional(value.expiresAt, `${path}.expiresAt`, (candidate, candidatePath) => assertSafeInteger(candidate, candidatePath))
  }
  else if (value.state === 'blocked') {
    assertExactKeys(value, ['state', 'version', 'reason', 'observedAt'], path)
    assertString(value.version, `${path}.version`)
    assertString(value.reason, `${path}.reason`)
    assertSafeInteger(value.observedAt, `${path}.observedAt`)
  }
  else if (value.state === 'pending') {
    assertExactKeys(value, ['state', 'version'], path)
    assertString(value.version, `${path}.version`)
  }
  else if (value.state === 'unavailable') {
    assertExactKeys(value, ['state', 'reason'], path)
    assertString(value.reason, `${path}.reason`)
  }
  else throw new Error(`${path}.state is unsupported`)
}

const assertReviewedPolicy = (value: unknown, path: string) => {
  assertRecord(value, path)
  assertExactKeys(value, ['schemaVersion', 'subjects', 'results', 'digest'], path)
  if (value.schemaVersion !== 1) throw new Error(`${path}.schemaVersion is unsupported`)
  if (!Array.isArray(value.subjects) || !Array.isArray(value.results)) throw new Error(`${path} arrays are invalid`)
  value.subjects.forEach((subject, index) => {
    const subjectPath = `${path}.subjects[${index}]`
    assertRecord(subject, subjectPath)
    assertExactKeys(subject, ['kind', 'value'], subjectPath)
    if (!['account', 'vault-or-contract', 'asset', 'spender', 'pyth-feed', 'authority'].includes(subject.kind as string)) throw new Error(`${subjectPath}.kind is unsupported`)
    assertString(subject.value, `${subjectPath}.value`)
    if (subject.kind === 'pyth-feed') assertHex(subject.value, `${subjectPath}.value`)
    else assertAddress(subject.value, `${subjectPath}.value`)
  })
  value.results.forEach((item, index) => {
    const resultPath = `${path}.results[${index}]`
    assertRecord(item, resultPath)
    assertExactKeys(item, ['subject', 'concern', 'result'], resultPath)
    assertString(item.subject, `${resultPath}.subject`)
    assertString(item.concern, `${resultPath}.concern`)
    assertPolicyState(item.result, `${resultPath}.result`)
  })
  assertHash(value.digest, `${path}.digest`)
}

const assertSimulation = (value: unknown, path: string) => {
  assertRecord(value, path)
  assertExactKeys(value, ['schemaVersion', 'requestDigest', 'observedAt', 'blockNumber', 'canExecute', 'effects', 'simulatedAccounts', 'simulatedVaults'], path)
  if (value.schemaVersion !== 1) throw new Error(`${path}.schemaVersion is unsupported`)
  assertHash(value.requestDigest, `${path}.requestDigest`)
  assertSafeInteger(value.observedAt, `${path}.observedAt`)
  assertOptional(value.blockNumber, `${path}.blockNumber`, (candidate, candidatePath) => assertBigInt(candidate, candidatePath))
  assertBoolean(value.canExecute, `${path}.canExecute`)
  if (!Array.isArray(value.effects) || !Array.isArray(value.simulatedAccounts) || !Array.isArray(value.simulatedVaults)) throw new Error(`${path} arrays are invalid`)
  value.effects.forEach((effect, index) => {
    const effectPath = `${path}.effects[${index}]`
    assertRecord(effect, effectPath)
    assertExactKeys(effect, ['effectId', 'coverage', 'canExecute', 'assumption', 'error'], effectPath)
    assertHash(effect.effectId, `${effectPath}.effectId`)
    if (!['evc-state', 'modeled-authorization', 'independent-call', 'not-state-simulated'].includes(effect.coverage as string)) throw new Error(`${effectPath}.coverage is unsupported`)
    assertBoolean(effect.canExecute, `${effectPath}.canExecute`)
    assertOptional(effect.assumption, `${effectPath}.assumption`, assertString)
    assertOptional(effect.error, `${effectPath}.error`, assertString)
  })
  value.simulatedAccounts.forEach((entry, index) => assertCanonicalValue(entry, `${path}.simulatedAccounts[${index}]`))
  value.simulatedVaults.forEach((entry, index) => assertCanonicalValue(entry, `${path}.simulatedVaults[${index}]`))
}

const assertEffectMap = (value: unknown, path: string) => {
  assertRecord(value, path)
  assertExactKeys(value, ['schemaVersion', 'requestDigest', 'entries', 'previewPayloadHashes'], path)
  if (value.schemaVersion !== 1) throw new Error(`${path}.schemaVersion is unsupported`)
  assertHash(value.requestDigest, `${path}.requestDigest`)
  if (!Array.isArray(value.entries) || !Array.isArray(value.previewPayloadHashes)) throw new Error(`${path} arrays are invalid`)
  value.entries.forEach((entry, index) => {
    const entryPath = `${path}.entries[${index}]`
    assertRecord(entry, entryPath)
    assertExactKeys(entry, ['effectId', 'intentId', 'intentRevision', 'requestId', 'coverage'], entryPath)
    assertHash(entry.effectId, `${entryPath}.effectId`)
    assertString(entry.intentId, `${entryPath}.intentId`)
    assertSafeInteger(entry.intentRevision, `${entryPath}.intentRevision`)
    assertHash(entry.requestId, `${entryPath}.requestId`)
    if (!['evc-state', 'modeled-authorization', 'independent-call', 'not-state-simulated'].includes(entry.coverage as string)) throw new Error(`${entryPath}.coverage is unsupported`)
  })
  value.previewPayloadHashes.forEach((hash, index) => assertHash(hash, `${path}.previewPayloadHashes[${index}]`))
}

const assertReviewBinding = (value: unknown, path: string) => {
  assertRecord(value, path)
  assertExactKeys(value, ['schemaVersion', 'reviewId', 'intentRevisions', 'presentationKind', 'presentationDigest'], path)
  if (value.schemaVersion !== 1) throw new Error(`${path}.schemaVersion is unsupported`)
  assertHash(value.reviewId, `${path}.reviewId`)
  assertString(value.presentationKind, `${path}.presentationKind`)
  assertHash(value.presentationDigest, `${path}.presentationDigest`)
  if (!Array.isArray(value.intentRevisions) || !value.intentRevisions.length) throw new Error(`${path}.intentRevisions must be non-empty`)
  value.intentRevisions.forEach((entry, index) => {
    const entryPath = `${path}.intentRevisions[${index}]`
    assertRecord(entry, entryPath)
    assertExactKeys(entry, ['intentId', 'revision'], entryPath)
    assertString(entry.intentId, `${entryPath}.intentId`)
    assertSafeInteger(entry.revision, `${entryPath}.revision`)
  })
}

const assertValidity = (value: unknown, path: string) => {
  assertRecord(value, path)
  assertExactKeys(value, ['createdAt', 'expiresAt', 'cartGeneration', 'planningSnapshotDigest', 'policyVersionDigest'], path)
  assertSafeInteger(value.createdAt, `${path}.createdAt`)
  assertOptional(value.expiresAt, `${path}.expiresAt`, (candidate, candidatePath) => assertSafeInteger(candidate, candidatePath))
  assertSafeInteger(value.cartGeneration, `${path}.cartGeneration`)
  assertHash(value.planningSnapshotDigest, `${path}.planningSnapshotDigest`)
  assertHash(value.policyVersionDigest, `${path}.policyVersionDigest`)
}

const assertPluginSnapshot = (value: unknown, path: string) => {
  assertRecord(value, path)
  assertExactKeys(value, ['rawPlanDigest', 'previewPlanDigest', 'pluginConfigurationDigest', 'rawPlan', 'previewPlan'], path)
  assertHash(value.rawPlanDigest, `${path}.rawPlanDigest`)
  assertHash(value.previewPlanDigest, `${path}.previewPlanDigest`)
  assertHash(value.pluginConfigurationDigest, `${path}.pluginConfigurationDigest`)
  assertCanonicalValue(value.rawPlan, `${path}.rawPlan`)
  assertCanonicalValue(value.previewPlan, `${path}.previewPlan`)
}

export function assertOperationIntent(value: unknown): asserts value is OperationIntent {
  assertRecord(value, 'intent')
  assertExactKeys(value, ['schemaVersion', 'intentId', 'revision', 'kind', 'chainId', 'account', 'subAccounts', 'planner', 'constraints', 'metadata'], 'intent')
  if (value.schemaVersion !== 1) throw new Error('intent.schemaVersion is unsupported')
  assertString(value.intentId, 'intent.intentId')
  assertSafeInteger(value.revision, 'intent.revision')
  if (!OPERATION_INTENT_KINDS.includes(value.kind as typeof OPERATION_INTENT_KINDS[number])) {
    throw new Error('intent.kind is unsupported')
  }
  assertSafeInteger(value.chainId, 'intent.chainId', 1)
  assertAddress(value.account, 'intent.account')
  if (!Array.isArray(value.subAccounts)) throw new Error('intent.subAccounts must be an array')
  value.subAccounts.forEach((account, index) => assertAddress(account, `intent.subAccounts[${index}]`))
  assertRecord(value.planner, 'intent.planner')
  assertExactKeys(value.planner, ['name', 'args'], 'intent.planner')
  assertString(value.planner.name, 'intent.planner.name')
  assertPlannerArgs(value.planner)
  if (!Array.isArray(value.constraints)) throw new Error('intent.constraints must be an array')
  value.constraints.forEach((constraint, index) => assertIntentConstraint(constraint, `intent.constraints[${index}]`))
  assertRecord(value.metadata, 'intent.metadata')
  assertExactKeys(value.metadata, ['createdAt', 'source', 'quoteId', 'quoteCalldataDigest'], 'intent.metadata')
  assertSafeInteger(value.metadata.createdAt, 'intent.metadata.createdAt')
  assertString(value.metadata.source, 'intent.metadata.source')
  if (value.metadata.quoteId !== undefined) assertString(value.metadata.quoteId, 'intent.metadata.quoteId')
  if (value.metadata.quoteCalldataDigest !== undefined) assertHex(value.metadata.quoteCalldataDigest, 'intent.metadata.quoteCalldataDigest')
}

function assertEffect(value: unknown, path: string): asserts value is TypedEffect {
  assertRecord(value, path)
  assertString(value.kind, `${path}.kind`)
  if (value.kind === 'approval') {
    assertExactKeys(value, ['kind', 'mode', 'owner', 'token', 'spender', 'amount'], path)
    if (value.mode !== 'transaction' && value.mode !== 'permit2') throw new Error(`${path}.mode is unsupported`)
    assertAddress(value.owner, `${path}.owner`)
    assertAddress(value.token, `${path}.token`)
    assertAddress(value.spender, `${path}.spender`)
    assertBigInt(value.amount, `${path}.amount`)
  }
  else if (value.kind === 'evc-call' || value.kind === 'tos-call' || value.kind === 'keyring-call') {
    assertExactKeys(value, ['kind', 'target', 'onBehalfOfAccount', 'value', 'data', 'selector'], path)
    assertAddress(value.target, `${path}.target`)
    assertAddress(value.onBehalfOfAccount, `${path}.onBehalfOfAccount`)
    assertBigInt(value.value, `${path}.value`)
    assertHex(value.data, `${path}.data`)
    assertHex(value.selector, `${path}.selector`)
  }
  else if (value.kind === 'direct-call') {
    assertExactKeys(value, ['kind', 'chainId', 'target', 'value', 'data', 'selector'], path)
    assertSafeInteger(value.chainId, `${path}.chainId`, 1)
    assertAddress(value.target, `${path}.target`)
    assertBigInt(value.value, `${path}.value`)
    assertHex(value.data, `${path}.data`)
    assertHex(value.selector, `${path}.selector`)
  }
  else if (value.kind === 'pyth-update') {
    assertExactKeys(value, ['kind', 'chainId', 'target', 'onBehalfOfAccount', 'value', 'data', 'selector', 'requiredFeedIds'], path)
    assertSafeInteger(value.chainId, `${path}.chainId`, 1)
    assertAddress(value.target, `${path}.target`)
    assertAddress(value.onBehalfOfAccount, `${path}.onBehalfOfAccount`)
    assertBigInt(value.value, `${path}.value`)
    assertHex(value.data, `${path}.data`)
    assertHex(value.selector, `${path}.selector`)
    if (!Array.isArray(value.requiredFeedIds) || !value.requiredFeedIds.length) throw new Error(`${path}.requiredFeedIds must be non-empty`)
    value.requiredFeedIds.forEach((feed, index) => assertHex(feed, `${path}.requiredFeedIds[${index}]`))
  }
  else if (value.kind === 'migration-authorization') {
    assertExactKeys(value, ['kind', 'action', 'chainId', 'target', 'value', 'data'], path)
    if (value.action !== 'grant' && value.action !== 'revoke') throw new Error(`${path}.action is unsupported`)
    assertSafeInteger(value.chainId, `${path}.chainId`, 1)
    assertAddress(value.target, `${path}.target`)
    assertBigInt(value.value, `${path}.value`)
    assertHex(value.data, `${path}.data`)
  }
  else throw new Error(`${path}.kind is unsupported`)
}

const assertEffectNode = (value: unknown, path: string): asserts value is EffectNode => {
  assertRecord(value, path)
  assertExactKeys(value, ['effectId', 'intentId', 'intentRevision', 'dependsOn', 'phase', 'effect', 'provenance', 'simulation', 'policySubjects'], path)
  assertHash(value.effectId, `${path}.effectId`)
  assertString(value.intentId, `${path}.intentId`)
  assertSafeInteger(value.intentRevision, `${path}.intentRevision`)
  if (!Array.isArray(value.dependsOn)) throw new Error(`${path}.dependsOn must be an array`)
  value.dependsOn.forEach((dependency, index) => assertHash(dependency, `${path}.dependsOn[${index}]`))
  if (!['prerequisite', 'core', 'cleanup'].includes(value.phase as string)) throw new Error(`${path}.phase is unsupported`)
  assertEffect(value.effect, `${path}.effect`)
  assertRecord(value.provenance, `${path}.provenance`)
  const provenanceKeys = value.provenance.source === 'intent' ? ['source', 'planner'] : value.provenance.source === 'migration-authorization' ? ['source', 'mode'] : ['source', 'plugin']
  assertExactKeys(value.provenance, provenanceKeys, `${path}.provenance`)
  if (!['intent', 'sdk-plugin', 'lite-plugin', 'migration-authorization'].includes(value.provenance.source as string)) throw new Error(`${path}.provenance.source is unsupported`)
  assertRecord(value.simulation, `${path}.simulation`)
  const simulationKeys = value.simulation.kind === 'modeled-authorization' ? ['kind', 'assumption'] : value.simulation.kind === 'not-state-simulated' ? ['kind', 'allowlistId'] : ['kind']
  assertExactKeys(value.simulation, simulationKeys, `${path}.simulation`)
  if (!['evc-state', 'modeled-authorization', 'independent-call', 'not-state-simulated'].includes(value.simulation.kind as string)) throw new Error(`${path}.simulation.kind is unsupported`)
  if ('assumption' in value.simulation) assertString(value.simulation.assumption, `${path}.simulation.assumption`)
  if ('allowlistId' in value.simulation) assertString(value.simulation.allowlistId, `${path}.simulation.allowlistId`)
  if (!Array.isArray(value.policySubjects) || !value.policySubjects.length) throw new Error(`${path}.policySubjects must be non-empty`)
  value.policySubjects.forEach((subject, index) => {
    const subjectPath = `${path}.policySubjects[${index}]`
    assertRecord(subject, subjectPath)
    assertExactKeys(subject, ['kind', 'value'], subjectPath)
    if (!['account', 'vault-or-contract', 'asset', 'spender', 'pyth-feed', 'authority'].includes(subject.kind as string)) throw new Error(`${subjectPath}.kind is unsupported`)
    assertString(subject.value, `${subjectPath}.value`)
    if (subject.kind === 'pyth-feed') assertHex(subject.value, `${subjectPath}.value`)
    else assertAddress(subject.value, `${subjectPath}.value`)
  })
}

const assertRequest = (value: unknown, path: string, transport: 'eoa' | 'safe') => {
  assertRecord(value, path)
  const idKey = transport === 'eoa' ? 'requestId' : 'callId'
  assertExactKeys(value, transport === 'eoa'
    ? ['requestId', 'effectIds', 'phase', 'chainId', 'from', 'to', 'data', 'value']
    : ['callId', 'effectIds', 'phase', 'to', 'data', 'value'], path)
  assertHash(value[idKey], `${path}.${idKey}`)
  if (!Array.isArray(value.effectIds) || !value.effectIds.length) throw new Error(`${path}.effectIds must be non-empty`)
  value.effectIds.forEach((effectId, index) => assertHash(effectId, `${path}.effectIds[${index}]`))
  if (!['prerequisite', 'core', 'cleanup'].includes(value.phase as string)) throw new Error(`${path}.phase is unsupported`)
  if (transport === 'eoa') {
    assertSafeInteger(value.chainId, `${path}.chainId`, 1)
    assertAddress(value.from, `${path}.from`)
  }
  assertAddress(value.to, `${path}.to`)
  assertHex(value.data, `${path}.data`)
  assertBigInt(value.value, `${path}.value`)
}

const assertTypedData = (value: unknown, path: string) => {
  assertRecord(value, path)
  assertExactKeys(value, ['domain', 'types', 'primaryType', 'message'], path)
  assertRecord(value.domain, `${path}.domain`)
  assertExactKeys(value.domain, ['name', 'version', 'chainId', 'verifyingContract', 'salt'], `${path}.domain`)
  assertOptional(value.domain.name, `${path}.domain.name`, assertString)
  assertOptional(value.domain.version, `${path}.domain.version`, assertString)
  assertOptional(value.domain.chainId, `${path}.domain.chainId`, (candidate, candidatePath) => {
    if (typeof candidate === 'bigint') assertBigInt(candidate, candidatePath)
    else assertSafeInteger(candidate, candidatePath, 1)
  })
  assertOptional(value.domain.verifyingContract, `${path}.domain.verifyingContract`, assertAddress)
  assertOptional(value.domain.salt, `${path}.domain.salt`, assertHex)
  assertRecord(value.types, `${path}.types`)
  assertString(value.primaryType, `${path}.primaryType`)

  const types = value.types as Record<string, unknown>
  for (const [typeName, fields] of Object.entries(types)) {
    if (!typeName) throw new Error(`${path}.types contains an empty type name`)
    if (!Array.isArray(fields) || !fields.length) throw new Error(`${path}.types.${typeName} must be a non-empty array`)
    const fieldNames = new Set<string>()
    fields.forEach((field, index) => {
      const fieldPath = `${path}.types.${typeName}[${index}]`
      assertRecord(field, fieldPath)
      assertExactKeys(field, ['name', 'type'], fieldPath)
      assertString(field.name, `${fieldPath}.name`)
      assertString(field.type, `${fieldPath}.type`)
      if (fieldNames.has(field.name)) throw new Error(`${path}.types.${typeName} contains a duplicate field`)
      fieldNames.add(field.name)
    })
  }
  if (!Array.isArray(types[value.primaryType as string])) throw new Error(`${path}.primaryType is not declared`)

  const assertTypedValue = (candidate: unknown, solidityType: string, candidatePath: string, ancestors: readonly string[]) => {
    const arrayMatch = solidityType.match(/^(.*)\[(\d*)\]$/)
    if (arrayMatch) {
      if (!Array.isArray(candidate)) throw new Error(`${candidatePath} must be an array`)
      const fixedLength = arrayMatch[2] ? Number(arrayMatch[2]) : undefined
      if (fixedLength !== undefined && candidate.length !== fixedLength) throw new Error(`${candidatePath} has the wrong fixed-array length`)
      candidate.forEach((entry, index) => assertTypedValue(entry, arrayMatch[1]!, `${candidatePath}[${index}]`, ancestors))
      return
    }
    if (solidityType === 'address') return assertAddress(candidate, candidatePath)
    if (solidityType === 'bool') return assertBoolean(candidate, candidatePath)
    if (solidityType === 'string') {
      if (typeof candidate !== 'string') throw new Error(`${candidatePath} must be a string`)
      return
    }
    if (/^bytes(?:\d+)?$/.test(solidityType)) return assertHex(candidate, candidatePath)
    if (/^(?:u?int)(?:\d+)?$/.test(solidityType)) {
      if (typeof candidate === 'bigint') {
        if (solidityType.startsWith('uint')) assertBigInt(candidate, candidatePath)
        return
      }
      if (!Number.isSafeInteger(candidate)) throw new Error(`${candidatePath} must be an integer`)
      if (solidityType.startsWith('uint') && (candidate as number) < 0) throw new Error(`${candidatePath} must be unsigned`)
      return
    }
    const fields = types[solidityType]
    if (!Array.isArray(fields)) throw new Error(`${candidatePath} uses undeclared type ${solidityType}`)
    if (ancestors.includes(solidityType)) throw new Error(`${candidatePath} contains a recursive typed-data value`)
    assertRecord(candidate, candidatePath)
    const typedFields = fields as Record<string, unknown>[]
    assertExactKeys(candidate, typedFields.map(field => field.name as string), candidatePath)
    for (const field of typedFields) {
      const name = field.name as string
      if (candidate[name] === undefined) throw new Error(`${candidatePath}.${name} is required`)
      assertTypedValue(candidate[name], field.type as string, `${candidatePath}.${name}`, [...ancestors, solidityType])
    }
  }
  assertTypedValue(value.message, value.primaryType as string, `${path}.message`, [])
}

const assertSignatureSlot = (value: unknown, path: string) => {
  assertRecord(value, path)
  assertExactKeys(value, ['slotId', 'kind', 'signer', 'chainId', 'typedData', 'typedDataHash', 'validUntil', 'nonce', 'insertionPoints'], path)
  assertHash(value.slotId, `${path}.slotId`)
  if (value.kind !== 'permit2' && value.kind !== 'migration') throw new Error(`${path}.kind is unsupported`)
  assertAddress(value.signer, `${path}.signer`)
  assertSafeInteger(value.chainId, `${path}.chainId`, 1)
  assertTypedData(value.typedData, `${path}.typedData`)
  assertHash(value.typedDataHash, `${path}.typedDataHash`)
  assertOptional(value.validUntil, `${path}.validUntil`, (candidate, candidatePath) => assertSafeInteger(candidate, candidatePath, 1))
  assertOptional(value.nonce, `${path}.nonce`, (candidate, candidatePath) => assertBigInt(candidate, candidatePath))
  if (!Array.isArray(value.insertionPoints) || !value.insertionPoints.length) throw new Error(`${path}.insertionPoints must be non-empty`)
  value.insertionPoints.forEach((point, index) => {
    const pointPath = `${path}.insertionPoints[${index}]`
    assertRecord(point, pointPath)
    assertExactKeys(point, ['requestId', 'effectId', 'batchItemIndex', 'abiArgumentPath'], pointPath)
    assertHash(point.requestId, `${pointPath}.requestId`)
    assertHash(point.effectId, `${pointPath}.effectId`)
    assertSafeInteger(point.batchItemIndex, `${pointPath}.batchItemIndex`)
    if (!Array.isArray(point.abiArgumentPath) || !point.abiArgumentPath.length || point.abiArgumentPath.some(part => typeof part !== 'string' && !Number.isSafeInteger(part))) {
      throw new Error(`${pointPath}.abiArgumentPath is invalid`)
    }
  })
}

const assertPythSlot = (value: unknown, path: string) => {
  assertRecord(value, path)
  assertExactKeys(value, ['slotId', 'kind', 'chainId', 'target', 'selector', 'requiredFeedIds', 'maxValue', 'freshnessPolicy', 'previewPayloadHash', 'previewPublishTimes', 'previewValue', 'sourcePlanItemIndex', 'sourceBatchItemIndex', 'insertionPoint'], path)
  assertHash(value.slotId, `${path}.slotId`)
  if (value.kind !== 'pyth-update-v1') throw new Error(`${path}.kind is unsupported`)
  assertSafeInteger(value.chainId, `${path}.chainId`, 1)
  assertAddress(value.target, `${path}.target`)
  assertHex(value.selector, `${path}.selector`)
  if (!Array.isArray(value.requiredFeedIds) || !value.requiredFeedIds.length) throw new Error(`${path}.requiredFeedIds must be non-empty`)
  value.requiredFeedIds.forEach((feed, index) => assertHex(feed, `${path}.requiredFeedIds[${index}]`))
  assertBigInt(value.maxValue, `${path}.maxValue`)
  assertRecord(value.freshnessPolicy, `${path}.freshnessPolicy`)
  assertExactKeys(value.freshnessPolicy, ['maximumAgeSeconds', 'minimumPublishTime'], `${path}.freshnessPolicy`)
  assertSafeInteger(value.freshnessPolicy.maximumAgeSeconds, `${path}.freshnessPolicy.maximumAgeSeconds`, 1)
  assertOptional(value.freshnessPolicy.minimumPublishTime, `${path}.freshnessPolicy.minimumPublishTime`, (candidate, candidatePath) => assertSafeInteger(candidate, candidatePath))
  assertHash(value.previewPayloadHash, `${path}.previewPayloadHash`)
  if (!Array.isArray(value.previewPublishTimes) || !value.previewPublishTimes.length) throw new Error(`${path}.previewPublishTimes must be non-empty`)
  value.previewPublishTimes.forEach((time, index) => assertSafeInteger(time, `${path}.previewPublishTimes[${index}]`))
  assertBigInt(value.previewValue, `${path}.previewValue`)
  assertSafeInteger(value.sourcePlanItemIndex, `${path}.sourcePlanItemIndex`)
  assertSafeInteger(value.sourceBatchItemIndex, `${path}.sourceBatchItemIndex`)
  assertRecord(value.insertionPoint, `${path}.insertionPoint`)
  assertExactKeys(value.insertionPoint, ['requestId', 'effectId', 'batchItemIndex'], `${path}.insertionPoint`)
  assertHash(value.insertionPoint.requestId, `${path}.insertionPoint.requestId`)
  assertHash(value.insertionPoint.effectId, `${path}.insertionPoint.effectId`)
  assertSafeInteger(value.insertionPoint.batchItemIndex, `${path}.insertionPoint.batchItemIndex`)
}

export function assertReviewedRequestSet(value: unknown): asserts value is ReviewedRequestSet {
  assertRecord(value, 'requestSet')
  assertExactKeys(value, ['schemaVersion', 'wallet', 'effects', 'transport', 'requests', 'safeTransport', 'signatureSlots', 'pythRefreshSlots', 'constraints', 'policyDigest'], 'requestSet')
  if (value.schemaVersion !== 1) throw new Error('requestSet.schemaVersion is unsupported')
  assertRecord(value.wallet, 'requestSet.wallet')
  assertExactKeys(value.wallet, ['chainId', 'account', 'subAccounts', 'connectorId', 'connectorSessionId', 'walletKind', 'safeAddress', 'classificationVersion', 'approvalMode'], 'requestSet.wallet')
  assertSafeInteger(value.wallet.chainId, 'requestSet.wallet.chainId', 1)
  assertAddress(value.wallet.account, 'requestSet.wallet.account')
  assertAddressArray(value.wallet.subAccounts, 'requestSet.wallet.subAccounts')
  assertString(value.wallet.connectorId, 'requestSet.wallet.connectorId')
  assertString(value.wallet.connectorSessionId, 'requestSet.wallet.connectorSessionId')
  if (value.wallet.walletKind !== 'eoa' && value.wallet.walletKind !== 'safe') throw new Error('requestSet.wallet.walletKind is unsupported')
  if (value.wallet.safeAddress !== undefined) assertAddress(value.wallet.safeAddress, 'requestSet.wallet.safeAddress')
  if (value.wallet.walletKind === 'safe' && value.wallet.safeAddress === undefined) throw new Error('requestSet.wallet.safeAddress is required for Safe wallets')
  assertString(value.wallet.classificationVersion, 'requestSet.wallet.classificationVersion')
  if (value.wallet.approvalMode !== 'permit2' && value.wallet.approvalMode !== 'approve') throw new Error('requestSet.wallet.approvalMode is unsupported')
  if (value.transport !== 'eoa' && value.transport !== 'safe') throw new Error('requestSet.transport is unsupported')
  const transport = value.transport
  if (value.transport !== value.wallet.walletKind) throw new Error('requestSet transport must match the wallet kind')
  if (!Array.isArray(value.effects)) throw new Error('requestSet.effects must be an array')
  value.effects.forEach((entry, index) => assertEffectNode(entry, `requestSet.effects[${index}]`))
  if (!Array.isArray(value.requests)) throw new Error('requestSet.requests must be an array')
  value.requests.forEach((entry, index) => assertRequest(entry, `requestSet.requests[${index}]`, transport))
  if (value.safeTransport !== undefined) {
    assertRecord(value.safeTransport, 'requestSet.safeTransport')
    assertExactKeys(value.safeTransport, ['schemaVersion', 'version', 'from', 'chainId', 'atomicRequired', 'calls', 'capabilities', 'atomicCapability'], 'requestSet.safeTransport')
    if (value.safeTransport.schemaVersion !== 1) throw new Error('requestSet.safeTransport.schemaVersion is unsupported')
    if (value.safeTransport.version !== '2.0.0') throw new Error('requestSet.safeTransport.version is unsupported')
    assertAddress(value.safeTransport.from, 'requestSet.safeTransport.from')
    assertSafeInteger(value.safeTransport.chainId, 'requestSet.safeTransport.chainId', 1)
    if (value.safeTransport.atomicRequired !== true) throw new Error('requestSet.safeTransport.atomicRequired must be true')
    if (!Array.isArray(value.safeTransport.calls)) throw new Error('requestSet.safeTransport.calls must be an array')
    value.safeTransport.calls.forEach((call, index) => {
      const path = `requestSet.safeTransport.calls[${index}]`
      assertRecord(call, path)
      assertExactKeys(call, ['to', 'data', 'value'], path)
      assertAddress(call.to, `${path}.to`)
      assertHex(call.data, `${path}.data`)
      assertBigInt(call.value, `${path}.value`)
    })
    assertRecord(value.safeTransport.capabilities, 'requestSet.safeTransport.capabilities')
    assertExactKeys(value.safeTransport.capabilities, [], 'requestSet.safeTransport.capabilities')
    assertRecord(value.safeTransport.atomicCapability, 'requestSet.safeTransport.atomicCapability')
    assertExactKeys(value.safeTransport.atomicCapability, ['status'], 'requestSet.safeTransport.atomicCapability')
    if (value.safeTransport.atomicCapability.status !== 'supported' && value.safeTransport.atomicCapability.status !== 'ready') {
      throw new Error('requestSet.safeTransport.atomicCapability.status is unsupported')
    }
  }
  if (transport === 'safe' && value.safeTransport === undefined) throw new Error('requestSet.safeTransport is required for Safe wallets')
  if (transport === 'eoa' && value.safeTransport !== undefined) throw new Error('requestSet.safeTransport is invalid for EOA wallets')
  if (!Array.isArray(value.signatureSlots)) throw new Error('requestSet.signatureSlots must be an array')
  value.signatureSlots.forEach((entry, index) => assertSignatureSlot(entry, `requestSet.signatureSlots[${index}]`))
  if (!Array.isArray(value.pythRefreshSlots)) throw new Error('requestSet.pythRefreshSlots must be an array')
  value.pythRefreshSlots.forEach((entry, index) => assertPythSlot(entry, `requestSet.pythRefreshSlots[${index}]`))
  if (!Array.isArray(value.constraints)) throw new Error('requestSet.constraints must be an array')
  value.constraints.forEach((entry, index) => assertIntentConstraint(entry, `requestSet.constraints[${index}]`))
  assertHash(value.policyDigest, 'requestSet.policyDigest')
}

export function assertReviewedExecution(value: unknown): asserts value is ReviewedExecution {
  assertRecord(value, 'execution')
  assertExactKeys(value, ['schemaVersion', 'reviewId', 'requestDigest', 'reviewDigest', 'intents', 'requestSet', 'policy', 'simulation', 'effectMap', 'binding', 'validity', 'pluginSnapshot'], 'execution')
  if (value.schemaVersion !== 1) throw new Error('execution.schemaVersion is unsupported')
  assertHash(value.reviewId, 'execution.reviewId')
  assertHash(value.requestDigest, 'execution.requestDigest')
  assertHash(value.reviewDigest, 'execution.reviewDigest')
  if (!Array.isArray(value.intents) || value.intents.length === 0) throw new Error('execution.intents must be non-empty')
  value.intents.forEach(assertOperationIntent)
  assertReviewedRequestSet(value.requestSet)
  assertReviewedPolicy(value.policy, 'execution.policy')
  assertSimulation(value.simulation, 'execution.simulation')
  assertEffectMap(value.effectMap, 'execution.effectMap')
  assertReviewBinding(value.binding, 'execution.binding')
  assertValidity(value.validity, 'execution.validity')
  assertPluginSnapshot(value.pluginSnapshot, 'execution.pluginSnapshot')
}
