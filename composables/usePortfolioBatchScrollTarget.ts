import { getAddress } from 'viem'
import { nextTick, onBeforeUnmount, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { BATCH_SCROLL_SUB_ACCOUNT_QUERY } from '~/composables/useBatchRedirect'

const MAX_SCROLL_ATTEMPTS = 20
const SCROLL_RETRY_MS = 100

const getTargetSubAccount = (value: unknown): string | undefined => {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string' || !raw) return undefined
  try {
    return getAddress(raw).toLowerCase()
  }
  catch {
    return undefined
  }
}

export const usePortfolioBatchScrollTarget = (renderKey: MaybeRefOrGetter<unknown>) => {
  const route = useRoute()
  const router = useRouter()
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let lastScrolledTarget: string | undefined

  const clearRetry = () => {
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
  }

  const clearScrollQuery = () => {
    const { [BATCH_SCROLL_SUB_ACCOUNT_QUERY]: _target, ...query } = route.query
    router.replace({ query })
  }

  const tryScroll = async (attempt = 0) => {
    if (!import.meta.client) return
    const target = getTargetSubAccount(route.query[BATCH_SCROLL_SUB_ACCOUNT_QUERY])
    if (!target || target === lastScrolledTarget) return

    await nextTick()
    const el = document.querySelector<HTMLElement>(
      `[data-id="portfolio-list-item"][data-sub-account="${target}"]`,
    )

    if (el) {
      lastScrolledTarget = target
      clearRetry()
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      clearScrollQuery()
      return
    }

    if (attempt < MAX_SCROLL_ATTEMPTS) {
      clearRetry()
      retryTimer = setTimeout(() => {
        void tryScroll(attempt + 1)
      }, SCROLL_RETRY_MS)
    }
  }

  watch(
    () => [route.query[BATCH_SCROLL_SUB_ACCOUNT_QUERY], toValue(renderKey)],
    () => {
      void tryScroll()
    },
    { immediate: true, flush: 'post' },
  )

  onBeforeUnmount(clearRetry)
}
