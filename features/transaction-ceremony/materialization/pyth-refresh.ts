import { decodeFunctionData, getAddress, type Address, type Hash, type Hex } from 'viem'
import { flattenBatchEntries, isEVCBatchOperation, type EVCBatchEntry, type EVCBatchItem, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { PYTH_ABI } from '~/abis/pyth'
import { canonicalDigest, toCanonicalValue, type CanonicalValue } from '../domain/canonical'
import type { PythRefreshSlot } from '../domain/template'
import { pythSelector, type PythPreviewEvidence } from './prepared-plan'

export interface RefreshedPythValue {
  slotId: Hash
  target: Address
  onBehalfOfAccount: Address
  data: Hex
  value: bigint
  payloadHash: Hash
  publishTimes: readonly number[]
}

const flattenedItemAt = (plan: TransactionPlan, planItemIndex: number, batchItemIndex: number): EVCBatchItem => {
  const item = plan[planItemIndex]
  if (!item || item.type !== 'evcBatch') throw new Error(`Pyth slot ${planItemIndex}:${batchItemIndex} does not point to an EVC batch`)
  const batchItem = flattenBatchEntries(item.items)[batchItemIndex]
  if (!batchItem) throw new Error(`Pyth slot ${planItemIndex}:${batchItemIndex} is out of range`)
  return batchItem
}

const normalizeBatchEntries = (
  entries: readonly EVCBatchEntry[],
  planItemIndex: number,
  slots: readonly PythRefreshSlot[],
): CanonicalValue[] => {
  let flatIndex = 0
  return entries.map((entry) => {
    if (isEVCBatchOperation(entry)) {
      const normalizedItems = entry.items.map((item) => {
        const slot = slots.find(candidate => candidate.sourcePlanItemIndex === planItemIndex && candidate.sourceBatchItemIndex === flatIndex++)
        return normalizeBatchItem(item, slot)
      })
      return toCanonicalValue({ ...entry, items: normalizedItems })
    }
    const slot = slots.find(candidate => candidate.sourcePlanItemIndex === planItemIndex && candidate.sourceBatchItemIndex === flatIndex++)
    return normalizeBatchItem(entry, slot)
  })
}

const normalizeBatchItem = (item: EVCBatchItem, slot?: PythRefreshSlot): CanonicalValue => {
  const selector = item.data.slice(0, 10).toLowerCase()
  if (!slot) {
    if (selector === pythSelector.toLowerCase()) throw new Error('Plugin refresh produced an undeclared Pyth update')
    return toCanonicalValue(item)
  }
  if (selector !== slot.selector.toLowerCase()) throw new Error('Declared Pyth slot selector changed')
  return toCanonicalValue({
    ...item,
    data: { dynamicSlot: slot.slotId, kind: slot.kind },
    value: { dynamicSlot: slot.slotId, kind: 'bounded-native-value' },
  })
}

const normalizedPluginPlan = (
  plan: TransactionPlan,
  slots: readonly PythRefreshSlot[],
  phase: 'sealed' | 'refreshed',
): CanonicalValue =>
  plan.map((item, planItemIndex) => {
    if (item.type === 'requiredApproval') {
      if (phase === 'refreshed' && item.resolved !== undefined) {
        throw new Error('Plugin refresh unexpectedly resolved an approval')
      }
      const { resolved: _resolved, ...staticApproval } = item
      return toCanonicalValue(staticApproval)
    }
    if (item.type !== 'evcBatch') return toCanonicalValue(item)
    return toCanonicalValue({ ...item, items: normalizeBatchEntries(item.items, planItemIndex, slots) })
  })

const sameFeedSet = (left: readonly Hex[], right: readonly Hex[]) => {
  const normalize = (values: readonly Hex[]) => [...values].map(value => value.toLowerCase()).sort()
  return canonicalDigest('pyth-feed-set-v1', normalize(left)) === canonicalDigest('pyth-feed-set-v1', normalize(right))
}

const decodePayloads = (data: Hex): readonly Hex[] => {
  try {
    const decoded = decodeFunctionData({ abi: PYTH_ABI, data })
    if (decoded.functionName !== 'updatePriceFeeds') throw new Error('unexpected selector')
    return decoded.args[0]
  }
  catch {
    throw new Error('Refreshed Pyth calldata is malformed')
  }
}

/**
 * Accept the complete rerun plugin pipeline only when its sole structural
 * difference is a declared Pyth payload and bounded native fee.
 */
export const verifyRefreshedPluginPlan = ({
  sealedPreview,
  refreshed,
  slots,
  evidence,
  nowSeconds,
}: {
  sealedPreview: TransactionPlan
  refreshed: TransactionPlan
  slots: readonly PythRefreshSlot[]
  evidence: readonly PythPreviewEvidence[]
  nowSeconds: number
}): readonly RefreshedPythValue[] => {
  const evidenceCoordinates = evidence.map(entry => `${entry.planItemIndex}:${entry.batchItemIndex}`)
  if (evidence.length !== slots.length || new Set(evidenceCoordinates).size !== evidenceCoordinates.length) {
    throw new Error('Refreshed Pyth evidence does not map one-to-one to the reviewed slots')
  }
  const sealedDigest = canonicalDigest('plugin-static-structure-v1', normalizedPluginPlan(sealedPreview, slots, 'sealed'))
  const refreshedDigest = canonicalDigest('plugin-static-structure-v1', normalizedPluginPlan(refreshed, slots, 'refreshed'))
  if (sealedDigest !== refreshedDigest) {
    throw new Error('Plugin refresh changed static plan structure')
  }

  return slots.map((slot) => {
    const item = flattenedItemAt(refreshed, slot.sourcePlanItemIndex, slot.sourceBatchItemIndex)
    const currentEvidence = evidence.find(entry => entry.planItemIndex === slot.sourcePlanItemIndex && entry.batchItemIndex === slot.sourceBatchItemIndex)
    if (!currentEvidence) throw new Error('Refreshed Pyth evidence is missing')
    if (getAddress(item.targetContract) !== getAddress(slot.target) || getAddress(currentEvidence.target) !== getAddress(slot.target)) {
      throw new Error('Refreshed Pyth target changed')
    }
    if (item.data.slice(0, 10).toLowerCase() !== slot.selector.toLowerCase()) throw new Error('Refreshed Pyth selector changed')
    if (!sameFeedSet(currentEvidence.requiredFeedIds, slot.requiredFeedIds)) throw new Error('Refreshed Pyth feed set changed')
    if (item.value < 0n || item.value > slot.maxValue) throw new Error('Refreshed Pyth fee exceeds the reviewed bound')
    if (currentEvidence.publishTimes.length !== slot.requiredFeedIds.length || currentEvidence.publishTimes.length === 0) {
      throw new Error('Refreshed Pyth publish-time evidence is incomplete')
    }
    for (const publishTime of currentEvidence.publishTimes) {
      if (!Number.isSafeInteger(publishTime) || publishTime > nowSeconds) throw new Error('Refreshed Pyth publish time is invalid')
      if (nowSeconds - publishTime > slot.freshnessPolicy.maximumAgeSeconds) throw new Error('Refreshed Pyth payload is stale')
      if (slot.freshnessPolicy.minimumPublishTime !== undefined && publishTime < slot.freshnessPolicy.minimumPublishTime) {
        throw new Error('Refreshed Pyth payload predates the reviewed freshness floor')
      }
    }
    const payloads = decodePayloads(item.data)
    return {
      slotId: slot.slotId,
      target: getAddress(item.targetContract),
      onBehalfOfAccount: getAddress(item.onBehalfOfAccount),
      data: item.data,
      value: item.value,
      payloadHash: canonicalDigest('pyth-preview-payload-v1', toCanonicalValue(payloads)),
      publishTimes: [...currentEvidence.publishTimes],
    }
  })
}
