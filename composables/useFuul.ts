import { useSwitchChain, useWriteContract } from '@wagmi/vue'
import type { Address } from 'viem'
import axios from 'axios'

import { fuulManagerABI, fuulFactoryABI } from '~/abis/fuul'
import type { FuulClaimableEntry, FuulClaimableReward, FuulIncentive } from '~/entities/fuul'
import type { RewardCampaign } from '~/entities/reward-campaign'
import type { TxPlan } from '~/entities/txPlan'
import { CACHE_TTL_1MIN_MS, POLL_INTERVAL_60S_MS } from '~/entities/tuning-constants'
import { logWarn } from '~/utils/errorHandling'
import { createInFlightDedup } from '~/utils/in-flight'
import { createRaceGuard } from '~/utils/race-guard'

const address = ref('')

const isLoaded = ref(false)
const fuulCampaigns: Ref<Map<string, RewardCampaign[]>> = shallowRef(new Map())
const isCampaignsLoading = ref(true)
const fuulClaimableEntries: Ref<FuulClaimableEntry[]> = shallowRef([])
const isClaimableLoading = ref(true)

// Both public incentives and user-specific claimable rewards poll at 60s.
// Public hits the CDN-cached proxy; claimable rewards (direct Fuul call,
// NOT proxied) go to upstream.
let publicInterval: NodeJS.Timeout | null = null
let userInterval: NodeJS.Timeout | null = null
let subscriberCount = 0
const incentivesGuard = createRaceGuard()
const claimableGuard = createRaceGuard()

const cacheState = {
  campaigns: { chainId: 0, timestamp: 0 },
  claimable: { timestamp: 0, address: '', chainId: 0 },
}

const getFuulCampaignsForVault = (vaultAddress: string): RewardCampaign[] => {
  return fuulCampaigns.value.get(vaultAddress.toLowerCase()) || []
}

interface FuulProxyResponse {
  euler: unknown
  looping: unknown
}

// Per-chain in-flight dedup so concurrent callers (chain-switch watcher +
// 60 s poll firing close together) share a single HTTP round-trip.
const inFlightFuul = createInFlightDedup<number, FuulProxyResponse>()

const fetchFuulProxy = (chainId: number): Promise<FuulProxyResponse> =>
  inFlightFuul.run(chainId, () =>
    $fetch<FuulProxyResponse>('/api/rewards/fuul', { query: { chainId } }))

