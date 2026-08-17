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

type OrderedSubstitution = {
  patterns: readonly SignaturePattern[]
}

/**
 * Consumption cursor into the ordered substitution list. Each reviewed
 * placeholder occurrence, in deterministic traversal order, must be replaced
 * by exactly the next substitution — two identical placeholders can never
 * swap their signatures between call locations.
 */
type SubstitutionCursor = {
  next: number
}

/**
 * Find the queued substitution's pattern covering the first differing
 * character. The window must reproduce the reviewed placeholder bytes on the
 * reviewed side and the resolved signature bytes on the resolved side.
 */
const matchSubstitutionAt = (
  reviewed: string,
  resolved: string,
  patterns: readonly SignaturePattern[],
  diffIndex: number,
): number | undefined => {
  for (const pattern of patterns) {
    const length = pattern.resolved.length
    let from = Math.max(2, diffIndex - length + 1)
    while (from <= diffIndex) {
      const start = resolved.indexOf(pattern.resolved, from)
      if (start < 0 || start > diffIndex) break
      if (reviewed.startsWith(pattern.reviewed, start)) return start + length
      from = start + 1
    }
  }
  return undefined
}

const assertStringParity = (
  reviewed: string,
  resolved: string,
  substitutions: readonly OrderedSubstitution[],
  cursor: SubstitutionCursor,
): void => {
  const normalizedReviewed = reviewed.startsWith('0x') ? reviewed.toLowerCase() : reviewed
  const normalizedResolved = resolved.startsWith('0x') ? resolved.toLowerCase() : resolved
  if (normalizedReviewed === normalizedResolved) return
  if (
    !normalizedReviewed.startsWith('0x')
    || !normalizedResolved.startsWith('0x')
    // Both permitted representations replace like-for-like byte ranges, so any
    // legitimate substitution preserves the string length.
    || normalizedReviewed.length !== normalizedResolved.length
  ) {
    throw new Error(PLAN_DRIFT_ERROR)
  }
  let index = 2
  while (index < normalizedReviewed.length) {
    if (normalizedReviewed[index] === normalizedResolved[index]) {
      index++
      continue
    }
    const substitution = substitutions[cursor.next]
    if (!substitution) throw new Error(PLAN_DRIFT_ERROR)
    const end = matchSubstitutionAt(normalizedReviewed, normalizedResolved, substitution.patterns, index)
    if (end === undefined) throw new Error(PLAN_DRIFT_ERROR)
    cursor.next++
    index = end
  }
}

const assertValueParity = (
  reviewed: unknown,
  resolved: unknown,
  substitutions: readonly OrderedSubstitution[],
  cursor: SubstitutionCursor,
): void => {
  if (typeof reviewed === 'string' && typeof resolved === 'string') {
    assertStringParity(reviewed, resolved, substitutions, cursor)
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
      assertValueParity(item, resolved[index], substitutions, cursor)
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
    assertValueParity(reviewedRecord[key], resolvedRecord[key], substitutions, cursor)
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
 *
 * `substitutions` is positional: its order must match the order in which the
 * reviewed plan carries the placeholder occurrences (entry order, then each
 * entry's primary authorization before its post-migration one). The k-th
 * occurrence is only ever replaced by the k-th signature — signatures
 * authorizing different typed-data messages cannot be transposed between
 * structurally identical placeholder sites.
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

  const ordered: OrderedSubstitution[] = substitutions.map(({ placeholder, signature }) => {
    const signatureBytes = stripHexPrefix(signature)
    if (!signatureBytes || signatureBytes === stripHexPrefix(placeholder)) throw new Error(PLAN_DRIFT_ERROR)
    return { patterns: buildSignaturePatterns(placeholder, signature) }
  })

  const cursor: SubstitutionCursor = { next: 0 }
  assertValueParity(reviewed.plan, resolved.plan, ordered, cursor)
  if (cursor.next !== ordered.length) throw new Error(PLAN_DRIFT_ERROR)
}
