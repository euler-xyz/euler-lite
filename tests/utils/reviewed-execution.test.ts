import { describe, expect, it } from 'vitest'
import { flattenBatchEntries, type MigrationAuthorizationRequest, type TransactionPlan, type TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { encodeFunctionData, parseAbi, zeroHash, type Address, type Hex } from 'viem'
import {
  collectReviewedSignaturePlaceholderCalls,
  requirePythOnlyPreparedRefresh,
  requireReviewedBatchPreparedExecution,
  refreshReviewedPythExecution,
  requireReviewedExecution,
  REVIEWED_EXECUTION_CHANGED_ERROR,
  REVIEWED_EXECUTION_UNAVAILABLE_ERROR,
  REVIEWED_BATCH_EXECUTION_CHANGED_ERROR,
  requireReviewedPrerequisiteEnvelope,
  REVIEWED_PREREQUISITES_CHANGED_ERROR,
} from '~/utils/reviewed-execution'

const pyth = '0x4305FB66699C3B2702D4d05CF36551390A4c69C6' as Address
const owner = '0x0000000000000000000000000000000000000002' as Address
const vault = '0x0000000000000000000000000000000000000003' as Address
const nonPyth = '0x0000000000000000000000000000000000000004' as Address
const pythAbi = [{
  type: 'function',
  name: 'updatePriceFeeds',
  inputs: [{ name: 'updateData', type: 'bytes[]' }],
  outputs: [],
  stateMutability: 'payable',
}] as const
const migrationAuthorizationAbi = parseAbi([
  'function delegationWithSig(address delegator,address delegatee,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
  'function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
  'function setAuthorizationWithSig((address authorizer,address authorized,bool isAuthorized,uint256 nonce,uint256 deadline) authorization,(uint8 v,bytes32 r,bytes32 s) signature)',
])

const prepared = (update: Hex, operationData: Hex = '0x12345678'): TransactionPlanPrepared => ({
  __prepared: true,
  chainId: 1,
  account: owner,
  usePermit2: true,
  unlimitedApproval: false,
  plan: [{
    type: 'evcBatch',
    items: [{
      targetContract: pyth,
      onBehalfOfAccount: owner,
      value: 1n,
      data: encodeFunctionData({ abi: pythAbi, functionName: 'updatePriceFeeds', args: [[update]] }),
    }, {
      targetContract: vault,
      onBehalfOfAccount: owner,
      value: 0n,
      data: operationData,
    }],
  }],
})

describe('requireReviewedBatchPreparedExecution', () => {
  const authData = (
    kind: 'delegationWithSig' | 'permit' | 'setAuthorizationWithSig',
    signed: boolean,
  ): Hex => {
    const r = signed ? `0x${'11'.repeat(32)}` as Hex : zeroHash
    const s = signed ? `0x${'22'.repeat(32)}` as Hex : zeroHash
    const v = signed ? 27 : 0
    if (kind === 'setAuthorizationWithSig') {
      return encodeFunctionData({
        abi: migrationAuthorizationAbi,
        functionName: kind,
        args: [
          { authorizer: owner, authorized: vault, isAuthorized: true, nonce: 1n, deadline: 2n },
          { v, r, s },
        ],
      })
    }
    return encodeFunctionData({
      abi: migrationAuthorizationAbi,
      functionName: kind,
      args: [owner, vault, 1n, 2n, v, r, s],
    })
  }

  const authorizationRequest = (
    kind: 'delegationWithSig' | 'permit' | 'setAuthorizationWithSig',
    targetContract: Address = vault,
  ): MigrationAuthorizationRequest => {
    const common = {
      kind: 'typedData' as const,
      chainId: 1,
      owner,
      protocol: kind === 'setAuthorizationWithSig' ? 'Morpho' : 'Aave V3',
      typedData: {
        domain: { chainId: 1, verifyingContract: targetContract },
        types: {},
        primaryType: kind === 'setAuthorizationWithSig' ? 'Authorization' : 'Permit',
        message: kind === 'setAuthorizationWithSig'
          ? { authorizer: owner, authorized: vault, isAuthorized: true, nonce: 1n, deadline: 2n }
          : kind === 'delegationWithSig'
            ? { delegatee: vault, value: 1n, nonce: 0n, deadline: 2n }
            : { owner, spender: vault, value: 1n, nonce: 0n, deadline: 2n },
      },
    }
    if (kind === 'setAuthorizationWithSig') {
      return { ...common, connectorId: 'morpho' }
    }
    return {
      ...common,
      connectorId: 'aave',
      authorizationType: kind === 'delegationWithSig' ? 'variableDebtDelegation' : 'aTokenPermit',
      token: vault,
      ...(kind === 'delegationWithSig' ? { delegator: owner } : {}),
    } as MigrationAuthorizationRequest
  }

  it.each(['delegationWithSig', 'permit', 'setAuthorizationWithSig'] as const)(
    'accepts only the decoded %s signature fields',
    (kind) => {
      const reviewed = prepared('0x01', authData(kind, false))
      const signed = prepared('0x01', authData(kind, true))

      expect(requireReviewedBatchPreparedExecution(reviewed, signed, {
        placeholderSignatureCalls: collectReviewedSignaturePlaceholderCalls(
          reviewed.plan,
          authorizationRequest(kind),
        ),
      })).toBe(signed)
    },
  )

  it('does not treat a zero-rs call with a non-placeholder recovery id as reviewed', () => {
    const reviewed = prepared('0x01', encodeFunctionData({
      abi: migrationAuthorizationAbi,
      functionName: 'permit',
      args: [owner, vault, 1n, 2n, 27, zeroHash, zeroHash],
    }))

    expect(collectReviewedSignaturePlaceholderCalls(reviewed.plan, authorizationRequest('permit'))).toEqual([])
  })

  it('rejects an approval inserted after review', () => {
    const reviewed = prepared('0x01')
    const candidate = prepared('0x01')
    candidate.plan.unshift({
      type: 'requiredApproval',
      token: vault,
      owner,
      spender: vault,
      amount: 1n,
      resolved: [],
    })

    expect(() => requireReviewedBatchPreparedExecution(reviewed, candidate))
      .toThrow(REVIEWED_BATCH_EXECUTION_CHANGED_ERROR)
  })

  it('rejects a changed operation outside the signature slot', () => {
    const reviewed = prepared('0x01', authData('delegationWithSig', false))
    const changed = prepared('0x01', authData('delegationWithSig', true))
    const batch = changed.plan[0]
    if (batch?.type === 'evcBatch') {
      const call = flattenBatchEntries(batch.items)[1]
      if (call) call.targetContract = pyth
    }

    expect(() => requireReviewedBatchPreparedExecution(reviewed, changed, {
      placeholderSignatureCalls: collectReviewedSignaturePlaceholderCalls(
        reviewed.plan,
        authorizationRequest('delegationWithSig'),
      ),
    })).toThrow(REVIEWED_BATCH_EXECUTION_CHANGED_ERROR)
  })

  it('rejects an unrelated dynamic 65-byte field even when the entry is flagged', () => {
    const dynamicField = (bytes: string): Hex =>
      `0x12345678${'0'.repeat(62)}41${bytes}${'0'.repeat(62)}` as Hex
    const reviewed = prepared('0x01', dynamicField('0'.repeat(65 * 2)))
    const changed = prepared('0x01', dynamicField('11'.repeat(65)))

    expect(collectReviewedSignaturePlaceholderCalls(reviewed.plan, authorizationRequest('permit'))).toEqual([])
    expect(() => requireReviewedBatchPreparedExecution(reviewed, changed, {
      placeholderSignatureCalls: collectReviewedSignaturePlaceholderCalls(
        reviewed.plan,
        authorizationRequest('permit'),
      ),
    })).toThrow(REVIEWED_BATCH_EXECUTION_CHANGED_ERROR)
  })

  it('rejects a supported authorization selector on a target not named by its connector request', () => {
    const reviewed = prepared('0x01', authData('permit', false))
    const changed = prepared('0x01', authData('permit', true))
    const calls = collectReviewedSignaturePlaceholderCalls(
      reviewed.plan,
      authorizationRequest('permit', nonPyth),
    )

    expect(calls).toEqual([])
    expect(() => requireReviewedBatchPreparedExecution(reviewed, changed, {
      placeholderSignatureCalls: calls,
    })).toThrow(REVIEWED_BATCH_EXECUTION_CHANGED_ERROR)
  })

  it('rejects selector collisions on non-Pyth targets', () => {
    const reviewed = prepared('0x01')
    const candidate = prepared('0x02')
    for (const plan of [reviewed, candidate]) {
      const batch = plan.plan[0]
      if (batch?.type === 'evcBatch' && !('type' in batch.items[0]!)) {
        batch.items[0]!.targetContract = nonPyth
      }
    }

    expect(() => requireReviewedBatchPreparedExecution(reviewed, candidate))
      .toThrow(REVIEWED_BATCH_EXECUTION_CHANGED_ERROR)
  })
})

describe('requireReviewedPrerequisiteEnvelope', () => {
  const reviewed = {
    preTxs: [
      { to: vault, data: '0x1111' as Hex, value: 0n },
      { to: nonPyth, data: '0x2222' as Hex, value: 1n },
    ],
    postTxs: [{ to: vault, data: '0x3333' as Hex, value: 0n }],
    walletContext: { account: owner, chainId: 1 },
  }

  it('accepts the exact reviewed writes and ordered batch omissions', () => {
    expect(requireReviewedPrerequisiteEnvelope(reviewed, reviewed)).toBe(reviewed)
    const candidate = { ...reviewed, preTxs: [reviewed.preTxs[1]!] }
    expect(requireReviewedPrerequisiteEnvelope(reviewed, candidate, { allowOmissions: true })).toBe(candidate)
  })

  it('rejects changed target, calldata, value, order, account, and chain', () => {
    const candidates = [
      { ...reviewed, preTxs: [{ ...reviewed.preTxs[0]!, to: nonPyth }] },
      { ...reviewed, preTxs: [{ ...reviewed.preTxs[0]!, data: '0x9999' as Hex }] },
      { ...reviewed, preTxs: [{ ...reviewed.preTxs[0]!, value: 2n }] },
      { ...reviewed, preTxs: [...reviewed.preTxs].reverse() },
      { ...reviewed, postTxs: [{ ...reviewed.postTxs[0]!, data: '0x9999' as Hex }] },
      { ...reviewed, walletContext: { ...reviewed.walletContext, account: vault } },
      { ...reviewed, walletContext: { ...reviewed.walletContext, chainId: 10 } },
    ]
    for (const candidate of candidates) {
      expect(() => requireReviewedPrerequisiteEnvelope(reviewed, candidate))
        .toThrow(REVIEWED_PREREQUISITES_CHANGED_ERROR)
    }
  })
})

const groupedPrepared = (update: Hex): TransactionPlanPrepared => {
  const result = prepared(update)
  const batch = result.plan[0]
  if (batch?.type === 'evcBatch') {
    batch.items = [{
      type: 'operation',
      name: 'Pyth-backed operation',
      items: flattenBatchEntries(batch.items),
    }]
  }
  return result
}

describe('requireReviewedExecution', () => {
  it('returns the exact reviewed artifact by identity', () => {
    const reviewed = { plan: [], chainId: 1 } as unknown as TransactionPlanPrepared

    expect(requireReviewedExecution(reviewed)).toBe(reviewed)
  })

  it('fails closed when review did not provide an executable artifact', () => {
    expect(() => requireReviewedExecution(undefined)).toThrow(REVIEWED_EXECUTION_UNAVAILABLE_ERROR)
  })
})

describe('requirePythOnlyPreparedRefresh', () => {
  it('accepts fresh Pyth bytes and fees when the reviewed operations are unchanged', () => {
    const reviewed = prepared('0x01')
    const refreshed = prepared('0x02')
    const batch = refreshed.plan[0]
    if (batch?.type === 'evcBatch' && !('type' in batch.items[0]!)) batch.items[0]!.value = 2n

    expect(requirePythOnlyPreparedRefresh(reviewed, refreshed)).toBe(refreshed)
  })

  it('rejects a changed non-Pyth operation', () => {
    expect(() => requirePythOnlyPreparedRefresh(prepared('0x01'), prepared('0x02', '0x87654321')))
      .toThrow(REVIEWED_EXECUTION_CHANGED_ERROR)
  })

  it('rejects a changed prepared account', () => {
    const refreshed = prepared('0x02')
    refreshed.account = vault

    expect(() => requirePythOnlyPreparedRefresh(prepared('0x01'), refreshed))
      .toThrow(REVIEWED_EXECUTION_CHANGED_ERROR)
  })

  it('rejects a missing Pyth update', () => {
    const refreshed = prepared('0x02')
    const batch = refreshed.plan[0]
    if (batch?.type === 'evcBatch') batch.items.shift()

    expect(() => requirePythOnlyPreparedRefresh(prepared('0x01'), refreshed))
      .toThrow(REVIEWED_EXECUTION_CHANGED_ERROR)
  })

  it('rejects selector collisions on non-Pyth targets', () => {
    const reviewed = prepared('0x01')
    const refreshed = prepared('0x02')
    for (const plan of [reviewed, refreshed]) {
      const batch = plan.plan[0]
      if (batch?.type === 'evcBatch' && !('type' in batch.items[0]!)) {
        batch.items[0]!.targetContract = nonPyth
      }
    }

    expect(() => requirePythOnlyPreparedRefresh(reviewed, refreshed))
      .toThrow(REVIEWED_EXECUTION_CHANGED_ERROR)
  })

  it.each(['malformed', 'extra'] as const)('rejects %s Pyth calldata', (kind) => {
    const reviewed = prepared('0x01')
    const refreshed = prepared('0x02')
    const batch = refreshed.plan[0]
    if (batch?.type === 'evcBatch' && !('type' in batch.items[0]!)) {
      const call = batch.items[0]!
      call.data = kind === 'malformed'
        ? `${call.data.slice(0, 10)}deadbeef` as Hex
        : `${call.data}deadbeef` as Hex
    }

    expect(() => requirePythOnlyPreparedRefresh(reviewed, refreshed))
      .toThrow(REVIEWED_EXECUTION_CHANGED_ERROR)
  })

  it('rejects a Pyth fee above the configured bound', () => {
    const reviewed = prepared('0x01')
    const refreshed = prepared('0x02')
    const batch = refreshed.plan[0]
    if (batch?.type === 'evcBatch' && !('type' in batch.items[0]!)) {
      batch.items[0]!.value = 10n ** 16n + 1n
    }

    expect(() => requirePythOnlyPreparedRefresh(reviewed, refreshed))
      .toThrow(REVIEWED_EXECUTION_CHANGED_ERROR)
  })
})

describe('refreshReviewedPythExecution', () => {
  it('re-prepares Pyth plans with the reviewed execution context', async () => {
    const reviewed = prepared('0x01')
    const refreshed = prepared('0x02')
    const rawPlan = reviewed.plan
    let received: unknown[] = []
    const prepare = async (
      candidate: TransactionPlan,
      options: Pick<TransactionPlanPrepared, 'account' | 'chainId' | 'usePermit2'>,
    ) => {
      received = [candidate, options]
      return refreshed
    }

    await expect(refreshReviewedPythExecution(reviewed, rawPlan, prepare)).resolves.toBe(refreshed)
    expect(received).toEqual([rawPlan, {
      account: reviewed.account,
      chainId: reviewed.chainId,
      usePermit2: reviewed.usePermit2,
    }])
  })

  it('does not re-prepare plans without Pyth updates', async () => {
    const reviewed = prepared('0x01')
    const batch = reviewed.plan[0]
    if (batch?.type === 'evcBatch') batch.items.shift()
    let called = false

    await expect(refreshReviewedPythExecution(reviewed, reviewed.plan, async () => {
      called = true
      return reviewed
    })).resolves.toBe(reviewed)
    expect(called).toBe(false)
  })

  it('detects and canonicalizes Pyth updates inside an SDK operation group', async () => {
    const reviewed = groupedPrepared('0x01')
    const refreshed = groupedPrepared('0x02')
    const prepare = async () => refreshed

    await expect(refreshReviewedPythExecution(reviewed, reviewed.plan, prepare)).resolves.toBe(refreshed)
  })
})
