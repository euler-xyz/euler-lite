import { createPublicClient, http, type PublicClient } from 'viem'

const clientCache = new Map<string, PublicClient>()

const DEFAULT_BATCH_SIZE = 100
// Ankr's free public endpoints (`https://rpc.ankr.com/<chain>` with no API
// key in the path) reject JSON-RPC arrays of 11+ with `code: -32062`,
// `message: "Batch size too large"`, which collapses every concurrent
// readContract in the burst at once. Premium URLs carry an API key as an
// extra path segment and are unaffected, so clamp only on the free shape.
const ANKR_PUBLIC_BATCH_SIZE = 10

export const isPublicAnkrRpcUrl = (rpcUrl: string): boolean => {
  try {
    const u = new URL(rpcUrl)
    if (u.host !== 'rpc.ankr.com') return false
    return u.pathname.split('/').filter(Boolean).length === 1
  }
  catch {
    return false
  }
}

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
        batchSize: isPublicAnkrRpcUrl(rpcUrl) ? ANKR_PUBLIC_BATCH_SIZE : DEFAULT_BATCH_SIZE,
        wait: 100,
      },
    }),
  })

  clientCache.set(rpcUrl, client)
  return client
}
