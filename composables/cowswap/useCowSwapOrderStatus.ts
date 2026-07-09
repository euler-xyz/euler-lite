import { onUnmounted, ref, watch, type Ref } from 'vue'
import {
  COWSWAP_ORDER_POLL_INTERVAL_MS,
  COWSWAP_ORDER_POLL_MAX_DURATION_MS,
  type CowSwapOrderStatus,
  type CowSwapOrderUid,
  fetchCowSwapOrderStatus,
} from '~/entities/cowswap'
import { logWarn } from '~/utils/errorHandling'

export const useCowSwapOrderStatus = (
  orderUid: Ref<CowSwapOrderUid | undefined>,
  chainId: Ref<number | undefined>,
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
    const cid = chainId.value
    if (!uid || !cid) {
      stopPolling()
      return
    }

    if (Date.now() - pollStartTime > COWSWAP_ORDER_POLL_MAX_DURATION_MS) {
      stopPolling()
      return
    }

    try {
      const result = await fetchCowSwapOrderStatus({ orderUid: uid, chainId: cid })
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
    () => [orderUid.value, chainId.value] as const,
    ([uid, cid]) => {
      if (uid && cid) {
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
