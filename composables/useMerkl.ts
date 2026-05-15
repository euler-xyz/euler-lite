import { useAccount, useSwitchChain, useWriteContract } from '@wagmi/vue'
import type { Address } from 'viem'
import axios from 'axios'

import { merklDistributorABI } from '~/abis/merkl'
import type {
  MerklOpportunityType,
  MerklResponseKey,
  Opportunity,
  Reward,
  RewardsResponseItem,
} from '~/entities/merkl'
import type { RewardCampaign, RewardCampaignType } from '~/entities/reward-campaign'
import { mapMerklSubType } from '~/entities/reward-campaign'
import type { TxPlan } from '~/entities/txPlan'
import { CACHE_TTL_1MIN_MS, POLL_INTERVAL_60S_MS } from '~/entities/tuning-constants'
import { logWarn } from '~/utils/errorHandling'
import { createInFlightDedup } from '~/utils/in-flight'

// The per-user /users/{addr}/rewards endpoint stays direct (it carries the
// wallet address, which we deliberately keep off the shared server cache).
// Resolved lazily: `useEulerConfig()` must be called inside a Vue setup
// or Nuxt context; evaluating it at module-load time fails when this
// module is pulled in early (e.g. via an import from app.vue).
const userRewardsEndpoint = (addr: string): string => {
  const { MERKL_API_BASE_URL } = useEulerConfig()
  return `${MERKL_API_BASE_URL}/users/${addr}/rewards`
}

const address = ref('')

const isLoaded = ref(false)
const merklCampaigns: Ref<Map<string, RewardCampaign[]>> = shallowRef(new Map())
const rewards: Ref<Reward[]> = ref([])
const isOpportunitiesLoading = ref(true)
const isRewardsLoading = ref(true)

// Both public campaigns and user-specific rewards poll at 60s. Public polls
// mostly hit CDN (60s total window = max-age 30s + stale-while-revalidate 30s)
// so the cost is near-zero while keeping the UI fresh. User-specific
// `/users/{addr}/rewards` is not proxied (per-wallet data).
//
// Note: Merkl's /tokens/reward payload is merged into /api/token-list on the
// server, so reward-token metadata (icons, decimals) comes from the unified
// token list rather than a dedicated Merkl fetch here.
let publicInterval: NodeJS.Timeout | null = null
let userInterval: NodeJS.Timeout | null = null
// Module-singleton refcount: multiple components / composables (useRewardsApy,
// PortfolioRewardItem, vault list rows, etc.) call useMerkl simultaneously.
// Clearing intervals on the first unmount would starve everyone else still
// subscribed. Mirrors the pattern already used in useFuul.
let subscriberCount = 0

const cacheState = {
  opportunities: { chainId: 0, timestamp: 0 },
  rewards: { chainId: 0, address: '', timestamp: 0 },
}

let latestOpportunitiesRequestId = 0
let latestRewardsRequestId = 0

interface MerklProxyResponse {
  opportunities: Record<MerklResponseKey, Opportunity[]>
}

const MERKL_EULER_SOURCE_URL = 'https://app.merkl.xyz/?protocol=euler'

const merklOpportunityUrl = (
  opportunity: Opportunity,
  type: MerklOpportunityType,
): string => {
  if (!opportunity.identifier) return MERKL_EULER_SOURCE_URL

  const chain = (opportunity.chain?.name || opportunity.chainId?.toString())?.trim()
  if (!chain) return MERKL_EULER_SOURCE_URL

  const chainSlug = chain.toLowerCase().replace(/\s+/g, '-')
  return `https://app.merkl.xyz/opportunities/${encodeURIComponent(chainSlug)}/${type}/${encodeURIComponent(opportunity.identifier)}`
}

// Public campaign data flows through `/api/rewards/merkl`, which warms the
// Merkl opportunity types server-side and returns one CDN-cacheable
// GET. User-specific /users/{addr}/rewards stays direct (per-wallet data
// not safe to put on a shared cache).
//
// Per-chain in-flight dedup so concurrent callers fired from the same
// watcher tick share a single HTTP round-trip. Keyed by chainId because
// chain-switch invalidates the relevant in-flight promise naturally.
const inFlightMerkl = createInFlightDedup<number, MerklProxyResponse | null>()

const fetchMerklProxy = (chainId: number): Promise<MerklProxyResponse | null> =>
  inFlightMerkl.run(chainId, () =>
    $fetch<MerklProxyResponse>('/api/rewards/merkl', { query: { chainId } })
      .catch((e) => {
        logWarn('merkl/proxy', e)
        return null
      }))

