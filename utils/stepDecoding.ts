import { formatUnits, getAddress, toFunctionSelector, zeroAddress } from 'viem'
import { flattenBatchEntries, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { SwapperMode } from '@eulerxyz/euler-v2-sdk'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StepAssetInfo {
  symbol: string
  address?: string
  /** Optional address used only for the displayed asset logo. */
  iconAddress?: string
  amount?: number | string
  iconUrl?: string
  /** When true, the displayed amount is an estimate (rendered with a "~" prefix). */
  estimated?: boolean
}

export interface DisplayStep {
  index: number
  label: string
  labelSuffix?: string
  isSeparateTx: boolean
  assetInfo?: StepAssetInfo
  toAssetInfo?: StepAssetInfo
  iconOnly?: boolean
}

/** Structurally matches useVaultRegistry().getVault */
export type VaultLookup = (address: string) => {
  asset: { symbol: string, address: string, decimals: number | bigint }
} | undefined

export interface StepDecodingContext {
  type?: string
  asset: { symbol: string, address: string, decimals?: number | bigint }
  assetIconUrl?: string
  amount: number | string
  supplyingAssetForBorrow?: { symbol: string, address: string }
  supplyingAmount?: number | string
  swapToAsset?: { symbol: string, address: string, decimals: number | bigint }
  swapToAmount?: number | string
  swapMode?: SwapperMode
  swapEstimatedSide?: 'input' | 'output'
  transferAmounts?: Record<string, string>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VERIFY_AMOUNT_MIN_AND_SKIM_SELECTOR = toFunctionSelector('function verifyAmountMinAndSkim(address,address,uint256,uint256)')
const VERIFY_AMOUNT_MIN_AND_TRANSFER_SELECTOR = toFunctionSelector('function verifyAmountMinAndTransfer(address,address,uint256,uint256)')
const VERIFY_DEBT_MAX_SELECTOR = toFunctionSelector('function verifyDebtMax(address,address,uint256,uint256)')

const SELECTOR_LABELS: Record<string, string> = {
  [toFunctionSelector('function deposit(uint256,address)')]: 'Supply',
  [toFunctionSelector('function borrow(uint256,address)')]: 'Borrow',
  [toFunctionSelector('function repay(uint256,address)')]: 'Repay',
  [toFunctionSelector('function withdraw(uint256,address,address)')]: 'Withdraw',
  [toFunctionSelector('function redeem(uint256,address,address)')]: 'Withdraw',
  [toFunctionSelector('function enableController(address,address)')]: 'Enable controller',
  [toFunctionSelector('function enableCollateral(address,address)')]: 'Enable collateral',
  [toFunctionSelector('function disableController()')]: 'Disable controller',
  [toFunctionSelector('function disableCollateral(address,address)')]: 'Disable collateral',
  [toFunctionSelector('function transfer(address,uint256)')]: 'Transfer',
  [toFunctionSelector('function transferFromMax(address,address)')]: 'Transfer to account',
  [toFunctionSelector('function skim(uint256,address)')]: 'Deposit',
  [toFunctionSelector('function repayWithShares(uint256,address)')]: 'Repay',
  [toFunctionSelector('function signTermsOfUse(string,bytes32)')]: 'Sign terms of use',
  [toFunctionSelector('function multicall(bytes[])')]: 'Swap',
  [VERIFY_AMOUNT_MIN_AND_SKIM_SELECTOR]: 'Verify min received',
  [VERIFY_AMOUNT_MIN_AND_TRANSFER_SELECTOR]: 'Verify min received',
  [VERIFY_DEBT_MAX_SELECTOR]: 'Verify max debt',
  [toFunctionSelector('function updatePriceFeeds(bytes[])')]: 'Update price feeds',
  [toFunctionSelector('function transferFromSender(address,uint256,address)')]: 'Transfer from wallet',
  [toFunctionSelector('function deposit()')]: 'Wrap native currency',
  [toFunctionSelector('function createCredential(address,uint256,uint256,uint256,uint256,bytes,bytes,bytes)')]: 'Identity verification',
}

const MAX_UINT256 = 2n ** 256n - 1n
const SHARES_AMOUNT_SELECTORS = new Set([
  toFunctionSelector('function redeem(uint256,address,address)'),
  toFunctionSelector('function repayWithShares(uint256,address)'),
])
const SWAP_VERIFIER_AMOUNT_SELECTORS = new Set([
  VERIFY_AMOUNT_MIN_AND_SKIM_SELECTOR,
  VERIFY_AMOUNT_MIN_AND_TRANSFER_SELECTOR,
  VERIFY_DEBT_MAX_SELECTOR,
])

export type SwapEstimatedSide = 'input' | 'output'

export const getDefaultSwapEstimatedSide = (swapMode: SwapperMode): SwapEstimatedSide => {
  switch (swapMode) {
    case SwapperMode.EXACT_IN:
      return 'output'
    case SwapperMode.EXACT_OUT:
    case SwapperMode.TARGET_DEBT:
      return 'input'
    default: {
      const exhaustive: never = swapMode
      return exhaustive
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const decodeBatchItemLabel = (data: string): string => {
  const selector = data.slice(0, 10).toLowerCase()
  return SELECTOR_LABELS[selector] || 'Unknown operation'
}

export const cleanStepLabel = (label: string): string => {
  const cleaned = label
    .replace(/\s*via EVC$/i, '')
    .replace(/^Permit2\s+/i, '')
  return cleaned ? `${cleaned[0].toUpperCase()}${cleaned.slice(1)}` : cleaned
}

export const decodeVaultAddressFromData = (data: string): string | undefined => {
  if (data.length < 138) return undefined
  try {
    return getAddress(`0x${data.slice(98, 138)}`)
  }
  catch {
    return undefined
  }
}

export const decodeSecondUint256 = (data: string): bigint | undefined => {
  if (data.length < 138) return undefined
  try {
    return BigInt(`0x${data.slice(74, 138)}`)
  }
  catch {
    return undefined
  }
}

const decodeThirdUint256 = (data: string): bigint | undefined => {
  if (data.length < 202) return undefined
  try {
    return BigInt(`0x${data.slice(138, 202)}`)
  }
  catch {
    return undefined
  }
}

export const decodeFirstUint256 = (data: string): bigint | undefined => {
  if (data.length < 74) return undefined
  try {
    return BigInt(`0x${data.slice(10, 74)}`)
  }
  catch {
    return undefined
  }
}

const resolveAmountFromCalldata = (
  data: string,
  targetContract: string,
  getVault: VaultLookup,
): { decoded: boolean, amount?: string, isMax?: boolean } => {
  const selector = data.slice(0, 10).toLowerCase() as `0x${string}`
  const raw = decodeFirstUint256(data)

  if (raw === undefined) return { decoded: false }
  if (raw === MAX_UINT256) return { decoded: true, isMax: true }
  if (raw === 0n) return { decoded: true }
  if (SHARES_AMOUNT_SELECTORS.has(selector)) return { decoded: false }

  try {
    const vault = getVault(getAddress(targetContract))
    if (vault?.asset?.decimals) {
      return { decoded: true, amount: formatUnits(raw, Number(vault.asset.decimals)) }
    }
  }
  catch { /* ignore */ }

  return { decoded: false }
}

const decodeFirstAddress = (data: string): string | undefined => {
  if (data.length < 74) return undefined
  try {
    return getAddress(`0x${data.slice(34, 74)}`)
  }
  catch {
    return undefined
  }
}

const sameAddress = (a?: string, b?: string) => {
  if (!a || !b) return false
  try {
    return getAddress(a) === getAddress(b)
  }
  catch {
    return false
  }
}

const resolveContextAssetByAddress = (
  address: string,
  ctx: StepDecodingContext,
): StepDecodingContext['asset'] | StepDecodingContext['swapToAsset'] | undefined => {
  if (sameAddress(address, ctx.asset.address)) return ctx.asset
  if (ctx.swapToAsset && sameAddress(address, ctx.swapToAsset.address)) return ctx.swapToAsset
  return undefined
}

const buildAssetInfo = (
  asset: { symbol: string, address: string, decimals?: number | bigint },
  rawAmount?: bigint,
): StepAssetInfo => ({
  symbol: asset.symbol,
  address: asset.address,
  amount: rawAmount !== undefined && asset.decimals !== undefined
    ? formatUnits(rawAmount, Number(asset.decimals))
    : undefined,
})

const getVaultAssetInfo = (
  data: string,
  targetContract: string,
  getVault: VaultLookup,
): StepAssetInfo | undefined => {
  const vaultAddress = decodeVaultAddressFromData(data)
  const vault = vaultAddress ? getVault(vaultAddress) : undefined
  if (vault?.asset) return { symbol: vault.asset.symbol, address: vault.asset.address }
  try {
    const targetVault = getVault(getAddress(targetContract))
    if (targetVault?.asset) return { symbol: targetVault.asset.symbol, address: targetVault.asset.address }
  }
  catch { /* ignore */ }
  return undefined
}

const getSwapVerifierAssetInfo = (
  data: string,
  ctx: StepDecodingContext,
  getVault: VaultLookup,
): StepAssetInfo | undefined => {
  const selector = data.slice(0, 10).toLowerCase() as `0x${string}`
  if (!SWAP_VERIFIER_AMOUNT_SELECTORS.has(selector)) return undefined

  const firstAddress = decodeFirstAddress(data)
  if (!firstAddress) return undefined

  const rawAmount = decodeThirdUint256(data)

  if (selector === VERIFY_AMOUNT_MIN_AND_TRANSFER_SELECTOR) {
    const asset = resolveContextAssetByAddress(firstAddress, ctx) ?? ctx.swapToAsset ?? ctx.asset
    return buildAssetInfo(asset, rawAmount)
  }

  const vault = getVault(firstAddress)
  const asset = vault?.asset ?? ctx.swapToAsset ?? ctx.asset
  return buildAssetInfo(asset, rawAmount)
}

const resolveBatchItemAssetInfo = (
  label: string,
  data: string,
  targetContract: string,
  value: bigint,
  ctx: StepDecodingContext,
  getVault: VaultLookup,
): StepAssetInfo | undefined => {
  if (label === 'Enable collateral' || label === 'Enable controller'
    || label === 'Disable collateral' || label === 'Disable controller') {
    return getVaultAssetInfo(data, targetContract, getVault)
  }

  if (label === 'Supply' || label === 'Deposit') {
    try {
      const targetVault = getVault(getAddress(targetContract))
      if (targetVault?.asset) {
        const resolved = resolveAmountFromCalldata(data, targetContract, getVault)
        const amount = resolved.isMax
          ? 'remaining'
          : resolved.decoded && resolved.amount
            ? resolved.amount
            : label === 'Deposit'
              ? ctx.swapToAmount ?? 'remaining'
              : ctx.amount
        return { symbol: targetVault.asset.symbol, address: targetVault.asset.address, amount }
      }
    }
    catch { /* ignore */ }
    return { symbol: ctx.asset.symbol, address: ctx.asset.address, amount: ctx.amount }
  }

  if (label === 'Withdraw') {
    const resolved = resolveAmountFromCalldata(data, targetContract, getVault)
    const amount = resolved.isMax
      ? 'remaining'
      : resolved.decoded && resolved.amount
        ? resolved.amount
        : ctx.amount
    return { symbol: ctx.asset.symbol, address: ctx.asset.address, amount }
  }

  if (label === 'Wrap native currency') {
    const nativeSymbol = ctx.asset.symbol.startsWith('W') ? ctx.asset.symbol.slice(1) : ctx.asset.symbol
    const wrapAmount = value > 0n ? formatUnits(value, 18) : undefined
    return { symbol: nativeSymbol, address: zeroAddress, amount: wrapAmount }
  }

  if (label === 'Verify min received' || label === 'Verify max debt') {
    return getSwapVerifierAssetInfo(data, ctx, getVault)
  }

  if (label === 'Transfer' || label === 'Transfer to account' || label === 'Transfer from wallet') {
    // transferFromMax(address,address) ("Transfer to account") has no amount
    // argument — its second calldata slot is the recipient address, not a
    // uint256. Decoding it as an amount would render a garbage number, so show
    // the known sweep amount (or "remaining") instead.
    const isMaxTransfer = label === 'Transfer to account'
    const fallbackAmount = isMaxTransfer
      ? ctx.transferAmounts?.[targetContract.toLowerCase()] ?? 'remaining'
      : undefined
    try {
      const targetVault = getVault(getAddress(targetContract))
      if (targetVault?.asset) {
        let amount = fallbackAmount
        if (!isMaxTransfer) {
          const raw = decodeSecondUint256(data)
          amount = raw !== undefined && raw > 0n
            ? formatUnits(raw, Number(targetVault.asset.decimals))
            : undefined
        }
        return { symbol: targetVault.asset.symbol, address: targetVault.asset.address, amount }
      }
    }
    catch { /* ignore */ }
    return { symbol: ctx.asset.symbol, address: ctx.asset.address, amount: fallbackAmount }
  }

  if (label === 'Borrow' || label === 'Repay') {
    const vaultAsset = getVaultAssetInfo(data, targetContract, getVault)
    const base = vaultAsset || { symbol: ctx.asset.symbol, address: ctx.asset.address }
    const resolved = resolveAmountFromCalldata(data, targetContract, getVault)
    const amount = resolved.isMax
      ? 'max'
      : resolved.decoded && resolved.amount
        ? resolved.amount
        : ctx.amount
    return { ...base, amount }
  }

  if (label === 'Swap') {
    return { symbol: ctx.asset.symbol, address: ctx.asset.address, amount: ctx.amount }
  }

  if (label === 'Update price feeds') {
    return { symbol: ctx.asset.symbol, address: ctx.asset.address }
  }

  return undefined
}

/**
 * Convert an SDK TransactionPlan into the UI-facing DisplayStep[] consumed by
 * OperationStepsList. Walks SDK plan items (`requiredApproval`, `evcBatch`,
 * `contractCall`) and applies display conventions for the review modal.
 */
export function buildTransactionPlanDisplaySteps(
  plan: TransactionPlan,
  ctx: StepDecodingContext,
  getVault: VaultLookup,
  getLogoUrl: (address: string, symbol: string) => string,
): DisplayStep[] {
  const steps: DisplayStep[] = []
  let index = 0
  let lastWithdrawAmount: string | undefined
  let previousLabel = ''

  for (const item of plan) {
    if (item.type === 'requiredApproval') {
      const resolved = item.resolved ?? []
      for (const r of resolved) {
        index++
        if (r.type === 'approve') {
          steps.push({
            index,
            label: 'Approve',
            labelSuffix: 'for vault',
            isSeparateTx: true,
            assetInfo: { symbol: ctx.asset.symbol, address: ctx.asset.address },
          })
        }
        else {
          // permit2 signature (no on-chain tx; embedded into the next batch)
          steps.push({
            index,
            label: 'Sign permit2 message',
            isSeparateTx: false,
            assetInfo: { symbol: ctx.asset.symbol, address: ctx.asset.address },
          })
        }
      }
      continue
    }

    if (item.type === 'evcBatch') {
      const batchItems = flattenBatchEntries(item.items)
      for (const batchItem of batchItems) {
        index++
        const label = decodeBatchItemLabel(batchItem.data)
        let assetInfo = resolveBatchItemAssetInfo(
          label,
          batchItem.data,
          batchItem.targetContract,
          batchItem.value,
          ctx,
          getVault,
        )
        if (label === 'Withdraw' && assetInfo?.amount && assetInfo.amount !== 'remaining') {
          lastWithdrawAmount = String(assetInfo.amount)
        }
        let toAssetInfo: StepAssetInfo | undefined
        if (label === 'Wrap native currency') {
          toAssetInfo = { symbol: ctx.asset.symbol, address: ctx.asset.address }
        }
        else if (label === 'Swap' && ctx.swapToAsset && ctx.swapToAmount) {
          assetInfo = { symbol: ctx.asset.symbol, address: ctx.asset.address, amount: lastWithdrawAmount ?? ctx.amount }
          toAssetInfo = { symbol: ctx.swapToAsset.symbol, address: ctx.swapToAsset.address, amount: ctx.swapToAmount }
          const estimatedSide = ctx.swapEstimatedSide
            ?? (ctx.swapMode !== undefined ? getDefaultSwapEstimatedSide(ctx.swapMode) : undefined)
          if (estimatedSide === 'input') {
            assetInfo = { ...assetInfo, estimated: true }
          }
          else if (estimatedSide === 'output') {
            toAssetInfo = { ...toAssetInfo, estimated: true }
          }
        }
        let displayLabel = label
        if (label === 'Transfer to account') {
          displayLabel = 'Transfer'
        }
        else if (label === 'Wrap native currency') {
          displayLabel = 'Wrap'
        }
        else if (label === 'Swap' && ctx.swapMode === SwapperMode.TARGET_DEBT) {
          displayLabel = 'Swap to repay'
        }
        const isWrapTransfer = label === 'Transfer' && previousLabel === 'Wrap native currency'
        const labelSuffix = label === 'Transfer to account'
          ? 'to savings'
          : isWrapTransfer
            ? 'to wallet'
            : undefined
        steps.push({
          index,
          label: displayLabel,
          labelSuffix,
          isSeparateTx: false,
          assetInfo,
          toAssetInfo,
          iconOnly: label === 'Update price feeds',
        })
        previousLabel = label
      }
      continue
    }

    if (item.type === 'contractCall') {
      index++
      const isRewardOrUnlock = ctx.type === 'reward'
        || ctx.type === 'brevis-reward'
        || ctx.type === 'fuul-reward'
        || ctx.type === 'turtle-reward'
        || ctx.type === 'reul-unlock'
      const rewardIconUrl = ['EUL', 'rEUL'].includes(ctx.asset.symbol)
        ? getLogoUrl(ctx.asset.address, 'EUL')
        : ctx.assetIconUrl
      steps.push({
        index,
        label: cleanStepLabel(item.functionName),
        isSeparateTx: true,
        assetInfo: isRewardOrUnlock
          ? {
              symbol: ctx.asset.symbol,
              address: ctx.asset.address,
              amount: ctx.amount,
              iconUrl: rewardIconUrl,
            }
          : undefined,
      })
      continue
    }

    // cowSwap items: skip silently; CoW flows surface their own UI.
  }

  return steps
}
