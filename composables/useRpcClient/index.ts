import { computed } from 'vue'
import type { ComputedRef } from 'vue'
import type { PublicClient } from 'viem'
import { getPublicClient } from '~/utils/public-client'

export const useRpcClient = (): {
  rpcUrl: ComputedRef<string>
  client: ComputedRef<PublicClient | null>
} => {
  const { chainId } = useEulerAddresses()

  const rpcUrl = computed(() => {
    if (!chainId.value) return ''
    if (import.meta.server) {
      const requestUrl = useRequestURL()
      return `${requestUrl.origin}/api/internal/rpc/${chainId.value}`
    }
    return `/api/internal/rpc/${chainId.value}`
  })

  const client = computed(() => {
    const url = rpcUrl.value
    if (!url) return null
    return getPublicClient(url)
  })

  return { rpcUrl, client }
}
