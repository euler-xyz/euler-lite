import { describe, expect, it } from 'vitest'
import { omitQueryKeys, rewriteLegacyPath } from '~/utils/legacy-route-rewrites'

describe('legacy route rewrites', () => {
  it('rewrites legacy market links to explore market links', () => {
    expect(rewriteLegacyPath('/market/sentora-ondo')).toEqual({
      path: '/explore/sentora-ondo',
      dropQueryKeys: ['tab'],
    })
  })

  it('removes legacy market tab query params without dropping unrelated params', () => {
    expect(omitQueryKeys({
      network: '1',
      tab: 'positions',
      spy: '0x123',
    }, ['tab'])).toEqual({
      network: '1',
      spy: '0x123',
    })
  })

  it('keeps existing legacy vault rewrites intact', () => {
    expect(rewriteLegacyPath('/vault/0xVault')).toEqual({
      path: '/lend/0xVault',
      dropQueryKeys: undefined,
    })
    expect(rewriteLegacyPath('/positions/12')).toEqual({
      path: '/borrow/12',
      dropQueryKeys: undefined,
    })
    expect(rewriteLegacyPath('/account/3')).toEqual({
      path: '/position/3',
      dropQueryKeys: undefined,
    })
  })

  it('does not rewrite current routes', () => {
    expect(rewriteLegacyPath('/explore/sentora-ondo')).toBeNull()
  })
})
