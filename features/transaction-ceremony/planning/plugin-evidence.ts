import { decodeFunctionData, getAddress, toFunctionSelector, type Address, type Hex } from 'viem'
import { flattenBatchEntries, type PluginPrefetchData, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { PYTH_ABI } from '~/abis/pyth'
import { canonicalDigest, toCanonicalValue, type CanonicalValue } from '../domain/canonical'
import type { PythPreviewEvidence } from '../materialization/prepared-plan'
import { PYTH_FRESHNESS_POLICY, PYTH_MAX_UPDATE_FEE } from './plugin-config'

const PYTH_SELECTOR = toFunctionSelector('updatePriceFeeds(bytes[])')

interface SerializedKeyringPrefetch {
  targetAddresses?: readonly Address[]
  gatedVaults: readonly [Address, CanonicalValue | null][]
}

interface PythPrefetchEntryWithEvidence {
  pythAddress: Address
  feedIds: Hex[]
  updates: Hex[]
  fee: bigint
  /** Required by the reviewed SDK release prerequisite. */
  publishTimes?: number[]
}

/** Canonical codec for SDK plugin prefetch payloads containing Map/Set values. */
export const serializePluginPrefetch = (prefetch: PluginPrefetchData): CanonicalValue => {
  const result: Record<string, CanonicalValue> = {}
  for (const [name, value] of Object.entries(prefetch)) {
    if (name === 'keyring' && value && typeof value === 'object') {
      const keyring = value as {
        targetAddresses?: Set<Address>
        gatedVaults?: Map<Address, unknown>
      }
      const serialized: SerializedKeyringPrefetch = {
        ...(keyring.targetAddresses ? { targetAddresses: [...keyring.targetAddresses].map(getAddress).sort() } : {}),
        gatedVaults: [...(keyring.gatedVaults ?? new Map())].map(([address, entry]) => [getAddress(address), entry === null ? null : toCanonicalValue(entry)]),
      }
      result[name] = toCanonicalValue(serialized)
      continue
    }
    result[name] = toCanonicalValue(value)
  }
  return result
}

export const rehydratePluginPrefetch = (prefetch: CanonicalValue): PluginPrefetchData => {
  if (!prefetch || typeof prefetch !== 'object' || Array.isArray(prefetch)) throw new Error('Plugin prefetch envelope is malformed')
  const result: PluginPrefetchData = {}
  for (const [name, value] of Object.entries(prefetch)) {
    if (name === 'keyring') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Keyring prefetch data is malformed')
      const keyring = value as unknown as SerializedKeyringPrefetch
      result.keyring = {
        ...(keyring.targetAddresses ? { targetAddresses: new Set(keyring.targetAddresses.map(getAddress)) } : {}),
        gatedVaults: new Map(keyring.gatedVaults.map(([address, entry]) => [getAddress(address), entry as never])),
      }
      continue
    }
    result[name] = value
  }
  return result
}

const pythPayloads = (data: Hex): readonly Hex[] => {
  const decoded = decodeFunctionData({ abi: PYTH_ABI, data })
  if (decoded.functionName !== 'updatePriceFeeds') throw new Error('Pyth preview calldata is malformed')
  return decoded.args[0]
}

const samePayloads = (left: readonly Hex[], right: readonly Hex[]) =>
  canonicalDigest('pyth-payloads-v1', toCanonicalValue(left)) === canonicalDigest('pyth-payloads-v1', toCanonicalValue(right))

/**
 * Bind each SDK-produced Pyth call to the feed and publish-time evidence from
 * the same prefetched plugin result. Missing publish times fail closed until
 * the documented SDK prerequisite is installed.
 */
export const collectPythPreviewEvidence = (
  plan: TransactionPlan,
  prefetched: CanonicalValue,
): readonly PythPreviewEvidence[] => {
  const hydrated = rehydratePluginPrefetch(prefetched)
  const entries = (hydrated.pyth?.entries ?? []) as PythPrefetchEntryWithEvidence[]
  const output: PythPreviewEvidence[] = []
  const usedEntries = new Set<number>()
  for (const [planItemIndex, item] of plan.entries()) {
    if (item.type !== 'evcBatch') continue
    for (const [batchItemIndex, batchItem] of flattenBatchEntries(item.items).entries()) {
      if (batchItem.data.slice(0, 10).toLowerCase() !== PYTH_SELECTOR.toLowerCase()) continue
      const payloads = pythPayloads(batchItem.data)
      const entryIndex = entries.findIndex((candidate, index) =>
        !usedEntries.has(index)
        && getAddress(candidate.pythAddress) === getAddress(batchItem.targetContract)
        && samePayloads(candidate.updates, payloads),
      )
      const entry = entries[entryIndex]
      if (!entry) throw new Error('Pyth preview call has no matching SDK prefetch evidence')
      usedEntries.add(entryIndex)
      if (!entry.publishTimes?.length || entry.publishTimes.length !== entry.feedIds.length) {
        throw new Error('The installed SDK does not expose required Pyth publish-time evidence')
      }
      if (batchItem.value !== entry.fee || entry.fee > PYTH_MAX_UPDATE_FEE) throw new Error('Pyth preview fee is outside the configured bound')
      output.push({
        planItemIndex,
        batchItemIndex,
        target: getAddress(entry.pythAddress),
        requiredFeedIds: [...entry.feedIds].sort(),
        publishTimes: [...entry.publishTimes],
        maxValue: PYTH_MAX_UPDATE_FEE,
        freshnessPolicy: { maximumAgeSeconds: PYTH_FRESHNESS_POLICY.maximumAgeSeconds },
      })
    }
  }
  if (output.length !== entries.length || usedEntries.size !== entries.length) throw new Error('SDK Pyth evidence does not map one-to-one to the final plan')
  return output
}
