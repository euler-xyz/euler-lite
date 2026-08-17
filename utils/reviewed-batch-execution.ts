import { isEVCBatchOperation, type EVCBatchItem, type TransactionPlan, type TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { decodeFunctionData, encodeFunctionData, isHex, parseAbi, zeroHash, type Address, type Hex } from 'viem'
import { PYTH_ABI } from '~/abis/pyth'

export const REVIEWED_BATCH_EXECUTION_CHANGED_ERROR
  = 'The batch changed after review. Close this review and review the final transaction again.'

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
const MAX_PYTH_UPDATE_FEE = 10n ** 16n

const MIGRATION_AUTHORIZATION_ABI = parseAbi([
  'function delegationWithSig(address delegator,address delegatee,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
  'function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
  'function setAuthorizationWithSig((address authorizer,address authorized,bool isAuthorized,uint256 nonce,uint256 deadline) authorization,(uint8 v,bytes32 r,bytes32 s) signature)',
])

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

const canonicalizePythUpdate = (
  item: Record<string, unknown>,
  chainId: number,
): Record<string, unknown> => {
  const trustedTarget = OFFICIAL_PYTH_ADDRESSES_BY_CHAIN_ID.get(chainId)
  if (
    !trustedTarget
    || typeof item.targetContract !== 'string'
    || item.targetContract.toLowerCase() !== trustedTarget.toLowerCase()
    || typeof item.value !== 'bigint'
    || item.value < 0n
    || item.value > MAX_PYTH_UPDATE_FEE
    || decodeCanonicalPythUpdate(item.data) === undefined
  ) return item
  return { ...item, data: '__fresh_pyth_update__', value: '__fresh_pyth_fee__' }
}

type DecodedMigrationAuthorization = {
  functionName: 'delegationWithSig' | 'permit' | 'setAuthorizationWithSig'
  args: readonly unknown[]
}

const decodeCanonicalMigrationAuthorization = (
  data: unknown,
): DecodedMigrationAuthorization | undefined => {
  if (typeof data !== 'string' || !isHex(data)) return undefined
  try {
    const decoded = decodeFunctionData({ abi: MIGRATION_AUTHORIZATION_ABI, data })
    const canonical = encodeFunctionData({
      abi: MIGRATION_AUTHORIZATION_ABI,
      functionName: decoded.functionName,
      args: decoded.args as never,
    })
    if (canonical.toLowerCase() !== data.toLowerCase()) return undefined
    return {
      functionName: decoded.functionName,
      args: decoded.args as readonly unknown[],
    }
  }
  catch {
    return undefined
  }
}

const isPlaceholderV = (value: unknown): boolean => value === 0 || value === 27

const hasPlaceholderSignature = (decoded: DecodedMigrationAuthorization): boolean => {
  if (decoded.functionName === 'setAuthorizationWithSig') {
    const signature = decoded.args[1] as { v?: unknown, r?: unknown, s?: unknown } | undefined
    return isPlaceholderV(signature?.v) && signature?.r === zeroHash && signature.s === zeroHash
  }
  return isPlaceholderV(decoded.args[4]) && decoded.args[5] === zeroHash && decoded.args[6] === zeroHash
}

const replaceCandidateSignatureWithReviewed = (
  reviewedData: unknown,
  candidateData: unknown,
): Hex | undefined => {
  const reviewed = decodeCanonicalMigrationAuthorization(reviewedData)
  const candidate = decodeCanonicalMigrationAuthorization(candidateData)
  if (
    !reviewed
    || !candidate
    || reviewed.functionName !== candidate.functionName
    || !hasPlaceholderSignature(reviewed)
  ) return undefined

  const args = candidate.functionName === 'setAuthorizationWithSig'
    ? [candidate.args[0], reviewed.args[1]]
    : [...candidate.args.slice(0, 4), ...reviewed.args.slice(4, 7)]
  return encodeFunctionData({
    abi: MIGRATION_AUTHORIZATION_ABI,
    functionName: candidate.functionName,
    args: args as never,
  })
}

const canonicalizePlans = (
  reviewed: TransactionPlanPrepared,
  candidate: TransactionPlanPrepared,
  placeholderSignatureCalls: readonly ReviewedSignaturePlaceholderCall[],
): [TransactionPlan, TransactionPlan] => {
  const allowedSignatureCalls = new Set(placeholderSignatureCalls.map(signatureCallKey))
  const reviewedPlan = reviewed.plan.map((item) => {
    if (item.type !== 'evcBatch') return item
    return {
      ...item,
      items: item.items.map((entry) => {
        const calls = (isEVCBatchOperation(entry) ? entry.items : [entry]).map((call) => {
          return canonicalizePythUpdate(call, reviewed.chainId)
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
        const reviewedCalls = reviewedEntry && isEVCBatchOperation(reviewedEntry)
          ? reviewedEntry.items
          : reviewedEntry ? [reviewedEntry] : []
        const calls = candidateCalls.map((call, callIndex) => {
          const canonical = canonicalizePythUpdate(call, candidate.chainId)
          const reviewedCall = reviewedCalls[callIndex] as Record<string, unknown> | undefined
          if (
            !reviewedCall
            || !allowedSignatureCalls.has(signatureCallKey(reviewedCall as ReviewedSignaturePlaceholderCall))
          ) return canonical
          const data = replaceCandidateSignatureWithReviewed(reviewedCall.data, canonical.data)
          return data ? { ...canonical, data } : canonical
        })
        return isEVCBatchOperation(entry) ? { ...entry, items: calls } : calls[0]
      }),
    }
  })

  return [reviewedPlan as TransactionPlan, candidatePlan as TransactionPlan]
}

const stringifyPrepared = (prepared: TransactionPlanPrepared, plan: TransactionPlan) => JSON.stringify({
  chainId: prepared.chainId,
  account: (typeof prepared.account === 'string' ? prepared.account : prepared.account.owner).toLowerCase(),
  usePermit2: prepared.usePermit2,
  unlimitedApproval: prepared.unlimitedApproval,
  plan,
}, (_key, value) => typeof value === 'bigint' ? `${value.toString()}n` : value)

/**
 * Require the final execution envelope to match the prepared review. Only a
 * fresh Pyth payload/fee and explicitly flagged, exact migration authorization
 * signature tuples may differ.
 */
export const requireReviewedBatchPreparedExecution = (
  reviewed: TransactionPlanPrepared,
  candidate: TransactionPlanPrepared,
  options: { placeholderSignatureCalls?: readonly ReviewedSignaturePlaceholderCall[] } = {},
): TransactionPlanPrepared => {
  if (reviewed === candidate) return candidate
  const [reviewedPlan, candidatePlan] = canonicalizePlans(
    reviewed,
    candidate,
    options.placeholderSignatureCalls ?? [],
  )
  if (stringifyPrepared(reviewed, reviewedPlan) !== stringifyPrepared(candidate, candidatePlan)) {
    throw new Error(REVIEWED_BATCH_EXECUTION_CHANGED_ERROR)
  }
  return candidate
}
