import { describe, expect, it } from 'vitest'
import { buildV3ProxyBackoffKey } from '~/server/utils/v3-proxy-backoff'

const ACCOUNT = '0x0000000000000000000000000000000000000001'
const OTHER_ACCOUNT = '0x0000000000000000000000000000000000000002'
const VAULT = '0x0000000000000000000000000000000000000003'
const OTHER_VAULT = '0x0000000000000000000000000000000000000004'

describe('activity V3 proxy backoff keys', () => {
  it('does not key account cooldowns by wallet address', () => {
    const params = new URLSearchParams({
      chainId: '1',
      from: '1782380000',
      to: '1782984800',
      category: 'lending,borrowing',
      cursor: 'private-opaque-cursor',
      limit: '25',
    })

    const first = buildV3ProxyBackoffKey('GET', `/v3/activity/accounts/${ACCOUNT}/events`, params)
    const second = buildV3ProxyBackoffKey('GET', `/v3/activity/accounts/${OTHER_ACCOUNT}/events`, params)

    expect(first).toBe(second)
    expect(first).toBe('GET /v3/activity/accounts/:owner/events?chainId=1&from=1782380000&to=1782984800&category=lending%2Cborrowing')
    expect(first).not.toContain(ACCOUNT)
    expect(first).not.toContain('private-opaque-cursor')
  })

  it('keeps account cooldowns scoped to chain and time window', () => {
    const first = buildV3ProxyBackoffKey(
      'GET',
      `/v3/activity/accounts/${ACCOUNT}/events`,
      new URLSearchParams({ chainId: '1', from: '100', to: '200' }),
    )
    const otherWindow = buildV3ProxyBackoffKey(
      'GET',
      `/v3/activity/accounts/${ACCOUNT}/events`,
      new URLSearchParams({ chainId: '1', from: '200', to: '300' }),
    )
    const otherChain = buildV3ProxyBackoffKey(
      'GET',
      `/v3/activity/accounts/${ACCOUNT}/events`,
      new URLSearchParams({ chainId: '8453', from: '100', to: '200' }),
    )

    expect(first).not.toBe(otherWindow)
    expect(first).not.toBe(otherChain)
  })

  it('omits unbounded activity context values', () => {
    const key = buildV3ProxyBackoffKey(
      'GET',
      `/v3/activity/accounts/${ACCOUNT}/events`,
      new URLSearchParams({
        chainId: '1'.repeat(300),
        from: '1'.repeat(17),
        category: 'a'.repeat(300),
      }),
    )

    expect(key).toBe('GET /v3/activity/accounts/:owner/events')
  })

  it('normalizes public vault addresses while preserving kind and chain context', () => {
    const params = new URLSearchParams({ vaultType: 'earn', category: 'governance' })
    const first = buildV3ProxyBackoffKey('GET', `/v3/activity/vaults/1/${VAULT}/events`, params)
    const second = buildV3ProxyBackoffKey('GET', `/v3/activity/vaults/1/${OTHER_VAULT}/events`, params)
    const otherChain = buildV3ProxyBackoffKey('GET', `/v3/activity/vaults/8453/${VAULT}/events`, params)

    expect(first).toBe(second)
    expect(first).toBe('GET /v3/activity/vaults/1/:vault/events?vaultType=earn&category=governance')
    expect(first).not.toBe(otherChain)
    expect(first).not.toContain(VAULT)
  })
})
