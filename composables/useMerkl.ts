import { useAccount, useSwitchChain, useWriteContract } from '@wagmi/vue'
import type { Address } from 'viem'
import axios from 'axios'

import { merklDistributorABI } from '~/abis/merkl'
import type { Opportunity, Reward, RewardsResponseItem, RewardToken } from '~/entities/merkl'
import type { RewardCampaign, RewardCampaignType } from '~/entities/reward-campaign'
import { mapMerklSubType } from '~/entities/reward-campaign'
import type { TxPlan } from '~/entities/txPlan'
import { CACHE_TTL_1MIN_MS, POLL_INTERVAL_30S_MS } from '~/entities/tuning-constants'
import { logWarn } from '~/utils/errorHandling'
import { earnVaults } from '~/utils/eulerLabelsState'

const {
  MERKL_API_BASE_URL,
} = useEulerConfig()

const endpoints = {
  tokens: `${MERKL_API_BASE_URL}/tokens/reward`,
  opportunities: `${MERKL_API_BASE_URL}/opportunities/campaigns`,
  rewards: (addr: string) => `${MERKL_API_BASE_URL}/users/${addr}/rewards`,
  campaignById: (id: string) => `${MERKL_API_BASE_URL}/campaigns/${id}`,
}

const address = ref('')

const isLoaded = ref(false)
const merklCampaigns: Ref<Map<string, RewardCampaign[]>> = shallowRef(new Map())
const rewards: Ref<Reward[]> = ref([])
const rewardTokens: Ref<RewardToken[]> = ref([])
const isTokensLoading = ref(true)
const isOpportunitiesLoading = ref(true)
const isRewardsLoading = ref(true)

let interval: NodeJS.Timeout | null = null

// Cache state for Merkl data
const cacheState = {
  tokens: { chainId: 0, timestamp: 0 },
  opportunities: { chainId: 0, timestamp: 0 },
  rewards: { chainId: 0, address: '', timestamp: 0 },
}

let latestOpportunitiesRequestId = 0
let latestRewardsRequestId = 0
let erc20FetchedForChainId = 0

const loadTokens = async (chainId: number, isInitialLoading = true, forceRefresh = false) => {
  const now = Date.now()
  // Skip if cached and not expired
  if (!forceRefresh
    && cacheState.tokens.chainId === chainId
    && rewardTokens.value.length > 0
    && (now - cacheState.tokens.timestamp) < CACHE_TTL_1MIN_MS) {
    return
  }

  try {
    if (isInitialLoading) {
      isTokensLoading.value = true
    }
    const res = await axios.get(endpoints.tokens)
    const data: RewardToken[] = res.data[chainId]
    rewardTokens.value = data || []
    cacheState.tokens = { chainId, timestamp: Date.now() }
  }
  catch (e) {
    logWarn('merkl/loadTokens', e)
  }
  finally {
    isTokensLoading.value = false
  }
}

const processOpportunitiesToCampaigns = (
  opportunities: Opportunity[],
  opType: 'EULER' | 'ERC20LOGPROCESSOR',
  knownVaultAddresses?: Set<string>,
): Map<string, RewardCampaign[]> => {
  const campaignMap = new Map<string, RewardCampaign[]>()
  const now = Math.floor(Date.now() / 1000)

  for (const opportunity of opportunities) {
    if (opportunity.status !== 'LIVE') continue
    if (!opportunity.campaigns?.length) continue
    if (!opportunity.aprRecord?.breakdowns) continue

    // For ERC20LOGPROCESSOR: filter against known Earn vault addresses
    // since this endpoint returns campaigns for all protocols
    if (opType === 'ERC20LOGPROCESSOR' && knownVaultAddresses) {
      const opportunityAddress = opportunity.identifier?.toLowerCase()
      if (!opportunityAddress || !knownVaultAddresses.has(opportunityAddress)) continue
    }

    // Build APR map from aprRecord breakdowns (keyed by campaign ID)
    // This is the actual computed APR, not the stale campaign.apr field
    const aprs = new Map<string, number>()
    for (const breakdown of opportunity.aprRecord.breakdowns) {
      aprs.set(breakdown.identifier, breakdown.value)
    }

    for (const campaign of opportunity.campaigns) {
      if (campaign.subType === null || campaign.subType === undefined) continue

      const campaignType = mapMerklSubType(campaign.subType)
      if (!campaignType) continue

      if (!campaign.rewardToken || !campaign.params?.targetToken) continue

      const apr = aprs.get(campaign.campaignId) || 0

      // Skip active campaigns with no APR
      if (campaign.endTimestamp > now && !apr) continue

      const vaultAddress = opType === 'ERC20LOGPROCESSOR'
        ? (campaign.params.targetToken).toLowerCase()
        : (campaign.params.evkAddress || campaign.params.targetToken).toLowerCase()

      const collateral = campaignType === 'euler_borrow_collateral'
        ? campaign.params.collateralAddress?.toLowerCase()
        : undefined

      const rewardCampaign: RewardCampaign = {
        vault: vaultAddress,
        collateral,
        type: campaignType,
        apr,
        provider: 'merkl',
        endTimestamp: campaign.endTimestamp,
        rewardToken: { symbol: campaign.rewardToken.symbol, icon: campaign.rewardToken.icon },
        sourceUrl: 'https://app.merkl.xyz/?protocol=euler',
      }

      const existing = campaignMap.get(vaultAddress)
      if (existing) existing.push(rewardCampaign)
      else campaignMap.set(vaultAddress, [rewardCampaign])
    }
  }

  return campaignMap
}

