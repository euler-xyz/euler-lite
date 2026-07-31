import { onScopeDispose, readonly, ref } from 'vue'

export const ACTIVITY_CLOCK_INTERVAL_MS = 60_000

export const useActivityNowMs = () => {
  const nowMs = ref(Date.now())
  if (typeof window === 'undefined') return readonly(nowMs)

  const interval = window.setInterval(() => {
    nowMs.value = Date.now()
  }, ACTIVITY_CLOCK_INTERVAL_MS)
  onScopeDispose(() => window.clearInterval(interval))

  return readonly(nowMs)
}
