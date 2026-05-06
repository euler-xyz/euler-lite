import { useAccount, useSwitchChain, useWriteContract } from '@wagmi/vue'
import type { Address } from 'viem'
import axios from 'axios'

import { merklDistributorABI } from '~/abis/merkl'
import type { Reward, RewardsResponseItem } from '~/entities/merkl'
import type { TxPlan } from '~/entities/txPlan'
import { CACHE_TTL_1MIN_MS, POLL_INTERVAL_60S_MS } from '~/entities/tuning-constants'
import { logWarn } from '~/utils/errorHandling'

// Per-user rewards stay behind a same-origin proxy because Merkl does not
// consistently allow localhost browser origins. Public campaign APY now comes
// from SDK-populated vault.rewards, not from this composable.
const userRewardsEndpoint = '/api/rewards/merkl-user'

const address = ref('')
const rewards: Ref<Reward[]> = ref([])
const isRewardsLoading = ref(true)

let userInterval: NodeJS.Timeout | null = null
let subscriberCount = 0
let latestRewardsRequestId = 0

const cacheState = {
  rewards: { chainId: 0, address: '', timestamp: 0 },
}

const loadRewards = async (chainId: number, isInitialLoading = true, forceRefresh = false) => {
  if (!address.value) {
    rewards.value = []
    isRewardsLoading.value = false
    return
  }

  const now = Date.now()
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
    const res = await axios.get(userRewardsEndpoint, {
      params: {
        address: address.value,
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
    if (enableMerkl && oldVal && val && val !== oldVal && chainId.value) {
      loadRewards(chainId.value, true, true)
    }
  }, { immediate: true })

  watch([isActive, chainId], ([active, currentChainId], oldVal) => {
    const [oldActive, oldChainId] = oldVal ?? [undefined, undefined]

    if (oldChainId && currentChainId !== oldChainId) {
      rewards.value = []
      cacheState.rewards = { chainId: 0, address: '', timestamp: 0 }
    }

    if (oldActive && !active) {
      rewards.value = []
      isRewardsLoading.value = false
      cacheState.rewards = { chainId: 0, address: '', timestamp: 0 }
    }

    if (enableMerkl) {
      loadRewards(currentChainId)
    }

    if (enableMerkl && active) {
      if (!userInterval) {
        userInterval = setInterval(() => {
          loadRewards(chainId.value, false)
        }, POLL_INTERVAL_60S_MS)
      }
    }
    else if (!active && userInterval) {
      clearInterval(userInterval)
      userInterval = null
    }
  }, { immediate: true })

  subscriberCount++

  onUnmounted(() => {
    subscriberCount--
    if (subscriberCount === 0 && userInterval) {
      clearInterval(userInterval)
      userInterval = null
    }
  })

  return {
    rewards,
    isRewardsLoading,
    claimReward,
    buildClaimRewardPlan,
    loadRewards,
  }
}
