import { onScopeDispose, shallowRef, watch, type Ref } from 'vue'

const counts = new Map<string, number>()
const anchors = shallowRef<ReadonlySet<string>>(new Set())

const publish = () => {
  anchors.value = new Set([...counts.entries()].filter(([, count]) => count > 0).map(([id]) => id))
}

const add = (ids: readonly string[]) => {
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
  publish()
}

const remove = (ids: readonly string[]) => {
  for (const id of ids) {
    const next = (counts.get(id) ?? 0) - 1
    if (next > 0) counts.set(id, next)
    else counts.delete(id)
  }
  publish()
}

/** The Oracles section announces the adapter cards it renders, so a line elsewhere offers a link only to a card that exists on the page. */
export const registerOracleAdapterAnchors = (ids: Ref<readonly string[]>) => {
  let current: readonly string[] = []
  watch(ids, (next) => {
    remove(current)
    current = [...next]
    add(current)
  }, { immediate: true })
  onScopeDispose(() => {
    remove(current)
    current = []
  })
}

export const useOracleAdapterAnchors = () => ({
  hasAnchor: (id: string) => anchors.value.has(id),
})
