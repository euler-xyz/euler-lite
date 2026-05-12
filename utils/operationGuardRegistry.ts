import { shallowRef, computed } from 'vue'
import type { TxPlan } from '~/entities/txPlan'

export type PlanTransformer = (plan: TxPlan) => TxPlan

interface GuardEntry {
  transform: PlanTransformer
  priority: number
}

const guards = shallowRef<Map<string, GuardEntry>>(new Map())
const blockers = shallowRef<Map<string, string>>(new Map())
const metadata = shallowRef<Map<string, Record<string, unknown>>>(new Map())

export const registerOperationGuard = (key: string, transform: PlanTransformer, meta?: Record<string, unknown>) => {
  const priority = meta?.priority as number ?? 50
  const next = new Map(guards.value)
  next.set(key, { transform, priority })
  guards.value = next
  if (meta) {
    const nextMeta = new Map(metadata.value)
    nextMeta.set(key, meta)
    metadata.value = nextMeta
  }
}

export const unregisterOperationGuard = (key: string) => {
  const next = new Map(guards.value)
  next.delete(key)
  guards.value = next
  const nextMeta = new Map(metadata.value)
  nextMeta.delete(key)
  metadata.value = nextMeta
}

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

/** Reactive: true when any guard is blocking operations (e.g. keyring verification pending) */
export const isOperationBlocked = computed(() => blockers.value.size > 0)

/** Reactive: reason string from the first active blocker */
export const operationBlockReason = computed(() => {
  const first = blockers.value.values().next()
  return first.done ? undefined : first.value
})

/** Throw when any operation blocker is active. Used by final execution paths. */
export const assertOperationNotBlocked = (): void => {
  if (isOperationBlocked.value) {
    throw new Error(operationBlockReason.value ?? 'Operation blocked')
  }
}

/** Reactive: true when a guard with the given key is registered */
export const hasGuard = (key: string) => computed(() => guards.value.has(key))

/** Reactive: metadata for a guard by key */
export const getGuardMeta = (key: string) => computed(() => metadata.value.get(key))

/** Apply all registered guard transformers in priority order (lower = first) */
export const applyOperationGuards = (plan: TxPlan): TxPlan => {
  const sorted = [...guards.value.values()].sort((a, b) => a.priority - b.priority)
  let result = plan
  for (const { transform } of sorted) {
    result = transform(result)
  }
  return result
}