// MULTILENDBORROW campaigns target multiple vaults under one budget. We emit one
// RewardCampaign per market using the existing euler_lend/euler_borrow types, so
// the existing APY aggregation and UI pick them up with no further changes.
const processMultiLendBorrowOpportunities = (
  opportunities: Opportunity[],
): Map<string, RewardCampaign[]> => {
  const campaignMap = new Map<string, RewardCampaign[]>()
  const now = Math.floor(Date.now() / 1000)

  for (const opportunity of opportunities) {
    // NOTE: LIVE guard temporarily disabled so the PAST test campaigns render
    // for local verification. Restore before merging (uncomment the line below).
    // if (opportunity.status !== 'LIVE') continue
    if (!opportunity.campaigns?.length) continue
    if (!opportunity.aprRecord?.breakdowns) continue

    const side: RewardCampaignType | null
      = opportunity.action === 'LEND'
        ? 'euler_lend'
        : opportunity.action === 'BORROW'
          ? 'euler_borrow'
          : null
    if (!side) continue

    const aprs = new Map<string, number>()
    for (const breakdown of opportunity.aprRecord.breakdowns) {
      aprs.set(breakdown.identifier, breakdown.value)
    }

    for (const campaign of opportunity.campaigns) {
      const markets = campaign.params?.markets
      if (!markets?.length || !campaign.rewardToken) continue

      // Merkl's aprRecord.breakdowns gives a single campaign-level APR (keyed by
      // campaignId) rather than per-market breakdowns, so each vault in the
      // campaign shares the same APR under the MAX_APR distribution.
      const apr = aprs.get(campaign.campaignId) || 0
      if (campaign.endTimestamp > now && !apr) continue

      for (const market of markets) {
        const vaultAddress = (
          market.campaignParameters.evkAddress
          || market.campaignParameters.targetToken
        )?.toLowerCase()
        if (!vaultAddress) continue

        const rewardCampaign: RewardCampaign = {
          vault: vaultAddress,
          type: side,
          apr,
          provider: 'merkl',
          endTimestamp: campaign.endTimestamp,
          rewardToken: { symbol: campaign.rewardToken.symbol, icon: campaign.rewardToken.icon },
          sourceUrl: `https://app.merkl.xyz/opportunities/${opportunity.chainId}/MULTILENDBORROW/${opportunity.identifier}`,
        }

        const existing = campaignMap.get(vaultAddress)
        if (existing) existing.push(rewardCampaign)
        else campaignMap.set(vaultAddress, [rewardCampaign])
      }
    }
  }

  return campaignMap
}

