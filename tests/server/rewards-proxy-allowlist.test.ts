import { describe, expect, it } from 'vitest'
import {
  isAllowedFuulClaimChecksBody,
  isAllowedFuulProxyRequest,
  isAllowedIncentraProxyRequest,
  isAllowedMerklProxyRequest,
} from '~/server/utils/rewards-proxy-allowlist'

const ACCOUNT = '0x0000000000000000000000000000000000000001'

const params = (query = '') =>
  new URL(`https://app.example/${query ? `?${query}` : ''}`).searchParams

describe('rewards proxy allowlists', () => {
  it('allows only the SDK-owned Fuul URL and body shapes', () => {
    expect(isAllowedFuulProxyRequest('GET', 'incentives', params('protocol=euler&chain_id=1'))).toBe(true)
    expect(isAllowedFuulProxyRequest('GET', 'incentives', params('protocol=euler-looping&chain_id=1'))).toBe(true)
    expect(isAllowedFuulProxyRequest('HEAD', 'totals', params(`user_identifier=${ACCOUNT}&user_identifier_type=evm_address`))).toBe(true)
    expect(isAllowedFuulProxyRequest('POST', 'claim-checks', params())).toBe(true)
    expect(isAllowedFuulClaimChecksBody(JSON.stringify({
      userIdentifier: ACCOUNT,
      userIdentifierType: 'evm_address',
    }))).toBe(true)

    expect(isAllowedFuulProxyRequest('GET', 'rewards', params('chain_id=1'))).toBe(false)
    expect(isAllowedFuulProxyRequest('GET', 'incentives', params('protocol=other&chain_id=1'))).toBe(false)
    expect(isAllowedFuulProxyRequest('GET', 'incentives', params('protocol=euler&chain_id=1&debug=true'))).toBe(false)
    expect(isAllowedFuulProxyRequest('GET', 'claim-checks', params())).toBe(false)
    expect(isAllowedFuulClaimChecksBody(JSON.stringify({
      userIdentifier: ACCOUNT,
      userIdentifierType: 'evm_address',
      debug: true,
    }))).toBe(false)
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
})
