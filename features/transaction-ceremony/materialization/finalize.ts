import { decodeFunctionData, getAddress, type Hash, type Hex } from 'viem'
import type { EVCBatchItem } from '@eulerxyz/euler-v2-sdk'
import { EVC_ABI } from '~/abis/evc'
import { canonicalDigest, deepFreezeSerializable, toCanonicalValue } from '../domain/canonical'
import type { EoaRequest, ExecutionTemplate, FinalizedArtifact, SafeCall } from '../domain/template'
import type { RefreshedPythValue } from './pyth-refresh'

export interface FinalizationSdk {
  executionService: {
    encodeBatch: (items: EVCBatchItem[]) => Hex
    encodePermit2Call: (args: {
      chainId: number
      owner: `0x${string}`
      message: Record<string, unknown>
      signature: Hex
    }) => EVCBatchItem
    /** Public SDK encoder for a reviewed migration authorization ABI slot. */
    encodeMigrationAuthorizationCall?: (args: {
      chainId: number
      signer: `0x${string}`
      typedDataHash: Hash
      abiArgumentPath: readonly (string | number)[]
      reviewedItem: EVCBatchItem
      signature: Hex
    }) => EVCBatchItem
  }
}

export interface CollectedSignature {
  slotId: Hash
  signature: Hex
}

const requestIdOf = (request: EoaRequest | SafeCall) => 'requestId' in request ? request.requestId : request.callId

const decodeBatchItems = (data: Hex): EVCBatchItem[] => {
  try {
    const decoded = decodeFunctionData({ abi: EVC_ABI, data })
    if (decoded.functionName !== 'batch') throw new Error('not batch')
    return decoded.args[0].map(item => ({
      targetContract: getAddress(item.targetContract),
      onBehalfOfAccount: getAddress(item.onBehalfOfAccount),
      value: item.value,
      data: item.data,
    }))
  }
  catch {
    throw new Error('Dynamic slot points to malformed EVC batch calldata')
  }
}

const assertExactSlotSet = (expected: readonly Hash[], actual: readonly Hash[], label: string) => {
  if (expected.length !== actual.length || expected.some(id => !actual.includes(id))) {
    throw new Error(`${label} values do not exactly match the reviewed slots`)
  }
}

export const finalizeExecutionTemplate = ({
  ceremonyId,
  templateDigest,
  template,
  sdk,
  signatures,
  pythValues,
}: {
  ceremonyId: Hash
  templateDigest: Hash
  template: ExecutionTemplate
  sdk: FinalizationSdk
  signatures: readonly CollectedSignature[]
  pythValues: readonly RefreshedPythValue[]
}): Readonly<FinalizedArtifact> => {
  assertExactSlotSet(template.signatureSlots.map(slot => slot.slotId), signatures.map(value => value.slotId), 'Signature')
  assertExactSlotSet(template.pythRefreshSlots.map(slot => slot.slotId), pythValues.map(value => value.slotId), 'Pyth')

  const requests = template.requests.map((sealedRequest): EoaRequest | SafeCall => {
    const requestId = requestIdOf(sealedRequest)
    const signatureSlots = template.signatureSlots.filter(slot => slot.insertionPoints.some(point => point.requestId === requestId))
    const pythSlots = template.pythRefreshSlots.filter(slot => slot.insertionPoint.requestId === requestId)
    if (!signatureSlots.length && !pythSlots.length) return { ...sealedRequest }

    const items = decodeBatchItems(sealedRequest.data)
    for (const slot of signatureSlots) {
      const value = signatures.find(candidate => candidate.slotId === slot.slotId)
      if (!value) throw new Error('Signature slot value is missing')
      for (const insertion of slot.insertionPoints) {
        if (insertion.requestId !== requestId) continue
        if (!items[insertion.batchItemIndex]) throw new Error('Signature insertion point is out of range')
        if (slot.kind === 'permit2') {
          const message = slot.typedData.message
          if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Permit2 typed-data message is malformed')
          items[insertion.batchItemIndex] = sdk.executionService.encodePermit2Call({
            chainId: slot.chainId,
            owner: slot.signer,
            message: message as Record<string, unknown>,
            signature: value.signature,
          })
        }
        else {
          if (!sdk.executionService.encodeMigrationAuthorizationCall) throw new Error('SDK migration authorization encoder is unavailable')
          items[insertion.batchItemIndex] = sdk.executionService.encodeMigrationAuthorizationCall({
            chainId: slot.chainId,
            signer: slot.signer,
            typedDataHash: slot.typedDataHash,
            abiArgumentPath: insertion.abiArgumentPath,
            reviewedItem: items[insertion.batchItemIndex],
            signature: value.signature,
          })
        }
      }
    }
    for (const slot of pythSlots) {
      const value = pythValues.find(candidate => candidate.slotId === slot.slotId)
      if (!value) throw new Error('Pyth slot value is missing')
      const index = slot.insertionPoint.batchItemIndex
      const current = items[index]
      if (!current) throw new Error('Pyth insertion point is out of range')
      items[index] = {
        targetContract: value.target,
        onBehalfOfAccount: value.onBehalfOfAccount,
        data: value.data,
        value: value.value,
      }
    }
    const data = sdk.executionService.encodeBatch(items)
    const value = items.reduce((sum, item) => sum + item.value, 0n)
    return { ...sealedRequest, data, value }
  }) as EoaRequest[] | SafeCall[]

  assertFinalizedArtifactMatchesTemplate(template, requests, sdk, { signatures, pythValues })

  const artifact: FinalizedArtifact = {
    __finalizedArtifact: true,
    ceremonyId,
    templateDigest,
    transport: template.transport,
    requests,
    signatureValues: signatures.map(value => ({ ...value })),
    pythValues: pythValues.map(value => ({ slotId: value.slotId, payloadHash: value.payloadHash, value: value.value })),
  }
  return deepFreezeSerializable(artifact) as Readonly<FinalizedArtifact>
}

