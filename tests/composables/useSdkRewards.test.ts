import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { Address } from 'viem'
import type { UserReward } from '@eulerxyz/euler-v2-sdk'

const owner = '0x1000000000000000000000000000000000000000' as Address

const importUseSdkRewards = async (
  options: {
    isConnected?: boolean
    isConnecting?: boolean
    isReconnecting?: boolean
    isSpyMode?: boolean
    isPositionsLoading?: boolean
  } = {},
) => {
  vi.resetModules()
  const currentChainId = ref(1)

  const reward: UserReward = {
    chainId: 1,
    provider: 'merkl',
    token: {
      address: '0x2000000000000000000000000000000000000000' as Address,
      chainId: 1,
      symbol: 'EUL',
      name: 'EUL',
      decimals: 18,
    },
    tokenPrice: 1,
    accumulated: '100',
    unclaimed: '100',
    proof: [],
    claimAddress: '0x3000000000000000000000000000000000000000' as Address,
  }
  const turtleReward: UserReward = {
    ...reward,
    provider: 'turtle',
    campaignId: 'stream-1',
    streamAddress: '0x4000000000000000000000000000000000000000' as Address,
    timestamp: '2026-05-20T13:05:10Z',
  }
  const crossChainTurtleReward: UserReward = {
    ...turtleReward,
    chainId: 11155111,
    token: {
      ...turtleReward.token,
      chainId: 11155111,
    },
  }
  const refreshAllPositions = vi.fn(async () => {})
  const invalidateSdkQueries = vi.fn(async () => {})
  const rewardClaimPlan = [{ type: 'evcBatch', items: [] }]
  const buildClaimPlan = vi.fn(async () => rewardClaimPlan)

  vi.doMock('~/utils/sdk-query-cache', () => ({
    invalidateSdkQueries,
  }))
  vi.stubGlobal('useEulerAccount', () => ({
    portfolio: ref({ account: { userRewards: [reward, turtleReward, crossChainTurtleReward] } }),
    isPositionsLoading: ref(options.isPositionsLoading ?? false),
    refreshAllPositions,
  }))
  vi.stubGlobal('useEulerAddresses', () => ({
    chainId: currentChainId,
  }))
  vi.stubGlobal('useWagmi', () => ({
    address: ref(owner),
    isConnected: ref(options.isConnected ?? true),
    isConnecting: ref(options.isConnecting ?? false),
    isReconnecting: ref(options.isReconnecting ?? false),
  }))
  vi.stubGlobal('useSpyMode', () => ({
    isSpyMode: ref(options.isSpyMode ?? false),
  }))
  const sdk = {
    rewardsService: { buildClaimPlan },
  }
  vi.stubGlobal('useEulerSdk', () => ({
    getEulerSdk: vi.fn(async () => sdk),
    getEulerSdkForChain: vi.fn(async () => sdk),
  }))

  const module = await import('~/composables/useSdkRewards')
  return {
    ...module,
    buildClaimPlan,
    invalidateSdkQueries,
    refreshAllPositions,
    rewardClaimPlan,
    reward,
    turtleReward,
    crossChainTurtleReward,
    currentChainId,
  }
}

describe('useSdkRewards', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('reads rewards from the SDK portfolio account on the selected chain', async () => {
    const { useSdkRewards, reward, turtleReward } = await importUseSdkRewards()

    const { rewards, isRewardsLoading } = useSdkRewards()

    expect(rewards.value).toEqual([reward, turtleReward])
    expect(isRewardsLoading.value).toBe(false)
  })

  it('does not stay loading without a wallet or spy session', async () => {
    const { useSdkRewards } = await importUseSdkRewards({
      isConnected: false,
      isSpyMode: false,
      isPositionsLoading: true,
    })

    const { isRewardsLoading } = useSdkRewards()

    expect(isRewardsLoading.value).toBe(false)
  })

  it('stays loading while rewards load for an active session', async () => {
    const { useSdkRewards } = await importUseSdkRewards({
      isConnected: true,
      isPositionsLoading: true,
    })

    const { isRewardsLoading } = useSdkRewards()

    expect(isRewardsLoading.value).toBe(true)
  })

  it('stays loading while rewards load during wallet auto-reconnect', async () => {
    const { useSdkRewards } = await importUseSdkRewards({
      isConnected: false,
      isReconnecting: true,
      isPositionsLoading: true,
    })

    const { isRewardsLoading } = useSdkRewards()

    expect(isRewardsLoading.value).toBe(true)
  })

  it('stays loading while rewards load during wallet connect', async () => {
    const { useSdkRewards } = await importUseSdkRewards({
      isConnected: false,
      isConnecting: true,
      isPositionsLoading: true,
    })

    const { isRewardsLoading } = useSdkRewards()

    expect(isRewardsLoading.value).toBe(true)
  })

  it('updates visible rewards when the selected chain changes', async () => {
    const { useSdkRewards, crossChainTurtleReward, currentChainId } = await importUseSdkRewards()

    const { rewards } = useSdkRewards()
    currentChainId.value = 11155111

    expect(rewards.value).toEqual([crossChainTurtleReward])
  })

  it('hides rewards when no valid chain is selected', async () => {
    const { useSdkRewards, currentChainId } = await importUseSdkRewards()

    const { rewards } = useSdkRewards()
    currentChainId.value = 0

    expect(rewards.value).toEqual([])
  })

  it('builds reward claim plans through the SDK default EVC path', async () => {
    const { useSdkRewards, buildClaimPlan, rewardClaimPlan, reward } = await importUseSdkRewards()

    const { buildClaimRewardPlan } = useSdkRewards()
    await expect(buildClaimRewardPlan(reward)).resolves.toBe(rewardClaimPlan)

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
