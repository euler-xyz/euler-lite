import { flattenBatchEntries, isEVCBatchOperation, type EVCBatchItem, type TransactionPlan, type TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { decodeFunctionData, encodeFunctionData, isHex, type Address, type Hex } from 'viem'
import { PYTH_ABI } from '~/abis/pyth'

export const REVIEWED_EXECUTION_UNAVAILABLE_ERROR
  = 'The reviewed transaction is unavailable. Close this review and try again.'

export const REVIEWED_EXECUTION_CHANGED_ERROR
  = 'The transaction changed while it was being refreshed. Close this review and try again.'

export const REVIEWED_BATCH_EXECUTION_CHANGED_ERROR
  = 'The batch changed after review. Close this review and review the final transaction again.'

// Mirrors the official allowlist used by the SDK's Pyth plugin. Lite does not
// configure additional Pyth contracts, so a selector match outside this
// chain-specific set must remain byte-for-byte reviewed.
const OFFICIAL_PYTH_ADDRESSES_BY_CHAIN_ID = new Map<number, Address>([
  [1, '0x4305FB66699C3B2702D4d05CF36551390A4c69C6'],
  [10, '0xff1a0f4744e8582DF1aE09D5611b887B6a12925C'],
  [56, '0x4D7E825f80bDf85e913E0DD2A2D54927e9dE1594'],
  [100, '0x2880aB155794e7179c9eE2e38200202908C17B43'],
  [130, '0x2880aB155794e7179c9eE2e38200202908C17B43'],
  [137, '0xff1a0f4744e8582DF1aE09D5611b887B6a12925C'],
  [143, '0x2880aB155794e7179c9eE2e38200202908C17B43'],
  [146, '0x2880aB155794e7179c9eE2e38200202908C17B43'],
  [169, '0xA2aa501b19aff244D90cc15a4Cf739D2725B5729'],
  [204, '0x2880aB155794e7179c9eE2e38200202908C17B43'],
  [252, '0xA2aa501b19aff244D90cc15a4Cf739D2725B5729'],
  [324, '0xf087c864AEccFb6A2Bf1Af6A0382B0d0f6c5D834'],
  [480, '0xe9d69cdd6fe41e7b621b4a688c5d1a68cb5c8adc'],
  [747, '0x2880aB155794e7179c9eE2e38200202908C17B43'],
  [999, '0xe9d69CdD6Fe41e7B621B4A688C5D1a68cB5c8ADc'],
  [1030, '0xe9d69CdD6Fe41e7B621B4A688C5D1a68cB5c8ADc'],
  [1116, '0xA2aa501b19aff244D90cc15a4Cf739D2725B5729'],
  [1329, '0x2880aB155794e7179c9eE2e38200202908C17B43'],
  [1868, '0x2880aB155794e7179c9eE2e38200202908C17B43'],
  [1923, '0xDd24F84d36BF92C65F92307595335bdFab5Bbd21'],
  [2020, '0x2880aB155794e7179c9eE2e38200202908C17B43'],
  [2741, '0x8739d5024B5143278E2b15Bd9e7C26f6CEc658F1'],
  [16661, '0x2880ab155794e7179c9ee2e38200202908c17b43'],
  [31612, '0x2880aB155794e7179c9eE2e38200202908C17B43'],
  [34443, '0xA2aa501b19aff244D90cc15a4Cf739D2725B5729'],
  [42161, '0xff1a0f4744e8582DF1aE09D5611b887B6a12925C'],
  [42220, '0xff1a0f4744e8582DF1aE09D5611b887B6a12925C'],
  [42793, '0x2880aB155794e7179c9eE2e38200202908C17B43'],
  [43111, '0x2880aB155794e7179c9eE2e38200202908C17B43'],
  [43114, '0x4305FB66699C3B2702D4d05CF36551390A4c69C6'],
  [57073, '0x2880aB155794e7179c9eE2e38200202908C17B43'],
  [59144, '0xA2aa501b19aff244D90cc15a4Cf739D2725B5729'],
  [80094, '0x2880aB155794e7179c9eE2e38200202908C17B43'],
  [81457, '0xA2aa501b19aff244D90cc15a4Cf739D2725B5729'],
  [167000, '0x2880aB155794e7179c9eE2e38200202908C17B43'],
  [534352, '0xA2aa501b19aff244D90cc15a4Cf739D2725B5729'],
])

// This is the same default supplied to createPythPlugin(). Keeping the bound
// here makes the final reviewed-execution gate fail closed even if a prepared
// artifact is constructed outside that plugin.
const MAX_PYTH_UPDATE_FEE = 10n ** 16n

const decodeCanonicalPythUpdate = (data: unknown): readonly Hex[] | undefined => {
  if (typeof data !== 'string' || !isHex(data)) return undefined
  try {
    const decoded = decodeFunctionData({ abi: PYTH_ABI, data })
    if (decoded.functionName !== 'updatePriceFeeds') return undefined
    const updates = decoded.args[0]
    if (
      !Array.isArray(updates)
      || updates.length === 0
      || updates.some(update => typeof update !== 'string' || !isHex(update) || update === '0x')
    ) return undefined
    const canonical = encodeFunctionData({
      abi: PYTH_ABI,
      functionName: 'updatePriceFeeds',
      args: [updates],
    })
    return canonical.toLowerCase() === data.toLowerCase() ? updates : undefined
  }
  catch {
    return undefined
  }
}

const isPythUpdate = (item: Record<string, unknown>, chainId: number): boolean => {
  const trustedTarget = OFFICIAL_PYTH_ADDRESSES_BY_CHAIN_ID.get(chainId)
  return !!trustedTarget
    && typeof item.targetContract === 'string'
    && item.targetContract.toLowerCase() === trustedTarget.toLowerCase()
    && typeof item.value === 'bigint'
    && item.value >= 0n
    && item.value <= MAX_PYTH_UPDATE_FEE
    && decodeCanonicalPythUpdate(item.data) !== undefined
}

const canonicalizePythUpdate = (item: Record<string, unknown>, chainId: number): Record<string, unknown> => {
  if (!isPythUpdate(item, chainId)) return item
  return {
    ...item,
    data: '__fresh_pyth_update__',
    value: '__fresh_pyth_fee__',
  }
}

const DYNAMIC_SIGNATURE_LENGTH_WORD = `${'0'.repeat(62)}41`
const PLACEHOLDER_SIGNATURE_DATA = '0'.repeat(65 * 2)

export type ReviewedSignaturePlaceholderCall = Pick<
  EVCBatchItem,
  'targetContract' | 'onBehalfOfAccount' | 'value' | 'data'
>

const signatureCallKey = (call: ReviewedSignaturePlaceholderCall): string => [
  call.targetContract.toLowerCase(),
  call.onBehalfOfAccount.toLowerCase(),
  call.value.toString(),
  call.data.toLowerCase(),
].join(':')

const canonicalizeReviewedSignature = (data: string): string => {
  const normalized = data.toLowerCase()
  let searchFrom = 0
  let result = normalized
  while (searchFrom < result.length) {
    const lengthWordIndex = result.indexOf(DYNAMIC_SIGNATURE_LENGTH_WORD, searchFrom)
    if (lengthWordIndex < 0) break
    const signatureStart = lengthWordIndex + DYNAMIC_SIGNATURE_LENGTH_WORD.length
    const signatureEnd = signatureStart + PLACEHOLDER_SIGNATURE_DATA.length
    if (result.slice(signatureStart, signatureEnd) === PLACEHOLDER_SIGNATURE_DATA) {
      result = `${result.slice(0, signatureStart)}__reviewed_signature__${result.slice(signatureEnd)}`
      searchFrom = signatureStart + '__reviewed_signature__'.length
    }
    else {
      searchFrom = signatureStart
    }
  }
  return result
}

const canonicalizeMatchingSignature = (reviewedData: string, candidateData: string): string => {
  const reviewed = reviewedData.toLowerCase()
  let candidate = candidateData.toLowerCase()
  if (reviewed.length !== candidate.length) return candidate
  let searchFrom = 0
  while (searchFrom < reviewed.length) {
    const lengthWordIndex = reviewed.indexOf(DYNAMIC_SIGNATURE_LENGTH_WORD, searchFrom)
    if (lengthWordIndex < 0) break
    const signatureStart = lengthWordIndex + DYNAMIC_SIGNATURE_LENGTH_WORD.length
    const signatureEnd = signatureStart + PLACEHOLDER_SIGNATURE_DATA.length
    if (reviewed.slice(signatureStart, signatureEnd) === PLACEHOLDER_SIGNATURE_DATA) {
      candidate = `${candidate.slice(0, signatureStart)}__reviewed_signature__${candidate.slice(signatureEnd)}`
      searchFrom = signatureEnd
    }
    else {
      searchFrom = signatureStart
    }
  }
  return candidate
}

const canonicalizePreparedPair = (
  reviewed: TransactionPlanPrepared,
  candidate: TransactionPlanPrepared,
  placeholderSignatureCalls: readonly ReviewedSignaturePlaceholderCall[],
): [string, string] => {
  const allowedSignatureCalls = new Set(placeholderSignatureCalls.map(signatureCallKey))
  const reviewedPlan = reviewed.plan.map((item) => {
    if (item.type !== 'evcBatch') return item
    return {
      ...item,
      items: item.items.map((entry) => {
        const reviewedCalls = isEVCBatchOperation(entry) ? entry.items : [entry]
        const calls = reviewedCalls.map((call) => {
          const canonical = canonicalizePythUpdate(call, reviewed.chainId)
          if (!allowedSignatureCalls.has(signatureCallKey(call)) || typeof canonical.data !== 'string') return canonical
          return { ...canonical, data: canonicalizeReviewedSignature(canonical.data) }
        })
        return isEVCBatchOperation(entry) ? { ...entry, items: calls } : calls[0]
      }),
    }
  })
  const candidatePlan = candidate.plan.map((item, itemIndex) => {
    if (item.type !== 'evcBatch') return item
    const reviewedItem = reviewed.plan[itemIndex]
    return {
      ...item,
      items: item.items.map((entry, entryIndex) => {
        const candidateCalls = isEVCBatchOperation(entry) ? entry.items : [entry]
        const reviewedEntry = reviewedItem?.type === 'evcBatch' ? reviewedItem.items[entryIndex] : undefined
        const reviewedCalls = reviewedEntry && isEVCBatchOperation(reviewedEntry) ? reviewedEntry.items : reviewedEntry ? [reviewedEntry] : []
        const calls = candidateCalls.map((call, callIndex) => {
          const canonical = canonicalizePythUpdate(call, candidate.chainId)
          const reviewedCall = reviewedCalls[callIndex] as Record<string, unknown> | undefined
          if (
            !reviewedCall
            || !allowedSignatureCalls.has(signatureCallKey(reviewedCall as ReviewedSignaturePlaceholderCall))
            || typeof canonical.data !== 'string'
            || typeof reviewedCall.data !== 'string'
          ) return canonical
          return { ...canonical, data: canonicalizeMatchingSignature(reviewedCall.data, canonical.data) }
        })
        return isEVCBatchOperation(entry) ? { ...entry, items: calls } : calls[0]
      }),
    }
  })
  const stringify = (prepared: TransactionPlanPrepared, plan: TransactionPlan) => JSON.stringify({
    chainId: prepared.chainId,
    account: (typeof prepared.account === 'string' ? prepared.account : prepared.account.owner).toLowerCase(),
    usePermit2: prepared.usePermit2,
    unlimitedApproval: prepared.unlimitedApproval,
    plan,
  }, (_key, value) => typeof value === 'bigint' ? `${value.toString()}n` : value)
  return [stringify(reviewed, reviewedPlan as TransactionPlan), stringify(candidate, candidatePlan as TransactionPlan)]
}

/**
 * Bind batch execution to the prepared envelope shown in review. Fresh Pyth
 * payloads are allowed, and explicitly reviewed migration placeholder
 * signatures may be replaced at their ABI-encoded bytes slot. Everything else,
 * including approvals, targets, values, and operation calldata, remains exact.
 */
export const requireReviewedBatchPreparedExecution = (
  reviewed: TransactionPlanPrepared,
  candidate: TransactionPlanPrepared,
  options: { placeholderSignatureCalls?: readonly ReviewedSignaturePlaceholderCall[] } = {},
): TransactionPlanPrepared => {
  if (reviewed === candidate) return candidate
  const [reviewedCanonical, candidateCanonical] = canonicalizePreparedPair(
    reviewed,
    candidate,
    options.placeholderSignatureCalls ?? [],
  )
  if (reviewedCanonical !== candidateCanonical) {
    throw new Error(REVIEWED_BATCH_EXECUTION_CHANGED_ERROR)
  }
  return candidate
}

export const hasPreparedPythUpdate = (prepared: TransactionPlanPrepared): boolean =>
  prepared.plan.some(item =>
    item.type === 'evcBatch'
    && flattenBatchEntries(item.items).some(call => isPythUpdate(call, prepared.chainId)),
  )

const canonicalizeReviewedPlan = (prepared: TransactionPlanPrepared): string => JSON.stringify({
  chainId: prepared.chainId,
  account: (typeof prepared.account === 'string' ? prepared.account : prepared.account.owner).toLowerCase(),
  usePermit2: prepared.usePermit2,
  unlimitedApproval: prepared.unlimitedApproval,
  plan: prepared.plan.map((item) => {
    if (item.type !== 'evcBatch') return item
    return {
      ...item,
      items: item.items.map(entry => isEVCBatchOperation(entry)
        ? { ...entry, items: entry.items.map(call => canonicalizePythUpdate(call, prepared.chainId)) }
        : canonicalizePythUpdate(entry, prepared.chainId)),
    }
  }),
}, (_key, value) => typeof value === 'bigint' ? `${value.toString()}n` : value)

/**
 * Permit a just-in-time Pyth payload/fee refresh while requiring every reviewed
 * approval, operation, target and execution option to remain exact.
 */
export const requirePythOnlyPreparedRefresh = (
  reviewed: TransactionPlanPrepared,
  refreshed: TransactionPlanPrepared,
): TransactionPlanPrepared => {
  if (canonicalizeReviewedPlan(reviewed) !== canonicalizeReviewedPlan(refreshed)) {
    throw new Error(REVIEWED_EXECUTION_CHANGED_ERROR)
  }
  return refreshed
}

type PrepareReviewedPlan = (
  plan: TransactionPlan,
  options: Pick<TransactionPlanPrepared, 'account' | 'chainId' | 'usePermit2'>,
) => Promise<TransactionPlanPrepared>

/**
 * Refresh short-lived Pyth payloads at the shared confirmation boundary while
 * pinning preparation to the exact account, chain and Permit2 mode reviewed.
 */
export const refreshReviewedPythExecution = async (
  reviewed: TransactionPlanPrepared,
  rawPlan: TransactionPlan | undefined,
  prepare: PrepareReviewedPlan,
): Promise<TransactionPlanPrepared> => {
  if (!hasPreparedPythUpdate(reviewed)) return reviewed
  if (!rawPlan?.length) throw new Error(REVIEWED_EXECUTION_UNAVAILABLE_ERROR)
  const refreshed = await prepare(rawPlan, {
    account: reviewed.account,
    chainId: reviewed.chainId,
    usePermit2: reviewed.usePermit2,
  })
  return requirePythOnlyPreparedRefresh(reviewed, refreshed)
}

export const requireReviewedExecution = (
  reviewed: TransactionPlanPrepared | undefined,
): TransactionPlanPrepared => {
  if (!reviewed) throw new Error(REVIEWED_EXECUTION_UNAVAILABLE_ERROR)
  return reviewed
}
