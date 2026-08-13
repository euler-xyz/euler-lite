import { flattenBatchEntries, isEVCBatchOperation, type EVCBatchItem, type MigrationAuthorizationRequest, type TransactionPlan, type TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { decodeFunctionData, encodeFunctionData, getAddress, isHex, parseAbi, zeroHash, type Address, type Hex } from 'viem'
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

const MIGRATION_AUTHORIZATION_ABI = parseAbi([
  'function delegationWithSig(address delegator,address delegatee,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
  'function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
  'function setAuthorizationWithSig((address authorizer,address authorized,bool isAuthorized,uint256 nonce,uint256 deadline) authorization,(uint8 v,bytes32 r,bytes32 s) signature)',
])

export type ReviewedSignaturePlaceholderKind
  = 'aave-delegation' | 'erc2612-permit' | 'morpho-authorization'

export type ReviewedSignaturePlaceholderCall = Pick<
  EVCBatchItem,
  'targetContract' | 'onBehalfOfAccount' | 'value' | 'data'
> & { signatureKind: ReviewedSignaturePlaceholderKind }

type ReviewedSignaturePlaceholderSlot = {
  targetContract: Address
  data: Hex
  signatureKind: ReviewedSignaturePlaceholderKind
}

const signatureCallKey = (call: ReviewedSignaturePlaceholderCall): string => [
  call.targetContract.toLowerCase(),
  call.onBehalfOfAccount.toLowerCase(),
  call.value.toString(),
  call.data.toLowerCase(),
].join(':')

type DecodedMigrationAuthorization = {
  kind: ReviewedSignaturePlaceholderKind
  functionName: 'delegationWithSig' | 'permit' | 'setAuthorizationWithSig'
  args: readonly unknown[]
}

const decodeCanonicalMigrationAuthorization = (data: unknown): DecodedMigrationAuthorization | undefined => {
  if (typeof data !== 'string' || !isHex(data)) return undefined
  try {
    const decoded = decodeFunctionData({ abi: MIGRATION_AUTHORIZATION_ABI, data })
    const functionName = decoded.functionName
    const kind: ReviewedSignaturePlaceholderKind = functionName === 'delegationWithSig'
      ? 'aave-delegation'
      : functionName === 'permit'
        ? 'erc2612-permit'
        : 'morpho-authorization'
    const canonical = encodeFunctionData({
      abi: MIGRATION_AUTHORIZATION_ABI,
      functionName,
      args: decoded.args as never,
    })
    if (canonical.toLowerCase() !== data.toLowerCase()) return undefined
    return { kind, functionName, args: decoded.args as readonly unknown[] }
  }
  catch {
    return undefined
  }
}

const isZeroPlaceholderSignature = (decoded: DecodedMigrationAuthorization): boolean => {
  if (decoded.kind === 'morpho-authorization') {
    const signature = decoded.args[1] as { v?: unknown, r?: unknown, s?: unknown } | undefined
    return signature?.v === 0 && signature.r === zeroHash && signature.s === zeroHash
  }
  return decoded.args[4] === 0 && decoded.args[5] === zeroHash && decoded.args[6] === zeroHash
}

export const getReviewedSignaturePlaceholderKind = (
  data: unknown,
): ReviewedSignaturePlaceholderKind | undefined => {
  const decoded = decodeCanonicalMigrationAuthorization(data)
  return decoded && isZeroPlaceholderSignature(decoded) ? decoded.kind : undefined
}

const getReviewedSignaturePlaceholderSlot = (
  request: MigrationAuthorizationRequest,
): ReviewedSignaturePlaceholderSlot | undefined => {
  if (request.kind !== 'typedData') return undefined
  const verifyingContract = request.typedData.domain.verifyingContract
  if (typeof verifyingContract !== 'string') return undefined

  try {
    const message = request.typedData.message as Record<string, unknown>
    const authorizationType = 'authorizationType' in request
      ? request.authorizationType
      : undefined
    let signatureKind: ReviewedSignaturePlaceholderKind
    let data: Hex
    if (request.connectorId === 'aave' && authorizationType === 'variableDebtDelegation') {
      signatureKind = 'aave-delegation'
      data = encodeFunctionData({
        abi: MIGRATION_AUTHORIZATION_ABI,
        functionName: 'delegationWithSig',
        args: [
          request.owner,
          message.delegatee as Address,
          message.value as bigint,
          message.deadline as bigint,
          0,
          zeroHash,
          zeroHash,
        ],
      })
    }
    else if (
      (request.connectorId === 'aave' && authorizationType === 'aTokenPermit')
      || (request.connectorId === 'metamorpho' && authorizationType === 'metamorphoPermit')
    ) {
      signatureKind = 'erc2612-permit'
      data = encodeFunctionData({
        abi: MIGRATION_AUTHORIZATION_ABI,
        functionName: 'permit',
        args: [
          message.owner as Address,
          message.spender as Address,
          message.value as bigint,
          message.deadline as bigint,
          0,
          zeroHash,
          zeroHash,
        ],
      })
    }
    else if (request.connectorId === 'morpho') {
      signatureKind = 'morpho-authorization'
      data = encodeFunctionData({
        abi: MIGRATION_AUTHORIZATION_ABI,
        functionName: 'setAuthorizationWithSig',
        args: [
          {
            authorizer: message.authorizer as Address,
            authorized: message.authorized as Address,
            isAuthorized: message.isAuthorized as boolean,
            nonce: message.nonce as bigint,
            deadline: message.deadline as bigint,
          },
          { v: 0, r: zeroHash, s: zeroHash },
        ],
      })
    }
    else {
      return undefined
    }

    return {
      targetContract: getAddress(verifyingContract),
      data,
      signatureKind,
    }
  }
  catch {
    return undefined
  }
}

const collectReviewedSignaturePlaceholderSlots = (
  request: MigrationAuthorizationRequest | undefined,
): ReviewedSignaturePlaceholderSlot[] => {
  if (!request) return []
  const current = getReviewedSignaturePlaceholderSlot(request)
  return [
    ...(current ? [current] : []),
    ...collectReviewedSignaturePlaceholderSlots(request.postMigrationAuthorization),
  ]
}

export const collectReviewedSignaturePlaceholderCalls = (
  plan: TransactionPlan,
  request: MigrationAuthorizationRequest | undefined,
): ReviewedSignaturePlaceholderCall[] => {
  const slots = collectReviewedSignaturePlaceholderSlots(request)
  if (!slots.length) return []

  const remainingSlots = [...slots]
  return plan.flatMap(item => item.type === 'evcBatch'
    ? flattenBatchEntries(item.items).flatMap((call) => {
        const slotIndex = remainingSlots.findIndex(slot =>
          slot.targetContract.toLowerCase() === call.targetContract.toLowerCase()
          && slot.data.toLowerCase() === call.data.toLowerCase(),
        )
        if (slotIndex < 0) return []
        const [slot] = remainingSlots.splice(slotIndex, 1)
        return slot
          ? [{
              targetContract: call.targetContract,
              onBehalfOfAccount: call.onBehalfOfAccount,
              value: call.value,
              data: call.data,
              signatureKind: slot.signatureKind,
            }]
          : []
      })
    : [])
}

const replaceCandidateSignatureWithReviewed = (
  reviewedData: unknown,
  candidateData: unknown,
  expectedKind: ReviewedSignaturePlaceholderKind,
): Hex | undefined => {
  const reviewed = decodeCanonicalMigrationAuthorization(reviewedData)
  const candidate = decodeCanonicalMigrationAuthorization(candidateData)
  if (
    !reviewed
    || !candidate
    || reviewed.kind !== expectedKind
    || candidate.kind !== expectedKind
    || reviewed.functionName !== candidate.functionName
    || !isZeroPlaceholderSignature(reviewed)
  ) return undefined

  const args = candidate.kind === 'morpho-authorization'
    ? [candidate.args[0], reviewed.args[1]]
    : [...candidate.args.slice(0, 4), ...reviewed.args.slice(4, 7)]
  return encodeFunctionData({
    abi: MIGRATION_AUTHORIZATION_ABI,
    functionName: candidate.functionName,
    args: args as never,
  })
}

const canonicalizePreparedPair = (
  reviewed: TransactionPlanPrepared,
  candidate: TransactionPlanPrepared,
  placeholderSignatureCalls: readonly ReviewedSignaturePlaceholderCall[],
): [string, string] => {
  const allowedSignatureCalls = new Map(
    placeholderSignatureCalls.map(call => [signatureCallKey(call), call.signatureKind]),
  )
  const reviewedPlan = reviewed.plan.map((item) => {
    if (item.type !== 'evcBatch') return item
    return {
      ...item,
      items: item.items.map((entry) => {
        const reviewedCalls = isEVCBatchOperation(entry) ? entry.items : [entry]
        const calls = reviewedCalls.map(call => canonicalizePythUpdate(call, reviewed.chainId))
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
          if (!reviewedCall) return canonical
          const signatureKind = allowedSignatureCalls.get(
            signatureCallKey(reviewedCall as ReviewedSignaturePlaceholderCall),
          )
          if (!signatureKind) return canonical
          const data = replaceCandidateSignatureWithReviewed(
            reviewedCall.data,
            canonical.data,
            signatureKind,
          )
          return data ? { ...canonical, data } : canonical
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

export const REVIEWED_PREREQUISITES_CHANGED_ERROR
  = 'The prerequisite transactions changed after review. Close this review and try again.'

export interface ReviewedPrerequisiteEnvelope {
  preTxs: readonly { to: Address, data: Hex, value?: bigint }[]
  postTxs?: readonly { to: Address, data: Hex, value?: bigint }[]
  walletContext: { account: Address, chainId: number }
}

const prerequisiteTxKey = (tx: ReviewedPrerequisiteEnvelope['preTxs'][number]): string => [
  tx.to.toLowerCase(),
  tx.data.toLowerCase(),
  tx.value?.toString() ?? '0',
].join(':')

/** Bind prerequisite writes to the exact reviewed account, chain, targets,
 * calldata, native values, and order. Batch execution may omit a reviewed
 * duplicate after an earlier entry has already satisfied the same grant. */
export const requireReviewedPrerequisiteEnvelope = (
  reviewed: ReviewedPrerequisiteEnvelope | undefined,
  candidate: ReviewedPrerequisiteEnvelope | undefined,
  options: { allowOmissions?: boolean } = {},
): ReviewedPrerequisiteEnvelope | undefined => {
  const candidateTxs = candidate?.preTxs ?? []
  if (!candidateTxs.length) return candidate
  if (!reviewed) throw new Error(REVIEWED_PREREQUISITES_CHANGED_ERROR)
  if (
    reviewed.walletContext.chainId !== candidate!.walletContext.chainId
    || reviewed.walletContext.account.toLowerCase() !== candidate!.walletContext.account.toLowerCase()
  ) throw new Error(REVIEWED_PREREQUISITES_CHANGED_ERROR)

  const reviewedKeys = reviewed.preTxs.map(prerequisiteTxKey)
  const candidateKeys = candidateTxs.map(prerequisiteTxKey)
  const reviewedPostKeys = (reviewed.postTxs ?? []).map(prerequisiteTxKey)
  const candidatePostKeys = (candidate?.postTxs ?? []).map(prerequisiteTxKey)
  if (JSON.stringify(reviewedPostKeys) !== JSON.stringify(candidatePostKeys)) {
    throw new Error(REVIEWED_PREREQUISITES_CHANGED_ERROR)
  }
  if (!options.allowOmissions) {
    if (JSON.stringify(reviewedKeys) !== JSON.stringify(candidateKeys)) {
      throw new Error(REVIEWED_PREREQUISITES_CHANGED_ERROR)
    }
    return candidate
  }

  let reviewedIndex = 0
  for (const key of candidateKeys) {
    reviewedIndex = reviewedKeys.indexOf(key, reviewedIndex)
    if (reviewedIndex < 0) throw new Error(REVIEWED_PREREQUISITES_CHANGED_ERROR)
    reviewedIndex += 1
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