const loadOpportunities = async (chainId: number, isInitialLoading = true, forceRefresh = false) => {
  const now = Date.now()
  // Skip if cached and not expired
  if (!forceRefresh
    && cacheState.opportunities.chainId === chainId
    && merklCampaigns.value.size > 0
    && (now - cacheState.opportunities.timestamp) < CACHE_TTL_1MIN_MS) {
    return
  }

  const requestId = ++latestOpportunitiesRequestId

  try {
    if (isInitialLoading) {
      isOpportunitiesLoading.value = true
    }

    // Fetch from both endpoints: EULER type for standard vaults and ERC20LOGPROCESSOR for Earn vaults.
    // ERC20LOGPROCESSOR is fetched without mainProtocolId filter (unreliable tagging by Merkl)
    // and filtered client-side against known Earn vault addresses from labels.
    // Merkl API caps items at 100, so we paginate ERC20LOGPROCESSOR to get all results.
    const fetchAllPages = async (baseUrl: string): Promise<{ data: Opportunity[], complete: boolean }> => {
      const pageSize = 100
      const allData: Opportunity[] = []
      let page = 0

      while (true) {
        try {
          const res = await axios.get(`${baseUrl}&items=${pageSize}&page=${page}`)
          const results: Opportunity[] = Array.isArray(res.data) ? res.data : []
          allData.push(...results)
          if (results.length < pageSize) break
          page++
        }
        catch (error) {
          logWarn('merkl/fetchOpportunity', error)
          return { data: allData, complete: false }
        }
      }

      return { data: allData, complete: true }
    }

    // Always fetch EULER and MULTILENDBORROW campaigns. Only fetch ERC20LOGPROCESSOR
    // when Earn vault labels are available for client-side filtering (the earnVaults
    // watcher will trigger a force-refresh once labels load). MULTILENDBORROW is
    // unconditional because each campaign explicitly lists the targeted vaults.
    // NOTE: &test=true is temporary for local verification; remove before merging.
    const eulerUrl = `${MERKL_API_BASE_URL}/opportunities/?chainId=${chainId}&type=EULER&campaigns=true&test=true`
    const multiUrl = `${MERKL_API_BASE_URL}/opportunities/?chainId=${chainId}&type=MULTILENDBORROW&campaigns=true&test=true`
    const earnAddrs = earnVaults.value
    const knownEarnVaults = earnAddrs.length > 0
      ? new Set(earnAddrs.map(addr => addr.toLowerCase()))
      : undefined

    const eulerPromise = fetchAllPages(eulerUrl)
    const multiPromise = fetchAllPages(multiUrl)
    const erc20Promise = knownEarnVaults
      ? fetchAllPages(`${MERKL_API_BASE_URL}/opportunities/?chainId=${chainId}&type=ERC20LOGPROCESSOR&campaigns=true&test=true`)
      : Promise.resolve<{ data: Opportunity[], complete: boolean }>({ data: [], complete: true })

    const [eulerResult, multiResult, erc20Result] = await Promise.all([eulerPromise, multiPromise, erc20Promise])

    if (requestId !== latestOpportunitiesRequestId) return

    const allComplete = eulerResult.complete && multiResult.complete && erc20Result.complete

    const merged = new Map<string, RewardCampaign[]>()

    const mergeInto = (partial: Map<string, RewardCampaign[]>) => {
      for (const [vault, campaigns] of partial) {
        const existing = merged.get(vault)
        if (existing) existing.push(...campaigns)
        else merged.set(vault, [...campaigns])
      }
    }

    mergeInto(processOpportunitiesToCampaigns(eulerResult.data, 'EULER'))
    mergeInto(processOpportunitiesToCampaigns(erc20Result.data, 'ERC20LOGPROCESSOR', knownEarnVaults))
    mergeInto(processMultiLendBorrowOpportunities(multiResult.data))

    merklCampaigns.value = merged
    // Only cache when all pages were fetched successfully — partial results
    // from a mid-pagination failure should not be treated as a complete dataset.
    if (allComplete) {
      cacheState.opportunities = { chainId, timestamp: Date.now() }
    }
  }
  catch (e) {
    logWarn('merkl/loadOpportunities', e)
  }
  finally {
    if (requestId === latestOpportunitiesRequestId) {
      isOpportunitiesLoading.value = false
    }
  }
}

const loadRewards = async (chainId: number, isInitialLoading = true, forceRefresh = false) => {
  if (!address.value) {
    rewards.value = []
    isRewardsLoading.value = false
    return
  }

  const now = Date.now()
  // Skip if cached and not expired (check address too since rewards are per-user)
  if (!forceRefresh
    && cacheState.rewards.chainId === chainId
    && cacheState.rewards.address === address.value
    && (now - cacheState.rewards.timestamp) < CACHE_TTL_1MIN_MS) {
    return
  }

  const requestId = ++latestRewardsRequestId

  try {
    if (isInitialLoading) {
      isRewardsLoading.value = true
    }
    const res = await axios.get(endpoints.rewards(address.value), {
      params: {
        chainId,
      },
    })

    if (requestId !== latestRewardsRequestId) return

    const data = res.data

    const rewardsList: Reward[] = data
      .reduce((prev: Reward[], curr: RewardsResponseItem) => {
        return [...prev, ...curr.rewards]
      }, [] as Reward[])

    rewards.value = rewardsList.filter(reward => reward.claimed !== reward.amount)
    cacheState.rewards = { chainId, address: address.value, timestamp: Date.now() }
  }
  catch (e) {
    logWarn('merkl/loadRewards', e)
  }
  finally {
    if (requestId === latestRewardsRequestId) {
      isRewardsLoading.value = false
    }
  }
}

const getMerklCampaignsForVault = (vaultAddress: string): RewardCampaign[] => {
  return merklCampaigns.value.get(vaultAddress.toLowerCase()) || []
}

