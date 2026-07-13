import type {
  ActivityCategory,
  ActivityCoverage,
  ActivityEvent,
  ActivityEventsMeta,
  ActivityVaultType,
} from '@eulerxyz/euler-v2-sdk'
import type { Address } from 'viem'
import {
  computed,
  onScopeDispose,
  ref,
  shallowRef,
  toValue,
  watch,
  type MaybeRefOrGetter,
} from 'vue'
import { subscribeToSdkQueryInvalidations } from '~/utils/sdk-query-cache'
import { ACTIVITY_QUERY_STALE_TIME_MS } from '~/utils/sdk-query-policy'

export type ActivityFeedScope
  = | { kind: 'account', owner: Address, chainId: number | readonly number[] }
    | { kind: 'vault', vault: Address, chainId: number, vaultType: ActivityVaultType }

interface UseActivityFeedOptions {
  scope: MaybeRefOrGetter<ActivityFeedScope>
  enabled: MaybeRefOrGetter<boolean>
  categories: MaybeRefOrGetter<readonly ActivityCategory[]>
  limit?: number
}

type ActivityLoadMode = 'initial' | 'refresh' | 'append'

const normalizedCategories = (categories: readonly ActivityCategory[]): ActivityCategory[] =>
  [...new Set(categories)].sort()

const scopeSdkChainId = (scope: ActivityFeedScope): number =>
  typeof scope.chainId === 'number' ? scope.chainId : (scope.chainId[0] ?? 0)

export const buildActivityFeedContextKey = (
  scope: ActivityFeedScope,
  categories: readonly ActivityCategory[],
): string => {
  const categoryKey = normalizedCategories(categories).join(',') || 'all'
  if (scope.kind === 'account') {
    const chainKey = typeof scope.chainId === 'number'
      ? String(scope.chainId)
      : [...scope.chainId].sort((left, right) => left - right).join(',')
    return `account:${scope.owner.toLowerCase()}:${chainKey}:${categoryKey}`
  }
  return `vault:${scope.vaultType}:${scope.chainId}:${scope.vault.toLowerCase()}:${categoryKey}`
}

export const mergeActivityEvents = (
  current: readonly ActivityEvent[],
  incoming: readonly ActivityEvent[],
): ActivityEvent[] => {
  const seen = new Set<string>()
  return [...current, ...incoming].filter((event) => {
    if (seen.has(event.id)) return false
    seen.add(event.id)
    return true
  })
}

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error))

