import { getAddress, type Hex } from 'viem'
import type { TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'

export interface PreparedPlanSignatureSubstitution {
  placeholder: Hex
  signature: Hex
}

const PLAN_DRIFT_ERROR = 'The transaction plan changed after review. Reopen review and try again.'

const stripHexPrefix = (value: Hex): string => value.slice(2).toLowerCase()

type SignaturePattern = {
  reviewed: string
  resolved: string
}

type SignatureSubstitutionGroup = {
  expected: number
  patterns: readonly SignaturePattern[]
}

const signatureWord = (value: number): string => value.toString(16).padStart(64, '0')

const splitSignature = (signature: Hex): { r: string, s: string, v: number } => {
  const bytes = stripHexPrefix(signature)
  if (bytes.length !== 130) throw new Error(PLAN_DRIFT_ERROR)
  let v = Number.parseInt(bytes.slice(128, 130), 16)
  if (!Number.isFinite(v)) throw new Error(PLAN_DRIFT_ERROR)
  if (v < 27) v += 27
  return {
    r: bytes.slice(0, 64),
    s: bytes.slice(64, 128),
    v,
  }
}

const buildSignaturePatterns = (placeholder: Hex, signature: Hex): SignaturePattern[] => {
  const reviewedBytes = stripHexPrefix(placeholder)
  const resolvedBytes = stripHexPrefix(signature)
  const reviewed = splitSignature(placeholder)
  const resolved = splitSignature(signature)
  return [
    // Some authorizations retain the ordinary 65-byte signature.
    { reviewed: reviewedBytes, resolved: resolvedBytes },
    // Aave, Morpho, and MetaMorpho encode the signature as ABI v/r/s words.
    {
      reviewed: `${signatureWord(reviewed.v)}${reviewed.r}${reviewed.s}`,
      resolved: `${signatureWord(resolved.v)}${resolved.r}${resolved.s}`,
    },
  ]
}

const assertValueParity = (
  reviewed: unknown,
  resolved: unknown,
  substitutions: ReadonlyMap<string, SignatureSubstitutionGroup>,
  observed: Map<string, number>,
): void => {
  if (typeof reviewed === 'string' && typeof resolved === 'string') {
    const normalizedReviewed = reviewed.startsWith('0x') ? reviewed.toLowerCase() : reviewed
    let normalizedResolved = resolved.startsWith('0x') ? resolved.toLowerCase() : resolved
    if (normalizedReviewed === normalizedResolved) return
    if (normalizedReviewed.startsWith('0x') && normalizedResolved.startsWith('0x')) {
      for (const [signature, substitution] of substitutions) {
        for (const pattern of substitution.patterns) {
          let searchFrom = 2
          while (true) {
            const index = normalizedResolved.indexOf(pattern.resolved, searchFrom)
            if (index < 0) break
            if (normalizedReviewed.slice(index, index + pattern.reviewed.length) === pattern.reviewed) {
              normalizedResolved = `${normalizedResolved.slice(0, index)}${pattern.reviewed}${normalizedResolved.slice(index + pattern.resolved.length)}`
              observed.set(signature, (observed.get(signature) ?? 0) + 1)
            }
            searchFrom = index + pattern.resolved.length
          }
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
 * signature representation, either raw bytes or ABI-encoded v/r/s words. The
 * complete prepared envelope remains unchanged, including targets, values,
 * call order, plugins, and resolved approvals.
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

  const bySignature = new Map<string, SignatureSubstitutionGroup>()
  for (const { placeholder, signature } of substitutions) {
    const signatureBytes = stripHexPrefix(signature)
    const placeholderBytes = stripHexPrefix(placeholder)
    if (!signatureBytes || signatureBytes === placeholderBytes) throw new Error(PLAN_DRIFT_ERROR)
    const existing = bySignature.get(signatureBytes)
    const patterns = buildSignaturePatterns(placeholder, signature)
    if (existing && existing.patterns.some((pattern, index) => pattern.reviewed !== patterns[index]?.reviewed)) {
      throw new Error(PLAN_DRIFT_ERROR)
    }
    bySignature.set(signatureBytes, {
      expected: (existing?.expected ?? 0) + 1,
      patterns,
    })
  }

  const observed = new Map<string, number>()
  assertValueParity(reviewed.plan, resolved.plan, bySignature, observed)
  for (const [signature, substitution] of bySignature) {
    if ((observed.get(signature) ?? 0) !== substitution.expected) throw new Error(PLAN_DRIFT_ERROR)
  }
}
