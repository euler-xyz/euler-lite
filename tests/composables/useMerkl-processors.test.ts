/**
 * Unit test for the EULER_BORROW_FROM_COLLATERAL /
 * EULER_MULTI_BORROW_FROM_COLLATERAL processor in useMerkl.
 *
 * Fixture mirrors a trimmed slice of the live Merkl opportunity
 * `f8f41d9ced97a082` on mainnet: two vaults, 7 + 1 collaterals → 8 emitted
 * RewardCampaign rows under the existing `euler_borrow_collateral` type.
 *
 * Also covers the defensive flat-shape fallback used if
 * EULER_BORROW_FROM_COLLATERAL ever ships with `params.evkAddress` +
 * `params.collateralAddress` instead of `params.vaults[]`.
 */
import { describe, expect, it } from 'vitest'
import { processBorrowFromCollateralOpportunities } from '~/composables/useMerkl'
import type { Opportunity } from '~/entities/merkl'

const farFutureTimestamp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30

const makeOpportunity = (overrides: Partial<Opportunity>): Opportunity => ({
  chainId: 1,
  chain: { name: 'Ethereum' },
  type: 'EULER_MULTI_BORROW_FROM_COLLATERAL',
  identifier: 'f8f41d9ced97a082',
  name: 'test',
  description: 'test',
  howToSteps: [],
  status: 'LIVE',
  action: 'BORROW',
  tvl: 0,
  apr: 0,
  dailyRewards: 0,
  tags: [],
  id: 'opp-1',
  depositUrl: '',
  explorerAddress: '',
  lastCampaignCreatedAt: 0,
  tokens: [],
  aprRecord: { cumulated: 0, timestamp: '0', breakdowns: [] },
  tvlRecord: { id: '', total: 0, timestamp: '0', breakdowns: [] },
  rewardsRecord: { id: '', total: 0, timestamp: '0', breakdowns: [] },
  campaigns: [],
  ...overrides,
})

const makeCampaign = (overrides: Partial<Opportunity['campaigns'][number]>): Opportunity['campaigns'][number] => ({
  id: 'c1',
  computeChainId: 1,
  distributionChainId: 1,
  campaignId: '0xfae08964',
  type: 'EULER_MULTI_BORROW_FROM_COLLATERAL',
  distributionType: 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE',
  subType: 0,
  rewardTokenId: 'rt',
  amount: '0',
  opportunityId: 'opp-1',
  startTimestamp: 0,
  endTimestamp: farFutureTimestamp,
  dailyRewards: 0,
  apr: 1.5,
  creatorAddress: '0x0',
  rewardToken: {
    id: 'rt',
    name: 'AglaMerkl',
    chainId: 1,
    address: '0x3e0ae4c19c3bdfc9eed5a2898d3a57c6f61e847a',
    decimals: 18,
    icon: 'icon.png',
    verified: true,
    isTest: true,
    type: 'TOKEN',
    isNative: false,
    price: 1,
    symbol: 'aglaMerklUSD',
  },
  campaignStatus: { campaignId: 'c1', computedUntil: 0, processingStarted: 0, status: 'OK', error: '' },
  createdAt: '0',
  ...overrides,
})

