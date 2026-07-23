import { effectScope } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityEvent } from '@eulerxyz/euler-v2-sdk'
import { useActivityLiquidationDetails } from '~/composables/useActivityLiquidationDetails'

const VAULT = '0xe0a80d35bB6618CBA260120b279d357978c42BCE'
const COLLATERAL = '0x61aAC438453d6e3513C0c8dbb69F13860E2B5028'
const VIOLATOR = '0x9f2a560CfA7616f53691a57404a9fFB50dA1e483'
const LIQUIDATOR = '0x356B4853c5aFEa804518Aceaa25885B38eceFc72'
const TX = `0x${'ab'.repeat(32)}`

const liquidationEvent = (overrides: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: 'v3-ponder:1:liquidation:1',
  chainId: 1,
  type: 'liquidation',
  rawType: 'liquidation',
  category: 'liquidations',
  timestamp: '2026-07-18T23:13:35.000Z',
  blockNumber: '25562800',
  logIndex: 1065,
  txHash: TX as ActivityEvent['txHash'],
  source: 'v3-ponder',
  vault: VAULT as ActivityEvent['vault'],
  payload: {
    violator: VIOLATOR.toLowerCase(),
    collateral: COLLATERAL.toLowerCase(),
    repay_assets: '724612',
    yield_balance: '812035276912150036',
  },
  ...overrides,
} as ActivityEvent)

const liquidationRecord = () => ({
  chainId: 1,
  vault: VAULT,
  violator: VIOLATOR,
  liquidator: LIQUIDATOR,
  collateral: COLLATERAL,
  repayAssets: '724612',
  yieldBalance: '812035276912150036',
  repayAssetsUsd: 0.72,
  bonusUsd: 0.13,
  valuation: { status: 'available' as const },
  blockNumber: '25562800',
  txHash: TX,
  timestamp: '2026-07-18T23:13:35.000Z',
})

const inScope = <T>(setup: () => T): T => {
  const scope = effectScope()
  return scope.run(setup) as T
}

describe('useActivityLiquidationDetails', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('stays inert against an SDK without the liquidations surface', async () => {
    // Contract test for the pinned package: the published SDK release does
    // not expose fetchLiquidations, so enrichment must silently no-op —
    // no throw, no lookup, no enrichment.
    const activityService = {}
    vi.stubGlobal('useEulerSdk', () => ({
      getEulerSdkForChain: vi.fn(async () => ({ activityService })),
    }))

    const event = liquidationEvent()
    const details = inScope(() => useActivityLiquidationDetails({
      events: () => [event],
    }))

    // Give the (settled) fetch pipeline a beat to run.
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(details.getLiquidationDetails(event)).toBeUndefined()
  })

  it('fetches per chain+vault window and joins records to their events', async () => {
    const fetchLiquidations = vi.fn(async () => ({
      data: [liquidationRecord()],
      meta: { total: 1, offset: 0, limit: 100, timestamp: '2026-07-23T00:00:00.000Z' },
    }))
    vi.stubGlobal('useEulerSdk', () => ({
      getEulerSdkForChain: vi.fn(async () => ({ activityService: { fetchLiquidations } })),
    }))

    const event = liquidationEvent()
    const details = inScope(() => useActivityLiquidationDetails({
      events: () => [event],
    }))

    await vi.waitFor(() =>
      expect(details.getLiquidationDetails(event)).toMatchObject({ bonusUsd: 0.13 }))

    const eventUnix = Math.floor(Date.parse(event.timestamp) / 1000)
    expect(fetchLiquidations).toHaveBeenCalledTimes(1)
    expect(fetchLiquidations).toHaveBeenCalledWith({
      chainId: 1,
      vault: VAULT,
      from: eventUnix - 1,
      to: eventUnix + 1,
      limit: 100,
      offset: 0,
    })

    // Non-liquidation events never resolve details.
    expect(details.getLiquidationDetails(
      liquidationEvent({ type: 'deposit', category: 'lending' } as Partial<ActivityEvent>),
    )).toBeUndefined()
  })

  it('leaves rows unenriched when the lookup fails', async () => {
    const fetchLiquidations = vi.fn(async () => {
      throw new Error('upstream down')
    })
    vi.stubGlobal('useEulerSdk', () => ({
      getEulerSdkForChain: vi.fn(async () => ({ activityService: { fetchLiquidations } })),
    }))

    const event = liquidationEvent()
    const details = inScope(() => useActivityLiquidationDetails({
      events: () => [event],
    }))

    await vi.waitFor(() => expect(fetchLiquidations).toHaveBeenCalled())
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(details.getLiquidationDetails(event)).toBeUndefined()
  })
})
