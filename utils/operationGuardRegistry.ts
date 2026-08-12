import { shallowRef, computed } from 'vue'

// Plan-transformer guards used to live here; TOS and Keyring now run as
// SDK-side EulerPlugins. The registry retains the blocker side (used by
// VaultFormSubmit to gate the submit button) and per-concern metadata
// (used by tx-errors to annotate keyring-credential-cost failures).

const blockers = shallowRef<Map<string, string>>(new Map())
const metadata = shallowRef<Map<string, Record<string, unknown>>>(new Map())

/** A live policy check captured by an operation before its page can unmount. */
export type OperationPolicyCheck = () => string | undefined

const policyChecks = shallowRef<Map<string, OperationPolicyCheck>>(new Map())

export const registerOperationBlocker = (key: string, reason: string) => {
  const next = new Map(blockers.value)
  next.set(key, reason)
  blockers.value = next
}

export const unregisterOperationBlocker = (key: string) => {
  const next = new Map(blockers.value)
  next.delete(key)
  blockers.value = next
}

export const registerOperationPolicyCheck = (key: string, check: OperationPolicyCheck) => {
  const next = new Map(policyChecks.value)
  next.set(key, check)
  policyChecks.value = next
}

export const unregisterOperationPolicyCheck = (key: string) => {
  const next = new Map(policyChecks.value)
  next.delete(key)
  policyChecks.value = next
}

/**
 * Capture callbacks rather than their current result. A batch entry or CoW
 * review can therefore re-evaluate the policy after its source form unmounts.
 */
export const captureOperationPolicyChecks = (): OperationPolicyCheck[] =>
  Array.from(policyChecks.value.values())

export const getOperationPolicyBlockReason = (
  checks: readonly OperationPolicyCheck[],
): string | undefined => {
  for (const check of checks) {
    const reason = check()
    if (reason) return reason
  }
  return undefined
}

export const assertOperationPolicyChecks = (checks: readonly OperationPolicyCheck[]) => {
  const reason = getOperationPolicyBlockReason(checks)
  if (reason) throw new Error(reason)
}

export const setOperationMeta = (key: string, meta: Record<string, unknown>) => {
  const next = new Map(metadata.value)
  next.set(key, meta)
  metadata.value = next
}

export const clearOperationMeta = (key: string) => {
  const next = new Map(metadata.value)
  next.delete(key)
  metadata.value = next
}

/** Reactive: true when any blocker is active (e.g. keyring verification pending). */
export const isOperationBlocked = computed(() => blockers.value.size > 0)

/** Reactive: active blocker entries, preserving registration order. */
export const operationBlockerEntries = computed(() => Array.from(blockers.value.entries()))

/** Reactive: reason string from the first active blocker. */
export const operationBlockReason = computed(() => {
  const first = blockers.value.values().next()
  return first.done ? undefined : first.value
})

/** Reactive: metadata for an operation concern (e.g. keyring credential cost). */
export const getOperationMeta = (key: string) => computed(() => metadata.value.get(key))
