import { describe, expect, it } from 'vitest'
import {
  isAllowedFuulProxyRequest,
  isAllowedIncentraProxyRequest,
  isAllowedMerklProxyRequest,
  isAllowedTurtleProxyRequest,
} from '~/server/utils/rewards-proxy-allowlist'

const ACCOUNT = '0x0000000000000000000000000000000000000001'

const params = (query = '') =>
  new URL(`https://app.example/${query ? `?${query}` : ''}`).searchParams

describe('rewards proxy allowlists', () => {
  it('allows only the SDK-owned Fuul URL shapes', () => {
    expect(isAllowedFuulProxyRequest('GET', 'incentives', params('protocol=euler&chain_id=1'))).toBe(true)
    expect(isAllowedFuulProxyRequest('GET', 'incentives', params('protocol=euler-looping&chain_id=1'))).toBe(true)
    expect(isAllowedFuulProxyRequest('GET', 'claimable-rewards', params(`protocol=euler&user_address=${ACCOUNT}&chain_id=1`))).toBe(true)

    expect(isAllowedFuulProxyRequest('GET', 'rewards', params('chain_id=1'))).toBe(false)
    expect(isAllowedFuulProxyRequest('GET', 'incentives', params('protocol=other&chain_id=1'))).toBe(false)
    expect(isAllowedFuulProxyRequest('GET', 'incentives', params('protocol=euler&chain_id=1&debug=true'))).toBe(false)
    expect(isAllowedFuulProxyRequest('GET', 'claimable-rewards', params(`protocol=euler&user_address=${ACCOUNT}&chain_id=1&debug=true`))).toBe(false)
    expect(isAllowedFuulProxyRequest('GET', 'claimable-rewards', params(`protocol=euler-looping&user_address=${ACCOUNT}&chain_id=1`))).toBe(false)
    expect(isAllowedFuulProxyRequest('HEAD', 'totals', params(`user_identifier=${ACCOUNT}&user_identifier_type=evm_address`))).toBe(false)
    expect(isAllowedFuulProxyRequest('POST', 'claim-checks', params())).toBe(false)
    expect(isAllowedFuulProxyRequest('GET', 'claim-checks', params())).toBe(false)
  })

  it('allows only the two Incentra POST endpoints used by the SDK', () => {
    expect(isAllowedIncentraProxyRequest('POST', 'sdk/v1/eulerCampaigns', params())).toBe(true)
    expect(isAllowedIncentraProxyRequest('POST', 'v1/getMerkleProofsBatch', params())).toBe(true)

    expect(isAllowedIncentraProxyRequest('GET', 'sdk/v1/eulerCampaigns', params())).toBe(false)
    expect(isAllowedIncentraProxyRequest('POST', 'sdk/v1/admin', params())).toBe(false)
    expect(isAllowedIncentraProxyRequest('POST', 'sdk/v1/eulerCampaigns', params('debug=true'))).toBe(false)
  })

  it('allows only Merkl opportunities and user rewards requests used by the SDK', () => {
    expect(isAllowedMerklProxyRequest('GET', 'opportunities/', params('chainId=1&type=EULER&campaigns=true'))).toBe(true)
    expect(isAllowedMerklProxyRequest('GET', 'opportunities/', params('chainId=1&type=MULTILENDBORROW&campaigns=true'))).toBe(true)
    expect(isAllowedMerklProxyRequest('GET', 'opportunities/', params('chainId=1&mainProtocolId=euler&campaigns=true&type=ERC20LOGPROCESSOR'))).toBe(true)
    expect(isAllowedMerklProxyRequest('HEAD', `users/${ACCOUNT}/rewards`, params('chainId=1'))).toBe(true)
    expect(isAllowedMerklProxyRequest('GET', `users/${ACCOUNT}/rewards`, params('chainId=1&type=TOKEN'))).toBe(true)

    expect(isAllowedMerklProxyRequest('GET', 'campaigns', params('chainId=1'))).toBe(false)
    expect(isAllowedMerklProxyRequest('GET', 'opportunities/', params('chainId=1&type=ERC20LOGPROCESSOR&campaigns=true'))).toBe(false)
    expect(isAllowedMerklProxyRequest('GET', 'opportunities/', params('chainId=1&type=EULER&campaigns=true&mainProtocolId=euler'))).toBe(false)
    expect(isAllowedMerklProxyRequest('GET', 'opportunities/', params('chainId=1&type=EULER&campaigns=true&debug=true'))).toBe(false)
    expect(isAllowedMerklProxyRequest('GET', 'users/not-an-address/rewards', params('chainId=1'))).toBe(false)
    expect(isAllowedMerklProxyRequest('GET', `users/${ACCOUNT}/rewards`, params('chainId=1&type=POINTS'))).toBe(false)
  })

  it('allows only Turtle stream proof requests used by claim planning', () => {
    expect(isAllowedTurtleProxyRequest('GET', 'streams/merkle_proofs', params(`wallet=${ACCOUNT}&streamIds=stream-1`))).toBe(true)
    expect(isAllowedTurtleProxyRequest('HEAD', 'streams/merkle_proofs', params(`wallet=${ACCOUNT}&streamIds=stream-1,stream-2`))).toBe(true)

    expect(isAllowedTurtleProxyRequest('POST', 'streams/merkle_proofs', params(`wallet=${ACCOUNT}&streamIds=stream-1`))).toBe(false)
    expect(isAllowedTurtleProxyRequest('GET', 'streams', params(`wallet=${ACCOUNT}&streamIds=stream-1`))).toBe(false)
    expect(isAllowedTurtleProxyRequest('GET', 'streams/merkle_proofs', params(`wallet=not-an-address&streamIds=stream-1`))).toBe(false)
    expect(isAllowedTurtleProxyRequest('GET', 'streams/merkle_proofs', params(`wallet=${ACCOUNT}&streamIds=`))).toBe(false)
    expect(isAllowedTurtleProxyRequest('GET', 'streams/merkle_proofs', params(`wallet=${ACCOUNT}&streamIds=stream-1&debug=true`))).toBe(false)
  })
})