export const useActivityFeed = ({
  scope,
  enabled,
  categories,
  limit = 25,
}: UseActivityFeedOptions) => {
  const events = shallowRef<ActivityEvent[]>([])
  const meta = shallowRef<ActivityEventsMeta>()
  const error = shallowRef<Error>()
  const loadMoreError = shallowRef<Error>()
  const hasLoaded = ref(false)
  const isLoading = ref(false)
  const isRefreshing = ref(false)
  const isLoadingMore = ref(false)
  let activeRequestId = 0
  let lastHeadLoadedAt: number | undefined
  let pendingInvalidationRefresh = false
  let pendingResumeRefresh = false

  const contextKey = computed(() =>
    buildActivityFeedContextKey(toValue(scope), toValue(categories)),
  )
  const isEnabled = computed(() => Boolean(toValue(enabled)))
  const coverage = computed<ActivityCoverage | undefined>(() => meta.value?.coverage)
  const hasMore = computed(() => Boolean(meta.value?.hasMore && meta.value.nextCursor))
  const isPartial = computed(() => coverage.value?.status === 'partial')
  const isSyncing = computed(() => coverage.value?.status === 'syncing')
  const isUnsupported = computed(() => coverage.value?.status === 'unsupported')
  const hasColdError = computed(() => Boolean(error.value && events.value.length === 0))
  const hasStaleError = computed(() => Boolean(error.value && events.value.length > 0))
  const isEmpty = computed(() =>
    hasLoaded.value
    && !error.value
    && !isUnsupported.value
    && !isSyncing.value
    && events.value.length === 0,
  )

  const resetForContext = () => {
    events.value = []
    meta.value = undefined
    error.value = undefined
    loadMoreError.value = undefined
    hasLoaded.value = false
    isLoading.value = false
    isRefreshing.value = false
    isLoadingMore.value = false
    lastHeadLoadedAt = undefined
    pendingInvalidationRefresh = false
    pendingResumeRefresh = false
  }

  const isHeadStale = () =>
    lastHeadLoadedAt !== undefined
    && Date.now() - lastHeadLoadedAt >= ACTIVITY_QUERY_STALE_TIME_MS

  const fetchPage = async (mode: ActivityLoadMode) => {
    if (!isEnabled.value) return
    if (isLoading.value || isRefreshing.value || isLoadingMore.value) return
    if (mode === 'append' && !hasMore.value) return

    const requestId = ++activeRequestId
    const requestContext = contextKey.value
    const requestScope = toValue(scope)
    const requestCategories = normalizedCategories(toValue(categories))
    const cursor = mode === 'append' ? meta.value?.nextCursor ?? undefined : undefined
    const coldRequest = mode === 'initial' || events.value.length === 0
    if (mode !== 'append') {
      pendingInvalidationRefresh = false
      pendingResumeRefresh = false
    }

    if (mode === 'append') {
      isLoadingMore.value = true
      loadMoreError.value = undefined
    }
    else if (coldRequest) {
      isLoading.value = true
      error.value = undefined
    }
    else {
      isRefreshing.value = true
      error.value = undefined
    }

    try {
      const { getEulerSdkForChain } = useEulerSdk()
      const sdk = await getEulerSdkForChain(scopeSdkChainId(requestScope))
      const common = {
        ...(requestCategories.length ? { categories: requestCategories } : {}),
        ...(cursor ? { cursor } : {}),
        limit,
      }
      const page = requestScope.kind === 'account'
        ? await sdk.activityService.fetchAccountActivityEvents({
            owner: requestScope.owner,
            chainId: requestScope.chainId,
            ...common,
          })
        : await sdk.activityService.fetchVaultActivityEvents({
            vault: requestScope.vault,
            chainId: requestScope.chainId,
            vaultType: requestScope.vaultType,
            ...common,
          })

      if (requestId !== activeRequestId || requestContext !== contextKey.value || !isEnabled.value) return
      if (mode === 'append' && page.meta.hasMore && page.meta.nextCursor === cursor) {
        throw new Error('Activity pagination cursor did not advance')
      }

      events.value = mode === 'append'
        ? mergeActivityEvents(events.value, page.data)
        : mergeActivityEvents([], page.data)
      meta.value = page.meta
      error.value = undefined
      loadMoreError.value = undefined
      hasLoaded.value = true
      if (mode !== 'append') lastHeadLoadedAt = Date.now()
    }
    catch (caught) {
      if (requestId !== activeRequestId || requestContext !== contextKey.value || !isEnabled.value) return
      if (mode === 'append') loadMoreError.value = asError(caught)
      else error.value = asError(caught)
      hasLoaded.value = true
    }
    finally {
      if (requestId === activeRequestId) {
        isLoading.value = false
        isRefreshing.value = false
        isLoadingMore.value = false
        if (pendingInvalidationRefresh && isEnabled.value && hasLoaded.value) {
          void fetchPage('refresh')
        }
      }
    }
  }

  const refresh = () => fetchPage('refresh')
  const loadMore = () => fetchPage('append')

  const unsubscribeFromInvalidations = subscribeToSdkQueryInvalidations((queryNames) => {
    const queryName = toValue(scope).kind === 'account'
      ? 'queryAccountActivityEvents'
      : 'queryVaultActivityEvents'
    if (!queryNames.has(queryName)) return

    pendingInvalidationRefresh = true
    if (isEnabled.value && hasLoaded.value) void fetchPage('refresh')
  })

  watch([contextKey, isEnabled], ([nextContext, nextEnabled], previous) => {
    const previousContext = previous?.[0]
    const previousEnabled = previous?.[1] ?? false
    const contextChanged = previousContext === undefined || previousContext !== nextContext

    if (contextChanged) {
      activeRequestId++
      resetForContext()
    }
    if (!nextEnabled) {
      if (isLoading.value || isRefreshing.value) pendingResumeRefresh = true
      activeRequestId++
      isLoading.value = false
      isRefreshing.value = false
      isLoadingMore.value = false
      return
    }
    if (contextChanged || !hasLoaded.value) {
      void fetchPage('initial')
    }
    else if (
      !previousEnabled
      && (pendingInvalidationRefresh || pendingResumeRefresh || isHeadStale() || hasColdError.value)
    ) {
      void fetchPage('refresh')
    }
  }, { immediate: true })

  onScopeDispose(() => {
    activeRequestId++
    unsubscribeFromInvalidations()
  })

  return {
    coverage,
    error,
    events,
    hasColdError,
    hasLoaded,
    hasMore,
    hasStaleError,
    isEmpty,
    isLoading,
    isLoadingMore,
    isPartial,
    isRefreshing,
    isSyncing,
    isUnsupported,
    loadMore,
    loadMoreError,
    meta,
    refresh,
  }
}
