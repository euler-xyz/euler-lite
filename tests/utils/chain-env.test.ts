import { describe, expect, it } from 'vitest'
import { getChainEnvIssues, getConfiguredChainIds, getEnabledChainIds } from '~/utils/chain-env'

describe('chain-env', () => {
  it('keeps valid configured chain IDs separate from AppKit-supported enabled chain IDs', () => {
    const env = {
      RPC_URL_1: 'https://example.com/mainnet',
      RPC_URL_923: 'https://example.com/unknown',
      RPC_URL_42161: 'https://example.com/arbitrum',
    }

    expect(getConfiguredChainIds(env)).toEqual([1, 923, 42161])
    expect(getEnabledChainIds(env)).toEqual([1, 42161])
  })

  it('does not enable empty or malformed RPC URL env vars', () => {
    const env = {
      RPC_URL_1: '',
      RPC_URL_56: 'not-a-url',
      RPC_URL_42161: 'https://example.com/arbitrum',
    }

    expect(getConfiguredChainIds(env)).toEqual([42161])
    expect(getEnabledChainIds(env)).toEqual([42161])
    expect(getChainEnvIssues(env)).toMatchObject({
      emptyRpcUrlChainIds: [1],
      malformedRpcUrlChainIds: [56],
    })
  })
})
