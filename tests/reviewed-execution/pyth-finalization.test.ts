import { encodeFunctionData, getAddress, keccak256, toHex, type Hex } from 'viem'
import type { EVCBatchItem, TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { describe, expect, it } from 'vitest'
import { EVC_ABI } from '~/abis/evc'
import { PYTH_ABI } from '~/abis/pyth'
import type { OperationIntent } from '~/features/reviewed-execution/domain/intents'
import type { WalletBinding } from '~/features/reviewed-execution/domain/reviewed-execution'
import { assertFinalizedRequestsMatch, finalizeReviewedRequestSet } from '~/features/reviewed-execution/materialization/finalize'
import { reviewedRequestDigest, materializePreparedPlan } from '~/features/reviewed-execution/materialization/prepared-plan'
import { verifyRefreshedPluginPlan } from '~/features/reviewed-execution/materialization/pyth-refresh'

const ACCOUNT = getAddress('0x1000000000000000000000000000000000000000')
const VAULT = getAddress('0x2000000000000000000000000000000000000000')
const EVC = getAddress('0x3000000000000000000000000000000000000000')
const PYTH = getAddress('0x4000000000000000000000000000000000000000')
const TOKEN = getAddress('0x5000000000000000000000000000000000000000')
const SPENDER = getAddress('0x6000000000000000000000000000000000000000')
const POLICY = keccak256(toHex('policy'))
const FEED = keccak256(toHex('feed'))

const intent: OperationIntent = {
  schemaVersion: 1,
  intentId: 'intent-1',
  revision: 1,
  kind: 'borrow',
  chainId: 1,
  account: ACCOUNT,
  subAccounts: [ACCOUNT],
  planner: { name: 'borrow', args: { vaultAddress: VAULT, assetAddress: TOKEN, amount: 1n, borrowAccount: ACCOUNT } },
  constraints: [{ kind: 'maximum-input', token: TOKEN, amount: 1n }],
  metadata: { createdAt: 1, source: 'test' },
}

const wallet: WalletBinding = {
  chainId: 1,
  account: ACCOUNT,
  subAccounts: [ACCOUNT],
  connectorId: 'injected',
  connectorSessionId: 'session-1',
  walletKind: 'eoa',
  classificationVersion: 'classification-1',
  approvalMode: 'approve',
}

const encodeBatch = (items: EVCBatchItem[]) => encodeFunctionData({ abi: EVC_ABI, functionName: 'batch', args: [items] })
const sdk = {
  deploymentService: { getDeployment: () => ({ addresses: { coreAddrs: { evc: EVC } } }) },
  executionService: {
    encodeBatch,
    encodePermit2Call: () => { throw new Error('unused') },
  },
}

const pythItem = (updates: readonly Hex[], value: bigint, target = PYTH): EVCBatchItem => ({
  targetContract: target,
  onBehalfOfAccount: ACCOUNT,
  value,
  data: encodeFunctionData({ abi: PYTH_ABI, functionName: 'updatePriceFeeds', args: [updates] }),
})

const coreItem = (data: Hex = '0x12345678'): EVCBatchItem => ({
  targetContract: VAULT,
  onBehalfOfAccount: ACCOUNT,
  value: 0n,
  data,
})

const previewCache = {
  planItemIndex: 0,
  batchItemIndex: 0,
  target: PYTH,
  requiredFeedIds: [FEED],
  publishTimes: [990],
  maxValue: 10n,
  freshnessPolicy: { maximumAgeSeconds: 60, minimumPublishTime: 980 },
} as const

const build = () => {
  const preview: TransactionPlan = [{ type: 'evcBatch', items: [pythItem(['0x0102'], 2n), coreItem()] }]
  const requestSet = materializePreparedPlan({ intents: [intent], plan: preview, wallet, sdk, pythPreviewData: [previewCache], policyDigest: POLICY })
  return { preview, requestSet }
}

describe('bounded Pyth refresh', () => {
  it('accepts only a fresh payload and bounded fee, then finalizes that slot', () => {
    const { preview, requestSet } = build()
    const refreshed: TransactionPlan = [{ type: 'evcBatch', items: [pythItem(['0xaabb'], 4n), coreItem()] }]
    const values = verifyRefreshedPluginPlan({
      sealedPreview: preview,
      refreshed,
      slots: requestSet.pythRefreshSlots,
      evidence: [{ ...previewCache, publishTimes: [999] }],
      nowSeconds: 1000,
    })

    const artifact = finalizeReviewedRequestSet({
      reviewId: keccak256(toHex('execution')),
      requestDigest: reviewedRequestDigest(requestSet),
      requestSet,
      sdk,
      signatures: [],
      pythValues: values,
    })

    expect(artifact.pythValues).toEqual([{ slotId: requestSet.pythRefreshSlots[0].slotId, payloadHash: values[0].payloadHash, value: 4n }])
    expect(artifact.requests[0].data).not.toBe(requestSet.requests[0].data)
    expect(() => assertFinalizedRequestsMatch(requestSet, artifact.requests, sdk, { signatures: [], pythValues: values })).not.toThrow()
  })

  it('rejects static plugin/core changes and undeclared Pyth effects', () => {
    const { preview, requestSet } = build()
    const changedCore: TransactionPlan = [{ type: 'evcBatch', items: [pythItem(['0xaabb'], 4n), coreItem('0x87654321')] }]
    expect(() => verifyRefreshedPluginPlan({ sealedPreview: preview, refreshed: changedCore, slots: requestSet.pythRefreshSlots, evidence: [{ ...previewCache, publishTimes: [999] }], nowSeconds: 1000 }))
      .toThrow(/static plan structure/)

    const extraPyth: TransactionPlan = [{ type: 'evcBatch', items: [pythItem(['0xaabb'], 4n), pythItem(['0xccdd'], 1n), coreItem()] }]
    expect(() => verifyRefreshedPluginPlan({ sealedPreview: preview, refreshed: extraPyth, slots: requestSet.pythRefreshSlots, evidence: [{ ...previewCache, publishTimes: [999] }], nowSeconds: 1000 }))
      .toThrow()
  })

  it('compares plugin structure before approval resolution without adopting refreshed approvals', () => {
    const sealedApproval = {
      type: 'requiredApproval' as const,
      token: TOKEN,
      owner: ACCOUNT,
      spender: SPENDER,
      amount: 1n,
      resolved: [{ type: 'approve' as const, token: TOKEN, owner: ACCOUNT, spender: SPENDER, amount: 1n, data: '0x095ea7b3' as Hex }],
    }
    const unresolvedApproval: TransactionPlan[number] = {
      type: 'requiredApproval', token: TOKEN, owner: ACCOUNT, spender: SPENDER, amount: 1n,
    }
    const shiftedEvidence = { ...previewCache, planItemIndex: 1 }
    const sealedPreview: TransactionPlan = [sealedApproval, { type: 'evcBatch', items: [pythItem(['0x0102'], 2n), coreItem()] }]
    const requestSet = materializePreparedPlan({ intents: [intent], plan: sealedPreview, wallet, sdk, pythPreviewData: [shiftedEvidence], policyDigest: POLICY })
    const refreshed: TransactionPlan = [unresolvedApproval, { type: 'evcBatch', items: [pythItem(['0xaabb'], 4n), coreItem()] }]

    expect(() => verifyRefreshedPluginPlan({
      sealedPreview,
      refreshed,
      slots: requestSet.pythRefreshSlots,
      evidence: [{ ...shiftedEvidence, publishTimes: [999] }],
      nowSeconds: 1000,
    })).not.toThrow()
    expect(() => verifyRefreshedPluginPlan({
      sealedPreview,
      refreshed: [sealedApproval, refreshed[1]!],
      slots: requestSet.pythRefreshSlots,
      evidence: [{ ...shiftedEvidence, publishTimes: [999] }],
      nowSeconds: 1000,
    })).toThrow(/unexpectedly resolved/)
  })

  it('rejects target, feed-set, fee, and freshness drift', () => {
    const { preview, requestSet } = build()
    const validEvidence = [{ ...previewCache, publishTimes: [999] }]

    const wrongTarget: TransactionPlan = [{ type: 'evcBatch', items: [pythItem(['0xaabb'], 4n, VAULT), coreItem()] }]
    expect(() => verifyRefreshedPluginPlan({ sealedPreview: preview, refreshed: wrongTarget, slots: requestSet.pythRefreshSlots, evidence: validEvidence, nowSeconds: 1000 })).toThrow()

    const validPlan: TransactionPlan = [{ type: 'evcBatch', items: [pythItem(['0xaabb'], 4n), coreItem()] }]
    expect(() => verifyRefreshedPluginPlan({
      sealedPreview: preview,
      refreshed: validPlan,
      slots: requestSet.pythRefreshSlots,
      evidence: [...validEvidence, ...validEvidence],
      nowSeconds: 1000,
    })).toThrow(/one-to-one/)
    expect(() => verifyRefreshedPluginPlan({ sealedPreview: preview, refreshed: validPlan, slots: requestSet.pythRefreshSlots, evidence: [{ ...previewCache, requiredFeedIds: [keccak256(toHex('other'))], publishTimes: [999] }], nowSeconds: 1000 })).toThrow(/feed set/)

    const expensive: TransactionPlan = [{ type: 'evcBatch', items: [pythItem(['0xaabb'], 11n), coreItem()] }]
    expect(() => verifyRefreshedPluginPlan({ sealedPreview: preview, refreshed: expensive, slots: requestSet.pythRefreshSlots, evidence: validEvidence, nowSeconds: 1000 })).toThrow(/fee/)

    expect(() => verifyRefreshedPluginPlan({ sealedPreview: preview, refreshed: validPlan, slots: requestSet.pythRefreshSlots, evidence: [{ ...previewCache, publishTimes: [900] }], nowSeconds: 1000 })).toThrow(/stale|freshness floor/)
  })

  it('detects post-finalization tampering outside the slot', () => {
    const { requestSet } = build()
    const tampered = requestSet.requests.map(request => ({ ...request, to: VAULT }))
    expect(() => assertFinalizedRequestsMatch(requestSet, tampered, sdk)).toThrow(/to changed/)
  })
})
