import { encodeFunctionData, getAddress, keccak256, toHex, type Abi, type Hex } from 'viem'
import type { EVCBatchItem, TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { describe, expect, it } from 'vitest'
import { EVC_ABI } from '~/abis/evc'
import type { OperationIntent } from '~/features/transaction-ceremony/domain/intents'
import type { EoaRequest, WalletBinding } from '~/features/transaction-ceremony/domain/template'
import { assertFinalizedArtifactMatchesTemplate, finalizeExecutionTemplate } from '~/features/transaction-ceremony/materialization/finalize'
import { executionTemplateDigest, materializePreparedPlan } from '~/features/transaction-ceremony/materialization/prepared-plan'
import { prepareMigrationSignatureEvidence } from '~/features/transaction-ceremony/materialization/signature-slots'

const ACCOUNT = getAddress('0x1000000000000000000000000000000000000000')
const TARGET = getAddress('0x2000000000000000000000000000000000000000')
const EVC = getAddress('0x3000000000000000000000000000000000000000')
const ABI = [{ type: 'function', name: 'authorize', stateMutability: 'nonpayable', inputs: [{ name: 'signature', type: 'bytes' }], outputs: [] }] as const satisfies Abi
const placeholder = `0x${'00'.repeat(65)}` as Hex
const signature = `0x${'11'.repeat(65)}` as Hex

const intent: OperationIntent = {
  schemaVersion: 1, intentId: 'migration-1', revision: 1, kind: 'migration', chainId: 1, account: ACCOUNT,
  subAccounts: [ACCOUNT], planner: { name: 'cross-protocol-migration', args: { direction: 'external-to-euler', connectorId: 'morpho', owner: ACCOUNT, positionRef: 'position-1' } },
  constraints: [{ kind: 'share-bound', vault: TARGET, maximumShares: 100n }], metadata: { createdAt: 1, source: 'test' },
}
const wallet: WalletBinding = { chainId: 1, account: ACCOUNT, subAccounts: [ACCOUNT], connectorId: 'injected', connectorSessionId: 'session-1', walletKind: 'eoa', classificationVersion: 'v1', approvalMode: 'approve' }
const encodeBatch = (items: EVCBatchItem[]) => encodeFunctionData({ abi: EVC_ABI, functionName: 'batch', args: [items] })
const sdk = {
  deploymentService: { getDeployment: () => ({ addresses: { coreAddrs: { evc: EVC } } }) },
  executionService: {
    encodeBatch,
    encodePermit2Call: () => { throw new Error('unused') },
    encodeMigrationAuthorizationCall: ({ signature: value }: { signature: Hex }) => ({
      targetContract: TARGET, onBehalfOfAccount: ACCOUNT, value: 0n,
      data: encodeFunctionData({ abi: ABI, functionName: 'authorize', args: [value] }),
    }),
  },
}

describe('typed migration authorization slots', () => {
  it('uses the declared ABI path and changes no unrelated request bytes', () => {
    const plan: TransactionPlan = [{ type: 'evcBatch', items: [{ targetContract: TARGET, onBehalfOfAccount: ACCOUNT, value: 0n, data: encodeFunctionData({ abi: ABI, functionName: 'authorize', args: [placeholder] }) }] }]
    const prepared = prepareMigrationSignatureEvidence({
      planItemIndex: 0,
      batchItemIndex: 0,
      signer: ACCOUNT,
      chainId: 1,
      typedData: { domain: { name: 'Morpho', chainId: 1, verifyingContract: TARGET }, types: { Authorization: [{ name: 'owner', type: 'address' }] }, primaryType: 'Authorization', message: { owner: ACCOUNT } },
      abiArgumentPath: ['signature'],
    })
    const template = materializePreparedPlan({ intents: [intent], plan, wallet, sdk, migrationSignatureSlots: [prepared], policyEvidenceDigest: keccak256(toHex('policy')) })
    const slot = template.signatureSlots[0]!
    const artifact = finalizeExecutionTemplate({ ceremonyId: keccak256(toHex('ceremony')), templateDigest: executionTemplateDigest(template), template, sdk, signatures: [{ slotId: slot.slotId, signature }], pythValues: [] })
    expect(artifact.requests[0]!.data).not.toBe(template.requests[0]!.data)
    expect(artifact.signatureValues).toEqual([{ slotId: slot.slotId, signature }])
    expect(() => assertFinalizedArtifactMatchesTemplate(template, artifact.requests, sdk, { signatures: [{ slotId: slot.slotId, signature }], pythValues: [] })).not.toThrow()

    const request = artifact.requests[0]!
    const tampered: EoaRequest[] = [{ ...(request as EoaRequest), data: `${request.data.slice(0, -2)}ff` as Hex }]
    expect(() => assertFinalizedArtifactMatchesTemplate(template, tampered, sdk, { signatures: [{ slotId: slot.slotId, signature }], pythValues: [] }))
      .toThrow()
  })

  it('rejects signature transposition instead of scanning placeholder bytes', () => {
    const plan: TransactionPlan = [{ type: 'evcBatch', items: [{ targetContract: TARGET, onBehalfOfAccount: ACCOUNT, value: 0n, data: encodeFunctionData({ abi: ABI, functionName: 'authorize', args: [placeholder] }) }] }]
    const template = materializePreparedPlan({ intents: [intent], plan, wallet, sdk, policyEvidenceDigest: keccak256(toHex('policy')) })
    expect(() => finalizeExecutionTemplate({ ceremonyId: keccak256(toHex('ceremony')), templateDigest: executionTemplateDigest(template), template, sdk, signatures: [{ slotId: keccak256(toHex('other')), signature }], pythValues: [] }))
      .toThrow(/exactly match/)
  })
})