export const useFuul = () => {
  const { address: wagmiAddress, chain: wagmiChain } = useWagmi()
  const { switchChain } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const { FUUL_API_BASE_URL, FUUL_MANAGER_ADDRESS, FUUL_FACTORY_ADDRESS } = useEulerConfig()
  const { client: rpcClient } = useRpcClient()
  const { chainId } = useEulerAddresses()
  const { enableFuul } = useDeployConfig()
  const { spyAddress } = useSpyMode()

  const effectiveAddress = computed(() => spyAddress.value || wagmiAddress.value || '')

  const unclaimedFuulRewards = computed(() =>
    fuulClaimableEntries.value.flatMap(entry => entry.claimable_rewards),
  )

  const ensureWalletOnCurrentChain = async () => {
    const targetChainId = chainId.value
    if (!targetChainId) return

    if (wagmiChain.value?.id === targetChainId) return
    await switchChain({ chainId: targetChainId })
  }

  const loadIncentives = async (isInitialLoading = true, forceRefresh = false) => {
    const currentChainId = chainId.value
    if (!currentChainId) return

    const now = Date.now()
    if (!forceRefresh
      && cacheState.campaigns.chainId === currentChainId
      && fuulCampaigns.value.size > 0
      && (now - cacheState.campaigns.timestamp) < CACHE_TTL_1MIN_MS) {
      return
    }

    const generation = incentivesGuard.next()

    try {
      if (isInitialLoading) {
        isCampaignsLoading.value = true
      }

      // Public incentives flow through the proxy; server fans out the two
      // protocol queries (euler + euler-looping) and returns a combined shape.
      // /claimable-rewards stays direct below since it's wallet-specific.
      const proxyData = await fetchFuulProxy(currentChainId)

      if (incentivesGuard.isStale(generation)) return

      const campaignMap = new Map<string, RewardCampaign[]>()

      const addCampaign = (vaultKey: string, campaign: RewardCampaign) => {
        const existing = campaignMap.get(vaultKey)
        if (existing) existing.push(campaign)
        else campaignMap.set(vaultKey, [campaign])
      }

      const eulerData: FuulIncentive[] = Array.isArray(proxyData.euler) ? proxyData.euler : []
      for (const item of eulerData) {
        const vaultKey = item.trigger.context.token_address?.toLowerCase()
        if (!vaultKey) continue

        addCampaign(vaultKey, {
          vault: vaultKey,
          type: 'euler_lend',
          apr: item.apr * 100,
          provider: 'fuul',
          endTimestamp: 0,
          rewardToken: { symbol: item.project, icon: '' },
          sourceUrl: 'https://www.fuul.xyz/',
        })
      }

      const loopingData: FuulIncentive[] = Array.isArray(proxyData.looping) ? proxyData.looping : []
      for (const item of loopingData) {
        const borrowVault = item.trigger.context.borrowVault?.toLowerCase()
        const depositVault = item.trigger.context.depositVault?.toLowerCase()
        if (!borrowVault || !depositVault) continue

        addCampaign(borrowVault, {
          vault: borrowVault,
          collateral: depositVault,
          type: 'euler_looping',
          apr: item.apr * 100,
          provider: 'fuul',
          endTimestamp: 0,
          rewardToken: { symbol: item.pool.token0_symbol || item.project, icon: '' },
          sourceUrl: 'https://www.fuul.xyz/',
          minMultiplier: item.trigger.context.min_leverage,
          maxMultiplier: item.trigger.context.max_leverage,
        })
      }

      fuulCampaigns.value = campaignMap
      cacheState.campaigns = { chainId: currentChainId, timestamp: Date.now() }
    }
    catch (e) {
      logWarn('fuul/incentives', e)
    }
    finally {
      isCampaignsLoading.value = false
    }
  }

  const loadClaimableRewards = async (isInitialLoading = true, forceRefresh = false) => {
    const currentChainId = chainId.value
    if (!address.value || !currentChainId) {
      fuulClaimableEntries.value = []
      isClaimableLoading.value = false
      return
    }

    const now = Date.now()
    if (!forceRefresh
      && cacheState.claimable.address === address.value
      && cacheState.claimable.chainId === currentChainId
      && (now - cacheState.claimable.timestamp) < CACHE_TTL_1MIN_MS) {
      return
    }

    const generation = claimableGuard.next()
    const capturedAddress = address.value

    try {
      if (isInitialLoading) {
        isClaimableLoading.value = true
      }

      const [eulerRes, loopingRes] = await Promise.all([
        axios.get(`${FUUL_API_BASE_URL}/claimable-rewards`, {
          params: { protocol: 'euler', user_address: capturedAddress, chain_id: currentChainId },
        }),
        axios.get(`${FUUL_API_BASE_URL}/claimable-rewards`, {
          params: { protocol: 'euler-looping', user_address: capturedAddress, chain_id: currentChainId },
        }),
      ])

      if (claimableGuard.isStale(generation)) return

      fuulClaimableEntries.value = [
        ...(Array.isArray(eulerRes.data) ? eulerRes.data : []),
        ...(Array.isArray(loopingRes.data) ? loopingRes.data : []),
      ]
      cacheState.claimable = { timestamp: Date.now(), address: capturedAddress, chainId: currentChainId }
    }
    catch (e) {
      logWarn('fuul/claimable-rewards', e)
    }
    finally {
      if (!claimableGuard.isStale(generation)) {
        isClaimableLoading.value = false
      }
    }
  }

  const readClaimFee = async (projectAddress: string): Promise<bigint> => {
    const feesInfo = await rpcClient.value!.readContract({
      address: FUUL_FACTORY_ADDRESS as Address,
      abi: fuulFactoryABI,
      functionName: 'getFeesInformation',
      args: [projectAddress as Address],
    })

    return (feesInfo as { nativeUserClaimFee: bigint }).nativeUserClaimFee
  }

  const mapRewardToContractCheck = (reward: FuulClaimableReward) => ({
    projectAddress: reward.project_address as Address,
    to: wagmiAddress.value as Address,
    currency: reward.currency_address as Address,
    currencyType: 1,
    amount: BigInt(reward.amount),
    reason: reward.reason,
    tokenId: BigInt(reward.token_id),
    deadline: BigInt(reward.deadline),
    proof: reward.proof as `0x${string}`,
    signatures: reward.signatures as `0x${string}`[],
  })

  const claimReward = async (reward: FuulClaimableReward) => {
    if (!wagmiAddress.value) {
      throw new Error('Wallet not connected')
    }

    await ensureWalletOnCurrentChain()

    const contractCheck = mapRewardToContractCheck(reward)
    const fee = await readClaimFee(reward.project_address)

    const hash = await writeContractAsync({
      address: FUUL_MANAGER_ADDRESS as Address,
      abi: fuulManagerABI,
      functionName: 'claim',
      args: [[contractCheck]],
      value: fee,
    })

    const receipt = await rpcClient.value!.waitForTransactionReceipt({ hash })
    if (receipt.status === 'reverted') {
      throw new Error('Transaction reverted')
    }

    return hash
  }

  const buildClaimRewardPlan = async (reward: FuulClaimableReward): Promise<TxPlan> => {
    if (!wagmiAddress.value) {
      throw new Error('Wallet not connected')
    }

    const contractCheck = mapRewardToContractCheck(reward)
    const fee = await readClaimFee(reward.project_address)

    return {
      kind: 'fuul-reward',
      steps: [
        {
          type: 'other',
          label: 'Claim Fuul reward',
          to: FUUL_MANAGER_ADDRESS as Address,
          abi: fuulManagerABI,
          functionName: 'claim',
          args: [[contractCheck]],
          value: fee,
        },
      ],
    }
  }

  watch(effectiveAddress, (val, oldVal) => {
    if (val) {
      address.value = val
    }
    else {
      address.value = ''
      claimableGuard.next()
      fuulClaimableEntries.value = []
      isClaimableLoading.value = false
      cacheState.claimable = { timestamp: 0, address: '', chainId: 0 }
    }
    if (enableFuul && oldVal && val && val !== oldVal) {
      loadClaimableRewards(true, true)
    }
  }, { immediate: true })

  watch(chainId, (val, oldVal) => {
    if (oldVal && val !== oldVal) {
      isLoaded.value = false
    }

    if (enableFuul && !isLoaded.value && val) {
      loadIncentives()
      loadClaimableRewards()
      isLoaded.value = true
    }

    if (enableFuul) {
      if (!publicInterval) {
        publicInterval = setInterval(() => {
          loadIncentives(false)
        }, POLL_INTERVAL_60S_MS)
      }
      if (!userInterval) {
        userInterval = setInterval(() => {
          loadClaimableRewards(false)
        }, POLL_INTERVAL_60S_MS)
      }
    }
  }, { immediate: true })

  subscriberCount++

  onUnmounted(() => {
    subscriberCount--
    if (subscriberCount === 0) {
      if (publicInterval) {
        clearInterval(publicInterval)
        publicInterval = null
      }
      if (userInterval) {
        clearInterval(userInterval)
        userInterval = null
      }
    }
  })

  return {
    fuulCampaigns,
    unclaimedFuulRewards,
    isCampaignsLoading,
    isClaimableLoading,
    loadIncentives,
    loadClaimableRewards,
    claimReward,
    buildClaimRewardPlan,
    getFuulCampaignsForVault,
  }
}
