import { getAddress } from 'viem'
import { nextTick, onBeforeUnmount, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { BATCH_SCROLL_SUB_ACCOUNT_QUERY, BATCH_SCROLL_VAULT_QUERY } from '~/composables/useBatchRedirect'

// Generous retry budget: some targets only render once the batch resimulation
// finishes (e.g. the owner deposit a position-close moves collateral into).
const MAX_SCROLL_ATTEMPTS = 50
const SCROLL_RETRY_MS = 100

const getTargetAddress = (value: unknown): string | undefined => {
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
    const {
      [BATCH_SCROLL_SUB_ACCOUNT_QUERY]: _target,
      [BATCH_SCROLL_VAULT_QUERY]: _vault,
      ...query
    } = route.query
    router.replace({ query })
  }

  const tryScroll = async (attempt = 0) => {
    if (!import.meta.client) return
    const subAccount = getTargetAddress(route.query[BATCH_SCROLL_SUB_ACCOUNT_QUERY])
    if (!subAccount) {
      // Query cleared — forget the last target so a later add pointing at the
      // same position (common on the savings list, where most deposits share
      // the owner sub-account) scrolls again.
      lastScrolledTarget = undefined
      return
    }
    const vault = getTargetAddress(route.query[BATCH_SCROLL_VAULT_QUERY])
    const target = `${subAccount}:${vault ?? ''}`
    if (target === lastScrolledTarget) return

    await nextTick()
    const vaultSelector = vault ? `[data-vault-address="${vault}"]` : ''
    const el = document.querySelector<HTMLElement>(
      `[data-id="portfolio-list-item"][data-sub-account="${subAccount}"]${vaultSelector}`,
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
    () => [
      route.query[BATCH_SCROLL_SUB_ACCOUNT_QUERY],
      route.query[BATCH_SCROLL_VAULT_QUERY],
      toValue(renderKey),
    ],
    () => {
      void tryScroll()
    },
    { immediate: true, flush: 'post' },
  )

  onBeforeUnmount(clearRetry)
}