describe('processBorrowFromCollateralOpportunities', () => {
  it('fans out one campaign per (vault, collateral) pair from params.vaults[]', () => {
    const opportunity = makeOpportunity({
      campaigns: [
        makeCampaign({
          params: {
            whitelist: ['0x1111111111111111111111111111111111111111'],
            blacklist: ['0x2222222222222222222222222222222222222222'],
            vaults: [
              {
                evkAddress: '0x6Fe7Fa90756434645F0b0428fDff78E99Dda0FBc',
                collaterals: [
                  { tokenAddress: '0x35d4f830543700B7280084280ae3236f178E88e3' },
                  { tokenAddress: '0x55F9bACE2C864aC0D3392Ea9fa654b605F21A3d3' },
                  { tokenAddress: '0xb7522C867B8AFae5e89638b59fb38f31B0821795' },
                  { tokenAddress: '0x97C72647be549C6079dC95235271A9a0Fe7ECc21' },
                  { tokenAddress: '0x69a2fAD6AC96DDa502f7d240fB4EC88f85217705' },
                  { tokenAddress: '0x797DD80692c3b2dAdabCe8e30C07fDE5307D48a9' },
                  { tokenAddress: '0x313603FA690301b0CaeEf8069c065862f9162162' },
                ],
              },
              {
                evkAddress: '0x53208e965EB66841598fB8f983a41936EeE6d774',
                collaterals: [
                  { tokenAddress: '0xc1fF5490651B9B8d0400B0146E7fb174B90E315B' },
                ],
              },
            ],
          },
        }),
      ],
    })

    const map = processBorrowFromCollateralOpportunities([opportunity], 'EULER_MULTI_BORROW_FROM_COLLATERAL')

    // 7 collaterals + 1 collateral = 8 emitted campaigns under 2 vault keys.
    expect(map.size).toBe(2)
    const first = map.get('0x6fe7fa90756434645f0b0428fdff78e99dda0fbc')
    const second = map.get('0x53208e965eb66841598fb8f983a41936eee6d774')
    expect(first).toHaveLength(7)
    expect(second).toHaveLength(1)

    // Everything is lowercased and typed as the existing euler_borrow_collateral.
    for (const c of [...(first ?? []), ...(second ?? [])]) {
      expect(c.type).toBe('euler_borrow_collateral')
      expect(c.provider).toBe('merkl')
      expect(c.apr).toBe(1.5)
      expect(c.vault).toBe(c.vault.toLowerCase())
      expect(c.collateral).toBe(c.collateral?.toLowerCase())
      expect(c.whitelist).toEqual(['0x1111111111111111111111111111111111111111'])
      expect(c.blacklist).toEqual(['0x2222222222222222222222222222222222222222'])
    }

    expect(second?.[0].collateral).toBe('0xc1ff5490651b9b8d0400b0146e7fb174b90e315b')
  })

  it('falls back to the flat evkAddress + collateralAddress shape when vaults[] is absent', () => {
    const opportunity = makeOpportunity({
      type: 'EULER_BORROW_FROM_COLLATERAL',
      identifier: 'single-vault-test',
      campaigns: [
        makeCampaign({
          params: {
            evkAddress: '0x6Fe7Fa90756434645F0b0428fDff78E99Dda0FBc',
            collateralAddress: '0x35d4f830543700B7280084280ae3236f178E88e3',
          },
        }),
      ],
    })

    const map = processBorrowFromCollateralOpportunities([opportunity], 'EULER_BORROW_FROM_COLLATERAL')

    expect(map.size).toBe(1)
    const entries = map.get('0x6fe7fa90756434645f0b0428fdff78e99dda0fbc')
    expect(entries).toHaveLength(1)
    expect(entries?.[0].collateral).toBe('0x35d4f830543700b7280084280ae3236f178e88e3')
    expect(entries?.[0].type).toBe('euler_borrow_collateral')
  })

  it('drops opportunities that are not LIVE', () => {
    const opportunity = makeOpportunity({
      status: 'PAST',
      campaigns: [makeCampaign({
        params: { vaults: [{ evkAddress: '0xaaa', collaterals: [{ tokenAddress: '0xbbb' }] }] },
      })],
    })
    const map = processBorrowFromCollateralOpportunities([opportunity], 'EULER_MULTI_BORROW_FROM_COLLATERAL')
    expect(map.size).toBe(0)
  })

  it('drops active campaigns with no APR', () => {
    const opportunity = makeOpportunity({
      aprRecord: { cumulated: 0, timestamp: '0', breakdowns: [] },
      campaigns: [makeCampaign({
        apr: 0,
        params: { vaults: [{ evkAddress: '0xaaa', collaterals: [{ tokenAddress: '0xbbb' }] }] },
      })],
    })
    const map = processBorrowFromCollateralOpportunities([opportunity], 'EULER_MULTI_BORROW_FROM_COLLATERAL')
    expect(map.size).toBe(0)
  })

  it('prefers aprRecord breakdown over campaign.apr', () => {
    const opportunity = makeOpportunity({
      aprRecord: {
        cumulated: 0,
        timestamp: '0',
        breakdowns: [{
          distributionType: 'MAX_APR',
          identifier: '0xfae08964',
          type: 'CAMPAIGN',
          value: 7,
          timestamp: '0',
        }],
      },
      campaigns: [makeCampaign({
        apr: 1.5,
        params: { vaults: [{ evkAddress: '0xaaa', collaterals: [{ tokenAddress: '0xbbb' }] }] },
      })],
    })
    const map = processBorrowFromCollateralOpportunities([opportunity], 'EULER_MULTI_BORROW_FROM_COLLATERAL')
    const entry = map.get('0xaaa')
    expect(entry?.[0].apr).toBe(7)
  })
})
