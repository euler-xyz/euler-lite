import { ref, watch, onUnmounted, type Ref } from 'vue'
import {
  type CowSwapOrderStatus,
  type CowSwapOrderUid,
  COWSWAP_ORDER_POLL_INTERVAL_MS,
  COWSWAP_ORDER_POLL_MAX_DURATION_MS,
  fetchCowSwapOrderStatus,
} from '~/entities/cowswap'
import { logWarn } from '~/utils/errorHandling'

export const useCowSwapOrderStatus = (
  orderUid: Ref<CowSwapOrderUid | undefined>,
  orderbookUrl: Ref<string | undefined>,
) => {
  const orderStatus = ref<CowSwapOrderStatus | null>(null)
  const isPolling = ref(false)

  let pollTimer: ReturnType<typeof setInterval> | null = null
  let pollStartTime = 0

  const stopPolling = () => {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    isPolling.value = false
  }

  const poll = async () => {
    const uid = orderUid.value
    const url = orderbookUrl.value
    if (!uid || !url) {
      stopPolling()
      return
    }

    if (Date.now() - pollStartTime > COWSWAP_ORDER_POLL_MAX_DURATION_MS) {
      stopPolling()
      return
    }

    try {
      const result = await fetchCowSwapOrderStatus(uid, url)
      orderStatus.value = result

      if (result.terminal) {
        stopPolling()
      }
    }
    catch (err) {
      logWarn('cowswap/orderStatus', err)
    }
  }

  const startPolling = () => {
    stopPolling()
    orderStatus.value = null
    pollStartTime = Date.now()
    isPolling.value = true

    void poll()
    pollTimer = setInterval(() => void poll(), COWSWAP_ORDER_POLL_INTERVAL_MS)
  }

  watch(
    () => [orderUid.value, orderbookUrl.value] as const,
    ([uid, url]) => {
      if (uid && url) {
        startPolling()
      }
      else {
        stopPolling()
        orderStatus.value = null
      }
    },
    { immediate: true },
  )

  onUnmounted(stopPolling)

  return {
    orderStatus,
    isPolling,
    stopPolling,
  }
}
