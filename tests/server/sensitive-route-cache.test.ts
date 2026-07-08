import { describe, expect, it } from 'vitest'
import { shouldForceNoStoreForPath } from '~/server/plugins/sensitive-route-cache'

describe('shouldForceNoStoreForPath', () => {
  it.each([
    '/api/internal/proxy/fuul/claimable-rewards',
    '/api/internal/proxy/fuul/claimable-rewards/',
    '/api/internal/proxy/incentra/v1/getMerkleProofsBatch',
    '/api/internal/proxy/incentra/v1/getMerkleProofsBatch/',
    '/api/internal/proxy/merkl/users/0x0000000000000000000000000000000000000000/rewards',
    '/api/internal/proxy/merkl/users/0x0000000000000000000000000000000000000000/rewards/',
    '/api/internal/proxy/subgraph/1',
    '/api/internal/proxy/subgraph/1/',
    '/api/internal/proxy/turtle/streams/merkle_proofs',
    '/api/internal/proxy/turtle/streams/merkle_proofs/',
  ])('forces no-store for sensitive path %s', (pathname) => {
    expect(shouldForceNoStoreForPath(pathname)).toBe(true)
  })

  it.each([
    '/api/internal/proxy/merkl/opportunities',
    '/api/internal/proxy/fuul/incentives',
    '/api/internal/proxy/incentra/sdk/v1/eulerCampaigns',
    '/api/internal/proxy/intrinsic-apy-overrides',
  ])('leaves cacheable path %s to route rules', (pathname) => {
    expect(shouldForceNoStoreForPath(pathname)).toBe(false)
  })
})
