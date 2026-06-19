import { shallowRef, computed } from 'vue'

// Plan-transformer guards used to live here; TOS and Keyring now run as
// SDK-side EulerPlugins. The registry retains the blocker side (used by
// VaultFormSubmit to gate the submit button) and per-concern metadata
// (used by tx-errors to annotate keyring-credential-cost failures).

const blockers = shallowRef<Map<string, string>>(new Map())
const metadata = shallowRef<Map<string, Record<string, unknown>>>(new Map())

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