// Merkl campaigns can carry a `params.whitelist` (only these recipients earn)
// or `params.blacklist` (these recipients don't earn). We don't drop campaigns
// here — discovery views show the unfiltered APR — but we lowercase the lists
// onto the emitted `RewardCampaign` so `useRewardsApy` can filter per the
// connected/spied address.
const normalizeAddressList = (list: readonly string[] | undefined): string[] | undefined => {
  if (!list?.length) return undefined
  return list.map(a => a.toLowerCase())
}

const processOpportunitiesToCampaigns = (
  opportunities: Opportunity[],
  opType: 'EULER' | 'ERC20LOGPROCESSOR',
): Map<string, RewardCampaign[]> => {
  const campaignMap = new Map<string, RewardCampaign[]>()
  const now = Math.floor(Date.now() / 1000)

  for (const opportunity of opportunities) {
    if (opportunity.status !== 'LIVE') continue
    if (!opportunity.campaigns?.length) continue
    if (!opportunity.aprRecord?.breakdowns) continue

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
        sourceUrl: merklOpportunityUrl(opportunity, opType),
        whitelist: normalizeAddressList(campaign.params.whitelist),
        blacklist: normalizeAddressList(campaign.params.blacklist),
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
    if (opportunity.status !== 'LIVE') continue
    if (!opportunity.campaigns?.length) continue

    const side: RewardCampaignType | null
      = opportunity.action === 'LEND'
        ? 'euler_lend'
        : opportunity.action === 'BORROW'
          ? 'euler_borrow'
          : null
    if (!side) continue

    const aprs = new Map<string, number>()
    for (const breakdown of opportunity.aprRecord?.breakdowns ?? []) {
      aprs.set(breakdown.identifier, breakdown.value)
    }

    for (const campaign of opportunity.campaigns) {
      const markets = campaign.params?.markets
      if (!markets?.length || !campaign.rewardToken) continue

      const whitelist = normalizeAddressList(campaign.params?.whitelist)
      const blacklist = normalizeAddressList(campaign.params?.blacklist)

      // Merkl provides a single campaign-level APR (keyed by campaignId in
      // aprRecord.breakdowns), shared across all markets under MAX_APR. For
      // MULTILENDBORROW that breakdown can be absent/zero while the top-level
      // campaign.apr is populated, so fall back to it.
      const apr = aprs.get(campaign.campaignId) || campaign.apr || 0
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
          sourceUrl: merklOpportunityUrl(opportunity, 'MULTILENDBORROW'),
          whitelist,
          blacklist,
        }

        const existing = campaignMap.get(vaultAddress)
        if (existing) existing.push(rewardCampaign)
        else campaignMap.set(vaultAddress, [rewardCampaign])
      }
    }
  }

  return campaignMap
}

