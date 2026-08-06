<script setup lang="ts">
import { OperationReviewModal } from '#components'
import { formatUnits } from 'viem'
import type { TransactionPlan, TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { REWARD_PROVIDER_REVIEW_TYPES, type UserReward } from '~/entities/reward-campaign'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import { logWarn } from '~/utils/errorHandling'
import { executeReviewedFuulClaim } from '~/utils/fuulRewardClaim'
import { formatNumber, formatUsdValue } from '~/utils/string-utils'

const REWARD_PROVIDER_LABELS: Record<UserReward['provider'], string> = {
  merkl: 'Merkl',
  brevis: 'Incentra',
  fuul: 'Fuul',
  turtle: 'Turtle',
}

const { reward } = defineProps<{ reward: UserReward }>()
const rewardKey = computed(() =>
  `${reward.chainId}:${reward.provider}:${reward.token.address.toLowerCase()}:${reward.unclaimed}`,
)

const { buildClaimRewardPlan, refreshRewards } = useSdkRewards()
const { entryCount, clearBatch } = useTxBatch()
const { executePlan, executePreparedPlan, prepareTransactionPlan } = useEulerTx()
const { getTokenByAddress } = useTokenList()
const { isSpyMode } = useSpyMode()
const modal = useModal()
const { error } = useToast()
const { chainId: walletChainId, switchChain } = useWagmi()
const { runSimulation, runPreparedSimulation, simulationError } = useTransactionPlanSimulation()

const isClaiming = ref(false)
const isPreparing = ref(false)
const plan = ref<TransactionPlan | null>(null)

const rewardAmount = computed(() => Number(formatUnits(BigInt(reward.unclaimed), reward.token.decimals)))
const rewardUsdValue = computed(() => rewardAmount.value * reward.tokenPrice)
const providerLabel = computed(() => REWARD_PROVIDER_LABELS[reward.provider] ?? reward.provider)
const planKind = computed(() => REWARD_PROVIDER_REVIEW_TYPES[reward.provider] ?? 'reward')
const isBatchActive = computed(() => entryCount.value > 0)
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

const claim = async (reviewedFuulPlan?: TransactionPlanPrepared) => {
  if (isBatchActive.value) {
    error('Clear the current batch before claiming rewards')
    return
  }

  if (isSpyMode.value) {
    error('Exit spy mode to claim rewards')
    return
  }

  try {
    isClaiming.value = true

    if (reward.provider === 'fuul') {
      await executeReviewedFuulClaim(reviewedFuulPlan, executePreparedPlan)
    }
    else {
      if (!plan.value) {
        plan.value = await buildClaimRewardPlan(reward)
      }
      await executePlan(plan.value)
    }
    modal.close()
    await refreshRewards({ delayedRetry: true })
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
  if (isBatchActive.value) {
    error('Clear the current batch before claiming rewards')
    return
  }

  if (isSpyMode.value) {
    error('Exit spy mode to claim rewards')
    return
  }

  if (isPreparing.value) return
  isPreparing.value = true
  try {
    await ensureWalletOnClaimChain()
    let reviewedFuulPlan: TransactionPlanPrepared | undefined

    try {
      plan.value = await buildClaimRewardPlan(reward)
      if (reward.provider === 'fuul') {
        reviewedFuulPlan = await prepareTransactionPlan(plan.value)
      }
    }
    catch (e) {
      logWarn('PortfolioSdkRewardItem/buildPlan', e)
      plan.value = null
    }

    if (reviewedFuulPlan || plan.value) {
      const ok = reviewedFuulPlan
        ? await runPreparedSimulation(reviewedFuulPlan)
        : await runSimulation(plan.value!)
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
        plan: reviewedFuulPlan ? undefined : (plan.value || undefined),
        prepared: reviewedFuulPlan,
        submittingLabel: 'Claiming...',
        onConfirm: async () => {
          await claim(reviewedFuulPlan)
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
    class="relative overflow-hidden bg-surface rounded-xl border border-line-subtle shadow-card p-16 transition-all duration-default ease-default"
    data-id="portfolio-list-item"
    data-list="sdk-rewards"
    :data-key="rewardKey"
    :data-token-address="reward.token.address.toLowerCase()"
  >
    <div class="relative z-0 flex flex-col gap-12">
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
      <div class="grid grid-cols-1">
        <UiButton
          rounded
          :loading="isClaiming || isPreparing"
          :disabled="isSpyMode || isBatchActive"
          @click="onClaimClick"
        >
          Claim
        </UiButton>
      </div>
      <p
        v-if="isBatchActive"
        class="text-center text-p3 text-content-tertiary"
        data-testid="reward-batch-blocked"
      >
        Clear the current batch before claiming rewards ·
        <button
          type="button"
          class="text-accent-500 hover:text-accent-600"
          data-testid="reward-clear-batch"
          @click="clearBatch"
        >
          Clear batch
        </button>
      </p>
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
