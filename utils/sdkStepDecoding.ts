import { formatUnits, getAddress } from 'viem'
import { flattenBatchEntries, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import type { DisplayStep, StepAssetInfo, StepDecodingContext, VaultLookup } from '~/utils/stepDecoding'
import {
  decodeBatchItemLabel,
  decodeVaultAddressFromData,
  decodeFirstUint256,
  decodeSecondUint256,
  cleanStepLabel,
} from '~/utils/stepDecoding'

const MAX_UINT256 = 2n ** 256n - 1n

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
        const raw = decodeFirstUint256(data)
        const decimals = Number(targetVault.asset.decimals)
        const amount = raw === undefined
          ? ctx.amount
          : raw === MAX_UINT256
            ? 'max'
            : formatUnits(raw, decimals)
        return { symbol: targetVault.asset.symbol, address: targetVault.asset.address, amount }
      }
    }
    catch { /* ignore */ }
    return { symbol: ctx.asset.symbol, address: ctx.asset.address, amount: ctx.amount }
  }

  if (label === 'Withdraw') {
    return { symbol: ctx.asset.symbol, address: ctx.asset.address, amount: ctx.amount }
  }

  if (label === 'Wrap native currency') {
    const nativeSymbol = ctx.asset.symbol.startsWith('W') ? ctx.asset.symbol.slice(1) : ctx.asset.symbol
    const wrapAmount = value > 0n ? formatUnits(value, 18) : undefined
    return { symbol: nativeSymbol, address: '0x0000000000000000000000000000000000000000', amount: wrapAmount }
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
    const raw = decodeFirstUint256(data)
    const amount = raw === MAX_UINT256
      ? 'max'
      : (raw !== undefined && raw > 0n
          ? formatUnits(raw, Number(getVault(getAddress(targetContract))?.asset?.decimals ?? 18))
          : ctx.amount)
    return { ...base, amount }
  }

  if (label === 'Update price feeds') {
    return { symbol: ctx.asset.symbol, address: ctx.asset.address }
  }

  return undefined
}

/**
 * Convert an SDK TransactionPlan into the UI-facing DisplayStep[] consumed by
 * OperationStepsList. Counterpart to utils/stepDecoding.ts for Lite TxPlan;
 * this version walks SDK plan items (`requiredApproval`, `evcBatch`,
 * `contractCall`) and applies the same display conventions.
 */
export function buildSdkDisplaySteps(
  plan: TransactionPlan,
  ctx: StepDecodingContext,
  getVault: VaultLookup,
  getLogoUrl: (address: string, symbol: string) => string,
): DisplayStep[] {
  const steps: DisplayStep[] = []
  let index = 0

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
        const assetInfo = resolveBatchItemAssetInfo(
          label,
          batchItem.data,
          batchItem.targetContract,
          batchItem.value,
          ctx,
          getVault,
        )
        const displayLabel = label === 'Transfer to account'
          ? 'Transfer'
          : label === 'Wrap native currency'
            ? 'Wrap'
            : label
        const labelSuffix = label === 'Transfer to account' ? 'to savings' : undefined
        steps.push({
          index,
          label: displayLabel,
          labelSuffix,
          isSeparateTx: false,
          assetInfo,
          iconOnly: label === 'Update price feeds',
        })
      }
      continue
    }

    if (item.type === 'contractCall') {
      index++
      steps.push({
        index,
        label: cleanStepLabel(item.functionName),
        isSeparateTx: true,
      })
      continue
    }

    // cowSwap items: skip silently; CoW flows surface their own UI.
  }

  // Silence unused-parameter warning while keeping the signature parity with
  // the Lite step decoder for future expansion (reward icons etc).
  void getLogoUrl

  return steps
}
