<script setup lang="ts">
import { OperationReviewModal } from '#components'
import { formatUnits } from 'viem'
import type { TransactionPlan, UserReward } from '@eulerxyz/euler-v2-sdk'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import { logWarn } from '~/utils/errorHandling'
import { formatNumber, formatUsdValue } from '~/utils/string-utils'

const REWARD_PROVIDER_LABELS: Record<UserReward['provider'], string> = {
  merkl: 'Merkl',
  brevis: 'Incentra',
  fuul: 'Fuul',
}

const REWARD_PROVIDER_TYPES: Record<UserReward['provider'], 'reward' | 'brevis-reward' | 'fuul-reward'> = {
  merkl: 'reward',
  brevis: 'brevis-reward',
  fuul: 'fuul-reward',
}

const { reward } = defineProps<{ reward: UserReward }>()
const rewardKey = computed(() =>
  `${reward.chainId}:${reward.provider}:${reward.token.address.toLowerCase()}:${reward.unclaimed}`,
)

const { buildClaimRewardPlan, refreshRewards } = useSdkRewards()
const { executePlan } = useEulerTx()
const { getTokenByAddress } = useTokenList()
const { isSpyMode } = useSpyMode()
const modal = useModal()
const { error } = useToast()
const { chainId: walletChainId, switchChain } = useWagmi()
const { runSimulation, simulationError } = useTransactionPlanSimulation()

const isClaiming = ref(false)
const isPreparing = ref(false)
const plan = ref<TransactionPlan | null>(null)

const rewardAmount = computed(() => Number(formatUnits(BigInt(reward.unclaimed), reward.token.decimals)))
const rewardUsdValue = computed(() => rewardAmount.value * reward.tokenPrice)
const providerLabel = computed(() => REWARD_PROVIDER_LABELS[reward.provider] ?? reward.provider)
const planKind = computed(() => REWARD_PROVIDER_TYPES[reward.provider] ?? 'reward')
const isEulFamily = computed(() => ['rEUL', 'EUL'].includes(reward.token.symbol))
const externalIconUrl = computed(() => {
  if (isEulFamily.value) return undefined
  return getTokenByAddress(reward.token.address)?.logoURI || undefined
})
const hasIcon = computed(() => isEulFamily.value || !!externalIconUrl.value)
const avatarAsset = computed(() => isEulFamily.value
  ? { address: reward.token.address, symbol: 'EUL' }
  : { address: reward.token.address, symbol: reward.token.symbol })

const ensureWalletOnClaimChain = async () => {
  const targetChainId = reward.chainId
  if (walletChainId.value === targetChainId) return

  await switchChain({ chainId: targetChainId })
  await until(walletChainId).toBe(targetChainId, { timeout: 8000, throwOnTimeout: false })
}

const claim = async () => {
  try {
    isClaiming.value = true

    if (!plan.value) {
      plan.value = await buildClaimRewardPlan(reward)
    }
    await executePlan(plan.value)
    modal.close()
    await refreshRewards()
  }
  catch (e) {
    error('Transaction failed')
    logWarn('PortfolioSdkRewardItem/claim', e)
  }
  finally {
    isClaiming.value = false
  }
}

const onClaimClick = async () => {
  if (isPreparing.value) return
  isPreparing.value = true
  try {
    await ensureWalletOnClaimChain()

    try {
      plan.value = await buildClaimRewardPlan(reward)
    }
    catch (e) {
      logWarn('PortfolioSdkRewardItem/buildPlan', e)
      plan.value = null
    }

    if (plan.value) {
      const ok = await runSimulation(plan.value)
      if (!ok) return
    }

    modal.open(OperationReviewModal, {
      props: {
        type: planKind.value,
        asset: {
          symbol: reward.token.symbol,
          address: reward.token.address,
          decimals: reward.token.decimals,
        },
        assetIconUrl: externalIconUrl.value,
        amount: rewardAmount.value,
        plan: plan.value || undefined,
        submittingLabel: 'Claiming...',
        onConfirm: async () => {
          await claim()
        },
      },
    })
  }
  catch (e) {
    logWarn('PortfolioSdkRewardItem/onClaimClick', e)
  }
  finally {
    isPreparing.value = false
  }
}
</script>

<template>
  <div
    class="bg-surface rounded-xl border border-line-subtle shadow-card p-16"
    data-id="portfolio-list-item"
    data-list="sdk-rewards"
    :data-key="rewardKey"
    :data-token-address="reward.token.address.toLowerCase()"
  >
    <div class="flex flex-col gap-12">
      <div class="flex justify-between items-center mb-12">
        <AssetAvatar
          v-if="hasIcon"
          :asset="avatarAsset"
          :icon-url="externalIconUrl"
          size="40"
        />
        <div
          v-else
          class="w-40 h-40 flex justify-center items-center bg-surface-secondary rounded-full text-h6 text-content-secondary"
        >
          {{ reward.token.symbol[0].toUpperCase() }}
        </div>
        <div class="ml-12">
          <h4
            class="text-h5 text-content-primary"
            data-id="data-point"
            :data-key="rewardKey"
            data-field="reward-symbol"
            :data-value="reward.token.symbol"
          >
            {{ reward.token.symbol }}
          </h4>
          <p
            class="text-p3 text-content-tertiary"
            data-id="data-point"
            :data-key="rewardKey"
            data-field="reward-provider"
            :data-value="providerLabel"
          >
            {{ providerLabel }}
          </p>
        </div>
        <div class="flex flex-col gap-8 ml-auto text-right">
          <p
            class="text-p2 text-content-primary"
            data-id="data-point"
            :data-key="rewardKey"
            data-field="reward-usd-value"
            :data-value="rewardUsdValue"
          >
            {{ formatUsdValue(rewardUsdValue) }}
          </p>
          <p
            class="text-p3 text-content-tertiary"
            data-id="data-point"
            :data-key="rewardKey"
            data-field="reward-amount"
            :data-value="rewardAmount"
          >
            ~ {{ rewardAmount < 0.01 ? '< 0.01' : formatNumber(rewardAmount, 2) }} {{ reward.token.symbol }}
          </p>
        </div>
      </div>
      <UiButton
        rounded
        :loading="isClaiming || isPreparing"
        :disabled="isSpyMode"
        @click="onClaimClick"
      >
        Claim
      </UiButton>
      <UiAlert
        v-if="simulationError"
        class="mt-12"
        title="Error"
        variant="error"
        :description="simulationError"
        size="compact"
      />
    </div>
  </div>
</template>
