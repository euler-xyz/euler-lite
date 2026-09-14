import { getAddress, hashTypedData, type Address, type Hash, type Hex } from 'viem'
import type { EVCBatchItem, Permit2DataToSign, TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { canonicalDigest, toCanonicalValue } from '../domain/canonical'
import type { SignatureInsertion, SignatureSlot } from '../domain/reviewed-execution'

const PLACEHOLDER_SIGNATURE = `0x${'00'.repeat(65)}` as Hex

export interface Permit2TypedData {
  domain: Record<string, unknown>
  types: Record<string, readonly { name: string, type: string }[]>
  primaryType: string
  message: Record<string, unknown>
}

export interface Permit2ResolutionSdk {
  executionService: {
    getPermit2TypedData: (args: {
      chainId: number
      token: Address
      amount: bigint
      spender: Address
      nonce: number
      sigDeadline?: bigint
      expiration?: number
    }) => Permit2TypedData
    encodePermit2Call: (args: {
      chainId: number
      owner: Address
      message: Record<string, unknown>
      signature: Hex
    }) => EVCBatchItem
  }
}

export interface PreparedPermit2Slot {
  slotId: Hash
  planItemIndex: number
  resolvedIndex: number
  approval: Permit2DataToSign
  signer: Address
  chainId: number
  nonce: number
  validUntil: number
  typedData: Permit2TypedData
  typedDataHash: Hash
  placeholderBatchItem: EVCBatchItem
}

export interface PreparedMigrationSignatureSlot {
  planItemIndex: number
  batchItemIndex: number
  signer: Address
  chainId: number
  typedData: Permit2TypedData
  typedDataHash: Hash
  validUntil?: number
  /** ABI-aware path interpreted only by the public SDK encoder. */
  abiArgumentPath: readonly (string | number)[]
}

export const prepareMigrationSignatureEvidence = ({
  planItemIndex,
  batchItemIndex,
  signer,
  chainId,
  typedData,
  validUntil,
  abiArgumentPath,
}: Omit<PreparedMigrationSignatureSlot, 'signer' | 'typedDataHash'> & { signer: Address }): Readonly<PreparedMigrationSignatureSlot> => {
  if (!Number.isSafeInteger(planItemIndex) || planItemIndex < 0 || !Number.isSafeInteger(batchItemIndex) || batchItemIndex < 0) {
    throw new Error('Migration signature coordinates are invalid')
  }
  if (!abiArgumentPath.length) throw new Error('Migration signature slot has no ABI argument path')
  const normalizedSigner = getAddress(signer)
  return {
    planItemIndex,
    batchItemIndex,
    signer: normalizedSigner,
    chainId,
    typedData,
    typedDataHash: hashTypedData(typedData as Parameters<typeof hashTypedData>[0]),
    ...(validUntil === undefined ? {} : { validUntil }),
    abiArgumentPath: [...abiArgumentPath],
  }
}

export const preparePermit2Slots = async ({
  plan,
  chainId,
  sdk,
  readNonce,
  nowSeconds,
}: {
  plan: TransactionPlan
  chainId: number
  sdk: Permit2ResolutionSdk
  readNonce: (approval: Permit2DataToSign) => Promise<number>
  nowSeconds?: number
}): Promise<PreparedPermit2Slot[]> => {
  const slots: PreparedPermit2Slot[] = []
  const pinnedNow = nowSeconds ?? Math.floor(Date.now() / 1000)
  if (!Number.isSafeInteger(pinnedNow) || pinnedNow < 0) throw new Error('Permit2 materialization time is invalid')
  const expiration = pinnedNow + 3600
  const pinnedSigDeadline = BigInt(expiration)

  for (const [planItemIndex, item] of plan.entries()) {
    if (item.type !== 'requiredApproval') continue
    if (!item.resolved) throw new Error(`Approval at plan item ${planItemIndex} is unresolved`)

    for (const [resolvedIndex, resolved] of item.resolved.entries()) {
      if (resolved.type !== 'permit2') continue
      const nonce = await readNonce(resolved)
      if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('Permit2 nonce is invalid')
      const signer = getAddress(resolved.owner)
      const typedData = sdk.executionService.getPermit2TypedData({
        chainId,
        token: getAddress(resolved.token),
        amount: resolved.amount,
        spender: getAddress(resolved.spender),
        nonce,
        sigDeadline: pinnedSigDeadline,
        expiration,
      })
      const typedDataHash = hashTypedData(typedData as Parameters<typeof hashTypedData>[0])
      const typedSigDeadline = typedData.message.sigDeadline
      const validUntil = typeof typedSigDeadline === 'bigint'
        ? Number(typedSigDeadline)
        : typeof typedSigDeadline === 'number' ? typedSigDeadline : Number(typedSigDeadline)
      if (!Number.isSafeInteger(validUntil) || validUntil <= 0) throw new Error('Permit2 signature deadline is invalid')
      const slotId = canonicalDigest('signature-slot-v1', toCanonicalValue({
        kind: 'permit2',
        signer,
        chainId,
        typedDataHash,
        planItemIndex,
        resolvedIndex,
      }))

      slots.push({
        slotId,
        planItemIndex,
        resolvedIndex,
        approval: resolved,
        signer,
        chainId,
        nonce,
        validUntil,
        typedData,
        typedDataHash,
        placeholderBatchItem: sdk.executionService.encodePermit2Call({
          chainId,
          owner: signer,
          message: typedData.message,
          signature: PLACEHOLDER_SIGNATURE,
        }),
      })
    }
  }

  return slots
}

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is malformed`)
  return value as Record<string, unknown>
}

const asBigInt = (value: unknown, label: string): bigint => {
  if (typeof value === 'bigint') return value
  if ((typeof value === 'number' && Number.isSafeInteger(value)) || (typeof value === 'string' && /^\d+$/.test(value))) return BigInt(value)
  throw new Error(`${label} is malformed`)
}

export interface Permit2NonceCoordinate {
  owner: Address
  token: Address
  spender: Address
  permit2: Address
  nonce: bigint
}

/** Extract and cross-check the exact on-chain nonce coordinate sealed in Permit2 typed data. */
export const permit2NonceCoordinate = (slot: SignatureSlot): Permit2NonceCoordinate => {
  if (slot.kind !== 'permit2' || slot.nonce === undefined) throw new Error('Signature slot is not a complete Permit2 slot')
  if (slot.typedData.primaryType !== 'PermitSingle') throw new Error('Permit2 typed data has an unexpected primary type')
  const domain = asRecord(slot.typedData.domain, 'Permit2 domain')
  const message = asRecord(slot.typedData.message, 'Permit2 message')
  const details = asRecord(message.details, 'Permit2 details')
  const nonce = asBigInt(details.nonce, 'Permit2 nonce')
  if (nonce !== slot.nonce) throw new Error('Permit2 typed-data nonce does not match its sealed slot')
  const domainChainId = asBigInt(domain.chainId, 'Permit2 domain chain')
  if (domainChainId !== BigInt(slot.chainId)) throw new Error('Permit2 typed-data chain does not match its sealed slot')
  return {
    owner: getAddress(slot.signer),
    token: getAddress(String(details.token)),
    spender: getAddress(String(message.spender)),
    permit2: getAddress(String(domain.verifyingContract)),
    nonce,
  }
}

export const assertPermit2NonceCurrent = async (
  slot: SignatureSlot,
  readNonce: (coordinate: Permit2NonceCoordinate) => Promise<bigint>,
): Promise<Permit2NonceCoordinate> => {
  const coordinate = permit2NonceCoordinate(slot)
  const current = await readNonce(coordinate)
  if (current !== coordinate.nonce) throw new Error('Permit2 nonce changed after review')
  return coordinate
}

export const prepareMigrationSignatureSlot = ({
  signer,
  chainId,
  typedData,
  validUntil,
  insertionPoints,
}: {
  signer: Address
  chainId: number
  typedData: Permit2TypedData
  validUntil?: number
  insertionPoints: readonly SignatureInsertion[]
}): Readonly<SignatureSlot> => {
  if (!insertionPoints.length) throw new Error('Migration signature slot has no ABI insertion point')
  const normalizedSigner = getAddress(signer)
  const typedDataHash = hashTypedData(typedData as Parameters<typeof hashTypedData>[0])
  const slotId = canonicalDigest('signature-slot-v1', toCanonicalValue({
    kind: 'migration', signer: normalizedSigner, chainId, typedDataHash, validUntil, insertionPoints,
  }))
  return {
    slotId,
    kind: 'migration',
    signer: normalizedSigner,
    chainId,
    typedData: toCanonicalValue(typedData) as SignatureSlot['typedData'],
    typedDataHash,
    ...(validUntil === undefined ? {} : { validUntil }),
    insertionPoints: insertionPoints.map(point => ({ ...point, abiArgumentPath: [...point.abiArgumentPath] })),
  }
}