export const useMerkl = () => {
  const { isConnected, address: wagmiAddress, chain: wagmiChain } = useAccount()
  const { switchChain } = useSwitchChain()
  const { MERKL_ADDRESS } = useEulerConfig()
  const { client: rpcClient } = useRpcClient()
  const { writeContractAsync } = useWriteContract()
  const { chainId } = useEulerAddresses()
  const { enableMerkl } = useDeployConfig()
  const { spyAddress } = useSpyMode()

  const effectiveAddress = computed(() => spyAddress.value || wagmiAddress.value || '')
  const isActive = computed(() => isConnected.value || Boolean(spyAddress.value))

  const ensureWalletOnCurrentChain = async () => {
    const targetChainId = chainId.value
    if (!targetChainId) {
      return
    }

    const walletChainId = wagmiChain.value?.id
    if (walletChainId === targetChainId) {
      return
    }

    await switchChain({ chainId: targetChainId })
  }

  const claimReward = async (reward: Reward) => {
    if (!wagmiAddress.value) {
      throw new Error('Wallet not connected')
    }

    await ensureWalletOnCurrentChain()

    const hash = await writeContractAsync({
      address: MERKL_ADDRESS as Address,
      abi: merklDistributorABI,
      functionName: 'claim',
      args: [
        [wagmiAddress.value],
        [reward.token.address as Address],
        [BigInt(reward.amount)],
        [reward.proofs as Address[]],
      ],
    })

    const receipt = await rpcClient.value!.waitForTransactionReceipt({ hash })
    if (receipt.status === 'reverted') {
      throw new Error('Transaction reverted')
    }

    return hash
  }

  const buildClaimRewardPlan = async (reward: Reward): Promise<TxPlan> => {
    if (!wagmiAddress.value) {
      throw new Error('Wallet not connected')
    }

    return {
      kind: 'reward',
      steps: [
        {
          type: 'other',
          label: 'Claim reward',
          to: MERKL_ADDRESS as Address,
          abi: merklDistributorABI,
          functionName: 'claim',
          args: [
            [wagmiAddress.value],
            [reward.token.address as Address],
            [BigInt(reward.amount)],
            [reward.proofs as Address[]],
          ],
          value: 0n,
        },
      ],
    }
  }

  watch(effectiveAddress, (val, oldVal) => {
    address.value = val || ''
    // Force-refresh rewards when the effective address changes (skip initial mount)
    if (enableMerkl && oldVal && val && val !== oldVal && chainId.value) {
      loadRewards(chainId.value, true, true)
    }
  }, { immediate: true })

  // Re-fetch opportunities when Earn vault labels become available,
  // so ERC20LOGPROCESSOR campaigns are properly filtered.
  // { immediate: true } catches the case where labels are already loaded by the time
  // the watcher is registered (e.g. component remounts after a chain switch).
  // erc20FetchedForChainId is set synchronously before the async call and only here
  // (never inside loadOpportunities) so it is always claimed against correct chain
  // data, and concurrent watcher fires from other component mounts skip the duplicate.
  watch(earnVaults, (val) => {
    if (enableMerkl && val.length > 0 && chainId.value
      && erc20FetchedForChainId !== chainId.value) {
      erc20FetchedForChainId = chainId.value
      loadOpportunities(chainId.value, false, true)
    }
  }, { immediate: true })

  watch([isActive, chainId], ([active, currentChainId], oldVal) => {
    const [oldActive, oldChainId] = oldVal ?? [undefined, undefined]

    if (oldChainId && currentChainId !== oldChainId) {
      isLoaded.value = false
      merklCampaigns.value = new Map()
      rewards.value = []
      cacheState.opportunities = { chainId: 0, timestamp: 0 }
      erc20FetchedForChainId = 0
      cacheState.rewards = { chainId: 0, address: '', timestamp: 0 }
    }

    // Clear user-specific data on deactivation (disconnect + no spy)
    if (oldActive && !active) {
      rewards.value = []
      isRewardsLoading.value = false
      cacheState.rewards = { chainId: 0, address: '', timestamp: 0 }
    }

    if (enableMerkl && !isLoaded.value) {
      // Skip if the earnVaults watcher already initiated the fetch synchronously
      // (happens when earn labels are loaded before this watcher fires on mount)
      if (erc20FetchedForChainId !== chainId.value) {
        loadOpportunities(chainId.value)
      }
      loadTokens(chainId.value)
      loadRewards(chainId.value)
      isLoaded.value = true
    }

    if (enableMerkl && active && !interval) {
      interval = setInterval(() => {
        loadRewards(chainId.value, false)
        loadOpportunities(chainId.value, false)
        loadTokens(chainId.value, false)
      }, POLL_INTERVAL_30S_MS)
    }
    else if (!active && interval) {
      clearInterval(interval)
      interval = null
    }
  }, { immediate: true })

  onUnmounted(() => {
    if (interval) {
      clearInterval(interval)
      interval = null
    }
  })

  return {
    merklCampaigns,
    rewards,
    rewardTokens,
    isTokensLoading,
    isOpportunitiesLoading,
    isRewardsLoading,
    claimReward,
    buildClaimRewardPlan,
    loadOpportunities,
    loadTokens,
    loadRewards,
    getMerklCampaignsForVault,
  }
}
