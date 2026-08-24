import { encodeFunctionData, getAddress, hashTypedData, keccak256, toHex, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { EVCBatchItem, TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { describe, expect, it } from 'vitest'
import { EVC_ABI } from '~/abis/evc'
import { PYTH_ABI } from '~/abis/pyth'
import type { OperationIntent } from '~/features/reviewed-execution/domain/intents'
import type { WalletBinding } from '~/features/reviewed-execution/domain/reviewed-execution'
import { validateReviewedRequestSet } from '~/features/reviewed-execution/domain/validators'
import { reviewedRequestDigest, materializePreparedPlan, normalizedRequestDigest } from '~/features/reviewed-execution/materialization/prepared-plan'
import { assertPermit2NonceCurrent, assertSignatureMatchesSigner, permit2NonceCoordinate, type PreparedPermit2Slot } from '~/features/reviewed-execution/materialization/signature-slots'

const ACCOUNT = getAddress('0x1000000000000000000000000000000000000000')
const TOKEN = getAddress('0x2000000000000000000000000000000000000000')
const VAULT = getAddress('0x3000000000000000000000000000000000000000')
const SPENDER = getAddress('0x4000000000000000000000000000000000000000')
const EVC = getAddress('0x5000000000000000000000000000000000000000')
const PYTH = getAddress('0x6000000000000000000000000000000000000000')
const POLICY = keccak256(toHex('policy'))

const intent: OperationIntent = {
  schemaVersion: 1,
  intentId: 'intent-1',
  revision: 2,
  kind: 'deposit',
  chainId: 1,
  account: ACCOUNT,
  subAccounts: [ACCOUNT],
  planner: { name: 'deposit', args: { vaultAddress: VAULT, assetAddress: TOKEN, amount: 10n } },
  constraints: [{ kind: 'exact-input', token: TOKEN, amount: 10n }],
  metadata: { createdAt: 1, source: 'test' },
}

const eoa: WalletBinding = {
  chainId: 1,
  account: ACCOUNT,
  subAccounts: [ACCOUNT],
  connectorId: 'injected',
  connectorSessionId: 'session-1',
  walletKind: 'eoa',
  classificationVersion: 'classification-1',
  approvalMode: 'approve',
}

const sdk = {
  deploymentService: {
    getDeployment: () => ({ addresses: { coreAddrs: { evc: EVC } } }),
  },
  executionService: {
    encodeBatch: (items: EVCBatchItem[]) =>
      encodeFunctionData({ abi: EVC_ABI, functionName: 'batch', args: [items] }),
  },
}

const coreItem = {
  targetContract: VAULT,
  onBehalfOfAccount: ACCOUNT,
  value: 0n,
  data: '0x12345678' as Hex,
}

describe('prepared plan materialization', () => {
  it('rejects the empty-domain signature produced when typed data bypasses wagmi serialization', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const typedData = {
      domain: { name: 'Permit2', chainId: 1, verifyingContract: SPENDER },
      types: {
        PermitDetails: [
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint160' },
          { name: 'expiration', type: 'uint48' },
          { name: 'nonce', type: 'uint48' },
        ],
        PermitSingle: [
          { name: 'details', type: 'PermitDetails' },
          { name: 'spender', type: 'address' },
          { name: 'sigDeadline', type: 'uint256' },
        ],
      },
      primaryType: 'PermitSingle' as const,
      message: {
        details: { token: TOKEN, amount: 10n, expiration: 2_000_000_000, nonce: 7 },
        spender: VAULT,
        sigDeadline: 2_000_000_000n,
      },
    }
    const slot = {
      slotId: keccak256(toHex('permit2-slot')),
      kind: 'permit2' as const,
      signer: account.address,
      chainId: 1,
      typedData,
      typedDataHash: hashTypedData(typedData),
      validUntil: 2_000_000_000,
      nonce: 7n,
      insertionPoints: [],
    }
    const validSignature = await account.signTypedData(typedData)
    const emptyDomainSignature = await account.signTypedData({ ...typedData, domain: {} })

    await expect(assertSignatureMatchesSigner(slot, validSignature)).resolves.toBeUndefined()
    await expect(assertSignatureMatchesSigner(slot, emptyDomainSignature)).rejects.toThrow(/signed different typed data/)
  })

  it('materializes a deterministic EOA request vector and complete decoded-call list', () => {
    const plan: TransactionPlan = [
      {
        type: 'requiredApproval',
        token: TOKEN,
        owner: ACCOUNT,
        spender: SPENDER,
        amount: 10n,
        resolved: [{ type: 'approve', token: TOKEN, owner: ACCOUNT, spender: SPENDER, amount: 10n, data: '0x095ea7b3' }],
      },
      { type: 'evcBatch', items: [coreItem] },
    ]

    const first = materializePreparedPlan({ intents: [intent], plan, wallet: eoa, sdk, policyDigest: POLICY })
    const second = materializePreparedPlan({ intents: [intent], plan, wallet: eoa, sdk, policyDigest: POLICY })

    expect(reviewedRequestDigest(first)).toBe(reviewedRequestDigest(second))
    expect(normalizedRequestDigest(first.requests)).toBe(normalizedRequestDigest(second.requests))
    expect(first.requests).toHaveLength(2)
    expect(first.effects.map(node => node.effect.kind)).toEqual(['approval', 'evc-call'])
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.effects[0])).toBe(true)
  })

  it('consumes and verifies the SDK-owned deterministic request composition', () => {
    const plan: TransactionPlan = [{ type: 'evcBatch', items: [coreItem] }]
    let calls = 0
    const verifyingSdk = {
      ...sdk,
      executionService: {
        ...sdk.executionService,
        materializeExecution({ prepared, inputs }: {
          prepared: { plan: TransactionPlan, chainId: number, account: typeof ACCOUNT }
          inputs: { evcAddress: typeof EVC }
        }) {
          calls += 1
          expect(this.encodeBatch).toBe(sdk.executionService.encodeBatch)
          const item = prepared.plan[0]
          if (item?.type !== 'evcBatch') throw new Error('expected EVC batch')
          const data = this.encodeBatch(item.items as EVCBatchItem[])
          return {
            requests: [{ requestIndex: 0, sourcePlanItemIndex: 0, chainId: prepared.chainId, from: prepared.account, to: inputs.evcAddress, data, value: 0n }],
            signatureSlots: [],
          }
        },
      },
    }

    expect(() => materializePreparedPlan({ intents: [intent], plan, wallet: eoa, sdk: verifyingSdk, policyDigest: POLICY })).not.toThrow()
    expect(calls).toBe(1)
    const driftingSdk = {
      ...verifyingSdk,
      executionService: {
        ...verifyingSdk.executionService,
        materializeExecution: (args: Parameters<typeof verifyingSdk.executionService.materializeExecution>[0]) => {
          const result = verifyingSdk.executionService.materializeExecution(args)
          return { ...result, requests: result.requests.map(request => ({ ...request, data: '0xdeadbeef' as Hex })) }
        },
      },
    }
    expect(() => materializePreparedPlan({ intents: [intent], plan, wallet: eoa, sdk: driftingSdk, policyDigest: POLICY }))
      .toThrow(/SDK materialized request 0 differently/)
  })

  it('resolves transport before sealing and never reclassifies the call vector', () => {
    const plan: TransactionPlan = [{ type: 'evcBatch', items: [coreItem] }]
    const safeWallet: WalletBinding = {
      ...eoa,
      connectorId: 'walletConnect',
      walletKind: 'safe',
      safeAddress: ACCOUNT,
      approvalMode: 'approve',
    }

    const requestSet = materializePreparedPlan({ intents: [intent], plan, wallet: safeWallet, sdk, safeAtomicCapability: { status: 'supported' }, policyDigest: POLICY })
    expect(requestSet.transport).toBe('safe')
    expect(requestSet.requests).toHaveLength(1)
    expect(requestSet.requests[0]).toHaveProperty('callId')
    expect(requestSet.requests[0]).not.toHaveProperty('requestId')
    expect(requestSet.safeTransport).toMatchObject({
      version: '2.0.0',
      from: ACCOUNT,
      chainId: 1,
      atomicRequired: true,
      atomicCapability: { status: 'supported' },
    })
    expect(requestSet.safeTransport?.calls).toEqual([{ to: EVC, data: requestSet.requests[0].data, value: 0n }])
  })

  it('blocks Safe review without supported or ready atomic capability evidence', () => {
    const safeWallet: WalletBinding = { ...eoa, connectorId: 'safe', walletKind: 'safe', safeAddress: ACCOUNT, approvalMode: 'approve' }
    expect(() => materializePreparedPlan({ intents: [intent], plan: [{ type: 'evcBatch', items: [coreItem] }], wallet: safeWallet, sdk, policyDigest: POLICY }))
      .toThrow(/atomic capability/i)
  })

  it('binds Permit2 typed data to an ABI-aware insertion point', async () => {
    const approval = { type: 'permit2' as const, token: TOKEN, owner: ACCOUNT, spender: SPENDER, amount: 10n }
    const plan: TransactionPlan = [
      { type: 'requiredApproval', token: TOKEN, owner: ACCOUNT, spender: SPENDER, amount: 10n, resolved: [approval] },
      { type: 'evcBatch', items: [coreItem] },
    ]
    const typedData = {
      domain: { name: 'Permit2', chainId: 1, verifyingContract: SPENDER },
      types: {
        PermitDetails: [{ name: 'token', type: 'address' }, { name: 'nonce', type: 'uint48' }],
        PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
      },
      primaryType: 'PermitSingle',
      message: { details: { token: TOKEN, nonce: 7 }, spender: SPENDER, sigDeadline: 2_000_000_000n },
    } as const
    const permitSlot: PreparedPermit2Slot = {
      slotId: keccak256(toHex('slot')),
      planItemIndex: 0,
      resolvedIndex: 0,
      approval,
      signer: ACCOUNT,
      chainId: 1,
      nonce: 7,
      validUntil: 2_000_000_000,
      typedData,
      typedDataHash: hashTypedData(typedData),
      placeholderBatchItem: { targetContract: SPENDER, onBehalfOfAccount: ACCOUNT, value: 0n, data: '0xabcdef01' },
    }
    const requestSet = materializePreparedPlan({
      intents: [intent],
      plan,
      wallet: { ...eoa, approvalMode: 'permit2' },
      sdk,
      permit2Slots: [permitSlot],
      policyDigest: POLICY,
    })

    expect(requestSet.signatureSlots).toHaveLength(1)
    expect(requestSet.signatureSlots[0].typedDataHash).toBe(permitSlot.typedDataHash)
    expect(requestSet.signatureSlots[0].validUntil).toBe(2_000_000_000)
    expect(requestSet.signatureSlots[0].insertionPoints).toEqual([expect.objectContaining({ batchItemIndex: 0, abiArgumentPath: ['signature'] })])
    expect(requestSet.effects[0].effect).toMatchObject({ kind: 'approval', mode: 'permit2', owner: ACCOUNT, token: TOKEN, spender: SPENDER, amount: 10n })
    expect(() => validateReviewedRequestSet(requestSet, [intent])).not.toThrow()
    expect(() => validateReviewedRequestSet({
      ...requestSet,
      signatureSlots: [{ ...requestSet.signatureSlots[0], typedDataHash: keccak256(toHex('tampered')) }],
    }, [intent])).toThrow(/typed-data digest changed/)
    expect(() => validateReviewedRequestSet({
      ...requestSet,
      signatureSlots: [{
        ...requestSet.signatureSlots[0],
        insertionPoints: [{ ...requestSet.signatureSlots[0].insertionPoints[0], effectId: requestSet.effects[1].effectId }],
      }],
    }, [intent])).toThrow(/different effect/)
    expect(permit2NonceCoordinate(requestSet.signatureSlots[0])).toEqual({ owner: ACCOUNT, token: TOKEN, spender: SPENDER, permit2: SPENDER, nonce: 7n })
    expect(() => permit2NonceCoordinate({ ...requestSet.signatureSlots[0], nonce: 8n })).toThrow(/nonce does not match/)
    await expect(assertPermit2NonceCurrent(requestSet.signatureSlots[0], async () => 8n)).rejects.toThrow(/nonce changed after review/)
  })

  it('seals a bounded Pyth slot and rejects missing feed evidence', () => {
    const updates = ['0x0102', '0x0304'] as const
    const pythItem = {
      targetContract: PYTH,
      onBehalfOfAccount: ACCOUNT,
      value: 2n,
      data: encodeFunctionData({ abi: PYTH_ABI, functionName: 'updatePriceFeeds', args: [updates] }),
    }
    const plan: TransactionPlan = [{ type: 'evcBatch', items: [pythItem, coreItem] }]
    const evidence = [{
      planItemIndex: 0,
      batchItemIndex: 0,
      target: PYTH,
      requiredFeedIds: [keccak256(toHex('feed'))],
      publishTimes: [100],
      maxValue: 10n,
      freshnessPolicy: { maximumAgeSeconds: 60, minimumPublishTime: 90 },
    }]

    const requestSet = materializePreparedPlan({ intents: [intent], plan, wallet: eoa, sdk, pythPreviewData: evidence, policyDigest: POLICY })
    expect(requestSet.pythRefreshSlots).toHaveLength(1)
    expect(requestSet.pythRefreshSlots[0]).toMatchObject({ target: PYTH, previewValue: 2n, maxValue: 10n, previewPublishTimes: [100] })
    expect(() => validateReviewedRequestSet(requestSet, [intent])).not.toThrow()
    expect(() => validateReviewedRequestSet({
      ...requestSet,
      pythRefreshSlots: [{ ...requestSet.pythRefreshSlots[0], previewPayloadHash: keccak256(toHex('tampered')) }],
    }, [intent])).toThrow(/preview payload digest changed/)
    expect(() => materializePreparedPlan({ intents: [intent], plan, wallet: eoa, sdk, policyDigest: POLICY }))
      .toThrow(/Pyth update is missing sealed feed/)
  })

  it('rejects unresolved approvals, cross-chain calls, and unclassified direct calls', () => {
    expect(() => materializePreparedPlan({
      intents: [intent],
      plan: [{ type: 'requiredApproval', token: TOKEN, owner: ACCOUNT, spender: SPENDER, amount: 1n }],
      wallet: eoa,
      sdk,
      policyDigest: POLICY,
    })).toThrow(/unresolved/)

    expect(() => materializePreparedPlan({
      intents: [intent],
      plan: [{ type: 'contractCall', chainId: 2, to: VAULT, abi: [], functionName: 'claim', args: [], value: 0n }],
      wallet: eoa,
      sdk,
      policyDigest: POLICY,
    })).toThrow(/another chain/)

    expect(() => materializePreparedPlan({
      intents: [intent],
      plan: [{ type: 'contractCall', chainId: 1, to: VAULT, abi: [{ type: 'function', name: 'claim', inputs: [], outputs: [], stateMutability: 'nonpayable' }], functionName: 'claim', args: [], value: 0n }],
      wallet: eoa,
      sdk,
      policyDigest: POLICY,
    })).toThrow(/no simulation coverage/)
  })

  it('unwinds cleanup calls in reverse order', () => {
    const owner = { intentId: intent.intentId, intentRevision: intent.revision }
    const plan: TransactionPlan = [{ type: 'evcBatch', items: [coreItem] }]
    const requestSet = materializePreparedPlan({
      intents: [intent],
      plan,
      wallet: eoa,
      sdk,
      policyDigest: POLICY,
      after: [
        { phase: 'cleanup', authorizationId: keccak256(toHex('authorization-1')), owner, provenance: { source: 'migration-authorization', mode: 'transaction' }, chainId: 1, to: TOKEN, data: '0x00000001' },
        { phase: 'cleanup', authorizationId: keccak256(toHex('authorization-2')), owner, provenance: { source: 'migration-authorization', mode: 'transaction' }, chainId: 1, to: SPENDER, data: '0x00000002' },
      ],
    })

    expect(requestSet.requests.slice(-2).map(request => request.to)).toEqual([SPENDER, TOKEN])
    expect(requestSet.requests.slice(-2).map(request => request.phase)).toEqual(['cleanup', 'cleanup'])
  })

  it('rejects ambiguous migration authorization identities', () => {
    const owner = { intentId: intent.intentId, intentRevision: intent.revision }
    const authorizationId = keccak256(toHex('duplicated-authorization'))
    const requestSet = materializePreparedPlan({
      intents: [intent],
      plan: [{ type: 'evcBatch', items: [coreItem] }],
      wallet: eoa,
      sdk,
      policyDigest: POLICY,
      before: [
        { phase: 'prerequisite', authorizationId, owner, provenance: { source: 'migration-authorization', mode: 'transaction' }, chainId: 1, to: TOKEN, data: '0x00000001' },
        { phase: 'prerequisite', authorizationId, owner, provenance: { source: 'migration-authorization', mode: 'transaction' }, chainId: 1, to: SPENDER, data: '0x00000002' },
      ],
    })

    expect(() => validateReviewedRequestSet(requestSet, [intent])).toThrow(/not a unique grant\/revocation pair/)
  })
})
