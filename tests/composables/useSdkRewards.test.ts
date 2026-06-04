import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { UserReward } from '@eulerxyz/euler-v2-sdk'

const owner = '0x1000000000000000000000000000000000000000' as const

const importUseSdkRewards = async () => {
  vi.resetModules()

  const reward: UserReward = {
    chainId: 1,
    provider: 'merkl',
    token: {
      address: '0x2000000000000000000000000000000000000000',
      chainId: 1,
      symbol: 'EUL',
      name: 'EUL',
      decimals: 18,
    },
    tokenPrice: 1,
    accumulated: '100',
    unclaimed: '100',
    proof: [],
    claimAddress: '0x3000000000000000000000000000000000000000',
  }
  const turtleReward: UserReward = {
    ...reward,
    provider: 'turtle',
    campaignId: 'stream-1',
    streamAddress: '0x4000000000000000000000000000000000000000',
    timestamp: '2026-05-20T13:05:10Z',
  }
  const refreshAllPositions = vi.fn(async () => {})
  const invalidateSdkQueries = vi.fn(async () => {})
  const buildClaimPlan = vi.fn(async () => [{ type: 'contractCall' }])

  vi.doMock('~/utils/sdk-query-cache', () => ({
    invalidateSdkQueries,
  }))
  vi.stubGlobal('useEulerAccount', () => ({
    portfolio: ref({ account: { userRewards: [reward, turtleReward] } }),
    isPositionsLoading: ref(false),
    refreshAllPositions,
  }))
  vi.stubGlobal('useWagmi', () => ({
    address: ref(owner),
  }))
  vi.stubGlobal('useEulerSdk', () => ({
    getEulerSdk: vi.fn(async () => ({
      rewardsService: { buildClaimPlan },
    })),
  }))

  const module = await import('~/composables/useSdkRewards')
  return {
    ...module,
    buildClaimPlan,
    invalidateSdkQueries,
    refreshAllPositions,
    reward,
    turtleReward,
  }
}

describe('useSdkRewards', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('reads rewards from the SDK portfolio account', async () => {
    const { useSdkRewards, reward, turtleReward } = await importUseSdkRewards()

    const { rewards, isRewardsLoading } = useSdkRewards()

    expect(rewards.value).toEqual([reward, turtleReward])
    expect(isRewardsLoading.value).toBe(false)
  })

  it('uses SDK reward planning for SDK-owned providers', async () => {
    const { useSdkRewards, reward, buildClaimPlan } = await importUseSdkRewards()

    const { buildClaimRewardPlan } = useSdkRewards()
    await buildClaimRewardPlan(reward)

    expect(buildClaimPlan).toHaveBeenCalledWith({
      reward,
      account: owner,
    })
  })

  it('uses SDK reward planning for Turtle stream rewards', async () => {
    const { useSdkRewards, turtleReward, buildClaimPlan } = await importUseSdkRewards()

    const { buildClaimRewardPlan } = useSdkRewards()
    await buildClaimRewardPlan(turtleReward)

    expect(buildClaimPlan).toHaveBeenCalledWith({
      reward: turtleReward,
      account: owner,
    })
  })

  it('force-refreshes user reward queries before rebuilding the portfolio', async () => {
    const { useSdkRewards, invalidateSdkQueries, refreshAllPositions } = await importUseSdkRewards()

    const { refreshRewards } = useSdkRewards()
    await refreshRewards()

    expect(invalidateSdkQueries).toHaveBeenCalledWith([
      'queryMerklUserRewards',
      'queryBrevisCampaigns',
      'queryBrevisUserProofs',
      'queryFuulClaimableRewards',
      'queryTurtleMerkleProofs',
    ])
    expect(refreshAllPositions).toHaveBeenCalledWith(undefined, undefined, { source: 'fresh', preempt: true })
    expect(invalidateSdkQueries.mock.invocationCallOrder[0]).toBeLessThan(
      refreshAllPositions.mock.invocationCallOrder[0],
    )
  })

  it('can schedule a second reward-only refresh for provider lag after a claim transaction', async () => {
    vi.useFakeTimers()
    const { useSdkRewards, invalidateSdkQueries, refreshAllPositions } = await importUseSdkRewards()

    const { refreshRewards } = useSdkRewards()
    await refreshRewards({ delayedRetry: true })

    expect(invalidateSdkQueries).toHaveBeenCalledTimes(1)
    expect(refreshAllPositions).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(2)

    await vi.runOnlyPendingTimersAsync()
    expect(invalidateSdkQueries).toHaveBeenCalledTimes(3)
    expect(refreshAllPositions).toHaveBeenCalledTimes(3)
    expect(invalidateSdkQueries).toHaveBeenLastCalledWith([
      'queryMerklUserRewards',
      'queryBrevisCampaigns',
      'queryBrevisUserProofs',
      'queryFuulClaimableRewards',
      'queryTurtleMerkleProofs',
    ])
    expect(refreshAllPositions).toHaveBeenLastCalledWith(undefined, undefined, { source: 'fresh', preempt: true })
  })
})