// EULER_BORROW_FROM_COLLATERAL (single vault) and
// EULER_MULTI_BORROW_FROM_COLLATERAL (multiple vaults) share a params shape:
// each campaign carries `params.vaults[]`, where every entry pairs one borrow
// vault (evkAddress) with the list of collateral vaults (collaterals[].tokenAddress)
// eligible for the reward. We fan out one RewardCampaign per (vault, collateral)
// pair using the existing `euler_borrow_collateral` type so the existing
// per-collateral filter in useRewardsApy picks them up unchanged.
//
// Defensive fallback: if `params.vaults` is absent but the flat
// `evkAddress` + `collateralAddress` pair is present, treat it as a single
// pair. Keeps us forward-compatible if EULER_BORROW_FROM_COLLATERAL ships
// with the legacy params layout.
//
// Exported for unit tests; the public surface is the `useMerkl` composable.
export const processBorrowFromCollateralOpportunities = (
  opportunities: Opportunity[],
  opType: 'EULER_BORROW_FROM_COLLATERAL' | 'EULER_MULTI_BORROW_FROM_COLLATERAL',
): Map<string, RewardCampaign[]> => {
  const campaignMap = new Map<string, RewardCampaign[]>()
  const now = Math.floor(Date.now() / 1000)

  for (const opportunity of opportunities) {
    if (opportunity.status !== 'LIVE') continue
    if (!opportunity.campaigns?.length) continue

    const aprs = new Map<string, number>()
    for (const breakdown of opportunity.aprRecord?.breakdowns ?? []) {
      aprs.set(breakdown.identifier, breakdown.value)
    }

    for (const campaign of opportunity.campaigns) {
      if (!campaign.rewardToken) continue

      // Mirror the MULTILENDBORROW fallback: breakdown can be absent or zero
      // while campaign.apr is populated.
      const apr = aprs.get(campaign.campaignId) || campaign.apr || 0
      if (campaign.endTimestamp > now && !apr) continue

      const pairs: { vault: string, collateral: string }[] = []

      const vaults = campaign.params?.vaults
      if (vaults?.length) {
        for (const vault of vaults) {
          const vaultAddress = vault.evkAddress?.toLowerCase()
          if (!vaultAddress) continue
          for (const collateral of vault.collaterals ?? []) {
            const collateralAddress = collateral.tokenAddress?.toLowerCase()
            if (!collateralAddress) continue
            pairs.push({ vault: vaultAddress, collateral: collateralAddress })
          }
        }
      }
      else if (campaign.params?.evkAddress && campaign.params?.collateralAddress) {
        pairs.push({
          vault: campaign.params.evkAddress.toLowerCase(),
          collateral: campaign.params.collateralAddress.toLowerCase(),
        })
      }

      for (const { vault, collateral } of pairs) {
        const rewardCampaign: RewardCampaign = {
          vault,
          collateral,
          type: 'euler_borrow_collateral',
          apr,
          provider: 'merkl',
          endTimestamp: campaign.endTimestamp,
          rewardToken: { symbol: campaign.rewardToken.symbol, icon: campaign.rewardToken.icon },
          sourceUrl: merklOpportunityUrl(opportunity, opType),
        }

        const existing = campaignMap.get(vault)
        if (existing) existing.push(rewardCampaign)
        else campaignMap.set(vault, [rewardCampaign])
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

    // Server proxy returns the Merkl opportunity types already paginated
    // and (for ERC20LOGPROCESSOR) already filtered against the chain's
    // earn-vault label set — so this composable just merges and transforms.
    const res = await fetchMerklProxy(chainId)
    if (!res) return

    if (requestId !== latestOpportunitiesRequestId) return

    const merged = new Map<string, RewardCampaign[]>()

    const mergeInto = (partial: Map<string, RewardCampaign[]>) => {
      for (const [vault, campaigns] of partial) {
        const existing = merged.get(vault)
        if (existing) existing.push(...campaigns)
        else merged.set(vault, [...campaigns])
      }
    }

    mergeInto(processOpportunitiesToCampaigns(res.opportunities.euler ?? [], 'EULER'))
    mergeInto(processOpportunitiesToCampaigns(res.opportunities.erc20logprocessor ?? [], 'ERC20LOGPROCESSOR'))
    mergeInto(processMultiLendBorrowOpportunities(res.opportunities.multilendborrow ?? []))
    mergeInto(processBorrowFromCollateralOpportunities(
      res.opportunities.euler_borrow_from_collateral ?? [], 'EULER_BORROW_FROM_COLLATERAL'))
    mergeInto(processBorrowFromCollateralOpportunities(
      res.opportunities.euler_multi_borrow_from_collateral ?? [], 'EULER_MULTI_BORROW_FROM_COLLATERAL'))

    merklCampaigns.value = merged
    cacheState.opportunities = { chainId, timestamp: Date.now() }
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
    const res = await axios.get(userRewardsEndpoint(address.value), {
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

  watch([isActive, chainId], ([active, currentChainId], oldVal) => {
    const [oldActive, oldChainId] = oldVal ?? [undefined, undefined]

    if (oldChainId && currentChainId !== oldChainId) {
      isLoaded.value = false
      merklCampaigns.value = new Map()
      rewards.value = []
      cacheState.opportunities = { chainId: 0, timestamp: 0 }
      cacheState.rewards = { chainId: 0, address: '', timestamp: 0 }
    }

    // Clear user-specific data on deactivation (disconnect + no spy)
    if (oldActive && !active) {
      rewards.value = []
      isRewardsLoading.value = false
      cacheState.rewards = { chainId: 0, address: '', timestamp: 0 }
    }

    if (enableMerkl && !isLoaded.value) {
      loadOpportunities(chainId.value)
      loadRewards(chainId.value)
      isLoaded.value = true
    }

    if (enableMerkl && active) {
      if (!publicInterval) {
        publicInterval = setInterval(() => {
          loadOpportunities(chainId.value, false)
        }, POLL_INTERVAL_60S_MS)
      }
      if (!userInterval) {
        userInterval = setInterval(() => {
          loadRewards(chainId.value, false)
        }, POLL_INTERVAL_60S_MS)
      }
    }
    else if (!active) {
      if (publicInterval) {
        clearInterval(publicInterval)
        publicInterval = null
      }
      if (userInterval) {
        clearInterval(userInterval)
        userInterval = null
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
    merklCampaigns,
    rewards,
    isOpportunitiesLoading,
    isRewardsLoading,
    claimReward,
    buildClaimRewardPlan,
    loadOpportunities,
    loadRewards,
    getMerklCampaignsForVault,
  }
}
