import { getAddress, type Hex } from 'viem'
import type { TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'

export interface PreparedPlanSignatureSubstitution {
  placeholder: Hex
  signature: Hex
}

const PLAN_DRIFT_ERROR = 'The transaction plan changed after review. Reopen review and try again.'

const stripHexPrefix = (value: Hex): string => value.slice(2).toLowerCase()

const assertValueParity = (
  reviewed: unknown,
  resolved: unknown,
  substitutions: ReadonlyMap<string, { placeholder: string, expected: number }>,
  observed: Map<string, number>,
): void => {
  if (typeof reviewed === 'string' && typeof resolved === 'string') {
    const normalizedReviewed = reviewed.startsWith('0x') ? reviewed.toLowerCase() : reviewed
    let normalizedResolved = resolved.startsWith('0x') ? resolved.toLowerCase() : resolved
    if (normalizedReviewed === normalizedResolved) return
    if (normalizedReviewed.startsWith('0x') && normalizedResolved.startsWith('0x')) {
      for (const [signature, substitution] of substitutions) {
        let searchFrom = 2
        while (true) {
          const index = normalizedResolved.indexOf(signature, searchFrom)
          if (index < 0) break
          if (normalizedReviewed.slice(index, index + substitution.placeholder.length) === substitution.placeholder) {
            normalizedResolved = `${normalizedResolved.slice(0, index)}${substitution.placeholder}${normalizedResolved.slice(index + signature.length)}`
            observed.set(signature, (observed.get(signature) ?? 0) + 1)
          }
          searchFrom = index + signature.length
        }
      }
    }
    if (normalizedReviewed !== normalizedResolved) throw new Error(PLAN_DRIFT_ERROR)
    return
  }
  if (
    reviewed === null
    || resolved === null
    || typeof reviewed !== 'object'
    || typeof resolved !== 'object'
  ) {
    if (reviewed !== resolved) throw new Error(PLAN_DRIFT_ERROR)
    return
  }
  if (Array.isArray(reviewed) || Array.isArray(resolved)) {
    if (!Array.isArray(reviewed) || !Array.isArray(resolved) || reviewed.length !== resolved.length) {
      throw new Error(PLAN_DRIFT_ERROR)
    }
    reviewed.forEach((item, index) => {
      assertValueParity(item, resolved[index], substitutions, observed)
    })
    return
  }
  const reviewedRecord = reviewed as Record<string, unknown>
  const resolvedRecord = resolved as Record<string, unknown>
  const reviewedKeys = Object.keys(reviewedRecord).sort()
  const resolvedKeys = Object.keys(resolvedRecord).sort()
  if (reviewedKeys.length !== resolvedKeys.length || reviewedKeys.some((key, index) => key !== resolvedKeys[index])) {
    throw new Error(PLAN_DRIFT_ERROR)
  }
  for (const key of reviewedKeys) {
    assertValueParity(reviewedRecord[key], resolvedRecord[key], substitutions, observed)
  }
}

const preparedAccountKey = (prepared: TransactionPlanPrepared): string => {
  const account = prepared.account
  return typeof account === 'string'
    ? getAddress(account)
    : `${account.chainId}:${getAddress(account.owner)}`
}

/**
 * Confirm-time migration plans may replace only the reviewed placeholder
 * signature bytes. The complete prepared envelope remains unchanged, including
 * targets, values, call order, plugins, and resolved approvals.
 */
export const assertPreparedPlanSignatureParity = ({
  reviewed,
  resolved,
  substitutions,
}: {
  reviewed: TransactionPlanPrepared
  resolved: TransactionPlanPrepared
  substitutions: readonly PreparedPlanSignatureSubstitution[]
}): void => {
  if (
    reviewed.chainId !== resolved.chainId
    || preparedAccountKey(reviewed) !== preparedAccountKey(resolved)
    || reviewed.usePermit2 !== resolved.usePermit2
    || reviewed.unlimitedApproval !== resolved.unlimitedApproval
  ) {
    throw new Error(PLAN_DRIFT_ERROR)
  }

  const bySignature = new Map<string, { placeholder: string, expected: number }>()
  for (const { placeholder, signature } of substitutions) {
    const signatureBytes = stripHexPrefix(signature)
    const placeholderBytes = stripHexPrefix(placeholder)
    if (!signatureBytes || signatureBytes === placeholderBytes) throw new Error(PLAN_DRIFT_ERROR)
    const existing = bySignature.get(signatureBytes)
    if (existing && existing.placeholder !== placeholderBytes) throw new Error(PLAN_DRIFT_ERROR)
    bySignature.set(signatureBytes, {
      placeholder: placeholderBytes,
      expected: (existing?.expected ?? 0) + 1,
    })
  }

  const observed = new Map<string, number>()
  assertValueParity(reviewed.plan, resolved.plan, bySignature, observed)
  for (const [signature, substitution] of bySignature) {
    if ((observed.get(signature) ?? 0) !== substitution.expected) throw new Error(PLAN_DRIFT_ERROR)
  }
}
