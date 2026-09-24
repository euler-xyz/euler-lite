import type { LocationQueryRaw } from 'vue-router'
import type { Ref } from 'vue'
import { resolveUrlQueryValue } from '~/utils/url-query-alias'

interface UrlSyncParam {
  ref: Ref<string> | Ref<string[]>
  default: string | string[]
  queryKey: string
  /** Former names of the parameter, still read from saved links; only `queryKey` is written. */
  legacyKeys?: string[]
}

export function useUrlQuerySync(params: UrlSyncParam[]): void {
  const route = useRoute()
  const router = useRouter()

  const managedKeys = new Set(params.flatMap(p => [p.queryKey, ...(p.legacyKeys ?? [])]))
  let isSyncing = false
  const isActive = ref(true)
  let legacyKeyInUrl = false

  onActivated(() => {
    isActive.value = true
  })
  onDeactivated(() => {
    isActive.value = false
  })

  // Read URL → refs on init
  for (const param of params) {
    const { legacyPresent, value: queryValue } = resolveUrlQueryValue(route.query, param.queryKey, param.legacyKeys)
    if (legacyPresent) legacyKeyInUrl = true
    if (queryValue === undefined) continue

    if (Array.isArray(param.default)) {
      const arr = Array.isArray(queryValue) ? queryValue : [queryValue]
      ;(param.ref as Ref<string[]>).value = arr.filter((v): v is string => typeof v === 'string')
    }
    else {
      ;(param.ref as Ref<string>).value = typeof queryValue === 'string' ? queryValue : String(queryValue)
    }
  }

  const buildQuery = (): LocationQueryRaw => {
    const query: LocationQueryRaw = {}

    // Preserve query params not managed by this sync
    for (const [key, value] of Object.entries(route.query)) {
      if (!managedKeys.has(key)) {
        query[key] = value
      }
    }

    // Add non-default managed params
    for (const param of params) {
      const value = param.ref.value
      const isDefault = Array.isArray(param.default)
        ? Array.isArray(value) && value.length === 0
        : value === param.default

      if (!isDefault) {
        query[param.queryKey] = value
      }
    }

    return query
  }

  const syncRefsToUrl = async () => {
    if (isSyncing || !isActive.value) return
    isSyncing = true
    try {
      await router.replace({ query: buildQuery() })
    }
    finally {
      isSyncing = false
    }
  }

  // A link that carries a former parameter name is rewritten without it.
  if (legacyKeyInUrl) nextTick(syncRefsToUrl)

  // Watch refs → update URL
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  watch(
    params.map(p => p.ref),
    () => {
      if (isSyncing || !isActive.value) return
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(syncRefsToUrl, 50)
    },
    { deep: true },
  )

  // When something external changes route.query (e.g. syncRouteNetwork),
  // re-apply our params on top instead of resetting refs
  watch(
    () => route.query,
    () => {
      if (isSyncing || !isActive.value) return

      // Cancel any pending debounced sync — the route just changed externally,
      // so a stale debounced sync could overwrite non-managed params (e.g. network)
      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }

      // Check if any managed param in the URL doesn't match its ref
      const needsSync = params.some((param) => {
        const { legacyPresent, value: queryValue } = resolveUrlQueryValue(route.query, param.queryKey, param.legacyKeys)
        if (legacyPresent) return true
        const refValue = param.ref.value

        if (Array.isArray(param.default)) {
          const refArr = refValue as string[]
          const queryArr = queryValue === undefined
            ? []
            : Array.isArray(queryValue) ? queryValue : [queryValue]
          return JSON.stringify(refArr) !== JSON.stringify(queryArr.filter((v): v is string => typeof v === 'string'))
        }

        const queryStr = queryValue === undefined ? undefined : (typeof queryValue === 'string' ? queryValue : String(queryValue))
        const isDefault = refValue === param.default
        // Ref is at default and URL has no value → in sync
        if (isDefault && queryStr === undefined) return false
        // Ref is at default but URL has a value → stale URL param needs removal
        if (isDefault && queryStr !== undefined) return true
        // Ref is non-default → URL must match
        return queryStr !== refValue
      })

      if (needsSync) {
        nextTick(syncRefsToUrl)
      }
    },
  )
}
