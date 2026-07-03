import { describe, expect, it } from 'vitest'
import { shouldForceNoStoreForPath } from '~/server/plugins/sensitive-route-cache'

describe('shouldForceNoStoreForPath', () => {
  it.each([
    '/api/proxy/fuul/claimable-rewards',
    '/api/proxy/fuul/claimable-rewards/',
    '/api/proxy/incentra/v1/getMerkleProofsBatch',
    '/api/proxy/incentra/v1/getMerkleProofsBatch/',
    '/api/proxy/merkl/users/0x0000000000000000000000000000000000000000/rewards',
    '/api/proxy/merkl/users/0x0000000000000000000000000000000000000000/rewards/',
    '/api/proxy/subgraph/1',
    '/api/proxy/subgraph/1/',
    '/api/proxy/turtle/streams/merkle_proofs',
    '/api/proxy/turtle/streams/merkle_proofs/',
  ])('forces no-store for sensitive path %s', (pathname) => {
    expect(shouldForceNoStoreForPath(pathname)).toBe(true)
  })

  it.each([
    '/api/proxy/merkl/opportunities',
    '/api/proxy/fuul/incentives',
    '/api/proxy/incentra/sdk/v1/eulerCampaigns',
    '/api/proxy/intrinsic-apy-overrides',
  ])('leaves public cache path %s to route rules', (pathname) => {
    expect(shouldForceNoStoreForPath(pathname)).toBe(false)
  })
})