export const assertFinalizedArtifactMatchesTemplate = (
  template: ExecutionTemplate,
  finalizedRequests: readonly EoaRequest[] | readonly SafeCall[],
  sdk: Pick<FinalizationSdk, 'executionService'>,
  dynamicValues?: { signatures: readonly CollectedSignature[], pythValues: readonly RefreshedPythValue[] },
) => {
  if (template.requests.length !== finalizedRequests.length) throw new Error('Finalized request count changed')

  const normalized = finalizedRequests.map((actual, requestIndex): EoaRequest | SafeCall => {
    const sealed = template.requests[requestIndex] as EoaRequest | SafeCall
    if (requestIdOf(actual) !== requestIdOf(sealed)) throw new Error('Finalized request identity changed')
    for (const key of ['effectIds', 'phase', 'to'] as const) {
      if (canonicalDigest(`request-${key}-v1`, toCanonicalValue(actual[key])) !== canonicalDigest(`request-${key}-v1`, toCanonicalValue(sealed[key]))) {
        throw new Error(`Finalized request ${key} changed`)
      }
    }
    if ('requestId' in sealed) {
      if (!('requestId' in actual) || actual.chainId !== sealed.chainId || getAddress(actual.from) !== getAddress(sealed.from)) {
        throw new Error('Finalized EOA transport fields changed')
      }
    }
    else if ('requestId' in actual) {
      throw new Error('Finalized Safe transport changed')
    }

    const requestId = requestIdOf(sealed)
    const dynamicIndices = new Set<number>([
      ...template.signatureSlots.flatMap(slot => slot.insertionPoints.filter(point => point.requestId === requestId).map(point => point.batchItemIndex)),
      ...template.pythRefreshSlots.filter(slot => slot.insertionPoint.requestId === requestId).map(slot => slot.insertionPoint.batchItemIndex),
    ])
    if (!dynamicIndices.size) {
      if (actual.data !== sealed.data || actual.value !== sealed.value) throw new Error('Finalized static request changed')
      return { ...actual }
    }

    const actualItems = decodeBatchItems(actual.data)
    const sealedItems = decodeBatchItems(sealed.data)
    if (actualItems.length !== sealedItems.length) throw new Error('Finalized EVC batch length changed')
    if (sdk.executionService.encodeBatch(actualItems) !== actual.data) {
      throw new Error('Finalized EVC calldata is not the canonical reviewed encoding')
    }
    if (actual.value !== actualItems.reduce((sum, item) => sum + item.value, 0n)) {
      throw new Error('Finalized request native value does not match its EVC batch')
    }
    for (const [index, item] of actualItems.entries()) {
      const expected = sealedItems[index]
      if (!expected) throw new Error('Finalized EVC batch shape changed')
      if (!dynamicIndices.has(index)) {
        if (canonicalDigest('static-batch-item-v1', toCanonicalValue(item)) !== canonicalDigest('static-batch-item-v1', toCanonicalValue(expected))) {
          throw new Error('Finalized static batch item changed')
        }
        continue
      }
      if (getAddress(item.targetContract) !== getAddress(expected.targetContract) || getAddress(item.onBehalfOfAccount) !== getAddress(expected.onBehalfOfAccount)) {
        throw new Error('Finalized dynamic slot target changed')
      }
      const signatureSlot = template.signatureSlots.find(slot => slot.insertionPoints.some(point => point.requestId === requestId && point.batchItemIndex === index))
      const pythSlot = template.pythRefreshSlots.find(slot => slot.insertionPoint.requestId === requestId && slot.insertionPoint.batchItemIndex === index)
      if (signatureSlot && pythSlot) throw new Error('Dynamic slots overlap')
      if (signatureSlot) {
        if (!dynamicValues) throw new Error('Signature values are required to verify a finalized dynamic request')
        const value = dynamicValues.signatures.find(candidate => candidate.slotId === signatureSlot.slotId)
        if (!value) throw new Error('Finalized signature value is missing')
        const insertion = signatureSlot.insertionPoints.find(point => point.requestId === requestId && point.batchItemIndex === index)
        if (!insertion) throw new Error('Finalized signature insertion is missing')
        let reconstructed: EVCBatchItem
        if (signatureSlot.kind === 'permit2') {
          const message = signatureSlot.typedData.message
          if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Permit2 typed-data message is malformed')
          reconstructed = sdk.executionService.encodePermit2Call({
            chainId: signatureSlot.chainId,
            owner: signatureSlot.signer,
            message: message as Record<string, unknown>,
            signature: value.signature,
          })
        }
        else {
          if (!sdk.executionService.encodeMigrationAuthorizationCall) throw new Error('SDK migration authorization encoder is unavailable')
          reconstructed = sdk.executionService.encodeMigrationAuthorizationCall({
            chainId: signatureSlot.chainId,
            signer: signatureSlot.signer,
            typedDataHash: signatureSlot.typedDataHash,
            abiArgumentPath: insertion.abiArgumentPath,
            reviewedItem: expected,
            signature: value.signature,
          })
        }
        if (canonicalDigest('finalized-signature-item-v1', toCanonicalValue(item)) !== canonicalDigest('finalized-signature-item-v1', toCanonicalValue(reconstructed))) {
          throw new Error('Finalized signature item differs outside its declared ABI slot')
        }
      }
      if (pythSlot) {
        if (!dynamicValues) throw new Error('Pyth values are required to verify a finalized dynamic request')
        const value = dynamicValues.pythValues.find(candidate => candidate.slotId === pythSlot.slotId)
        if (!value) throw new Error('Finalized Pyth value is missing')
        if (item.data.slice(0, 10).toLowerCase() !== pythSlot.selector.toLowerCase()) throw new Error('Finalized Pyth selector changed')
        if (item.value > pythSlot.maxValue) throw new Error('Finalized Pyth value exceeds its bound')
        const reconstructed: EVCBatchItem = {
          targetContract: value.target,
          onBehalfOfAccount: value.onBehalfOfAccount,
          data: value.data,
          value: value.value,
        }
        if (canonicalDigest('finalized-pyth-item-v1', toCanonicalValue(item)) !== canonicalDigest('finalized-pyth-item-v1', toCanonicalValue(reconstructed))) {
          throw new Error('Finalized Pyth item differs from its verified refresh value')
        }
      }
      actualItems[index] = expected
    }
    const data = sdk.executionService.encodeBatch(actualItems)
    if (data !== sealed.data) throw new Error('Normalized dynamic request does not match the reviewed request')
    return { ...actual, data: sealed.data, value: sealed.value }
  })

  if (canonicalDigest('normalized-request-vector-v1', toCanonicalValue(normalized)) !== canonicalDigest('normalized-request-vector-v1', toCanonicalValue(template.requests))) {
    throw new Error('Finalized artifact differs outside declared slots')
  }
}
