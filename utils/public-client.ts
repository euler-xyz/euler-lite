import { createPublicClient, http, type PublicClient } from 'viem'

const clientCache = new Map<string, PublicClient>()

export const getPublicClient = (rpcUrl: string): PublicClient => {
  const cached = clientCache.get(rpcUrl)
  if (cached) {
    return cached
  }

  const client = createPublicClient({
    transport: http(rpcUrl, {
      // Disable viem's default 3× retry on 429/5xx. The proxy is reliable and
      // retries here amplify Cloudflare rate-limit bursts (1 failure → 4 requests).
      retryCount: 0,
      batch: {
        batchSize: 100,
        wait: 100,
      },
    }),
  })

  clientCache.set(rpcUrl, client)
  return client
}
