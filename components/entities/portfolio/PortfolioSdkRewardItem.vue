<script setup lang="ts">
import { OperationReviewModal } from '#components'
import { formatUnits } from 'viem'
import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import type { UserReward } from '~/entities/reward-campaign'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import { logWarn } from '~/utils/errorHandling'
import { formatNumber, formatUsdValue } from '~/utils/string-utils'
import { getTxErrorMessage } from '~/utils/tx-errors'

const REWARD_PROVIDER_LABELS: Record<UserReward['provider'], string> = {
  merkl: 'Merkl',
  brevis: 'Incentra',
  fuul: 'Fuul',
  turtle: 'Turtle',
}

const REWARD_PROVIDER_TYPES: Record<UserReward['provider'], 'reward' | 'brevis-reward' | 'fuul-reward' | 'turtle-reward'> = {
  merkl: 'reward',
  brevis: 'brevis-reward',
  fuul: 'fuul-reward',
  turtle: 'turtle-reward',
}

const { reward } = defineProps<{ reward: UserReward }>()
const rewardKey = computed(() =>
  `${reward.chainId}:${reward.provider}:${reward.token.address.toLowerCase()}:${reward.unclaimed}`,
)
const rewardClaimKey = computed(() => [
  reward.chainId,
  reward.provider,
  reward.claimAddress?.toLowerCase() ?? '',
  reward.campaignId ?? '',
  reward.streamId ?? '',
  reward.token.address.toLowerCase(),
  reward.unclaimed,
].join(':'))

const { buildClaimRewardPlan, refreshRewards } = useSdkRewards()
const { refreshLocks } = useREULLocks()
const { addEntry: addBatchEntry, entries: batchEntries, entryCount, clearBatch } = useTxBatch()
const { executePlan } = useEulerTx()
const { getTokenByAddress } = useTokenList()
const { isSpyMode } = useSpyMode()
const { settings } = useUserSettings()
const { eulerTokenAddresses } = useEulerAddresses()
const modal = useModal()
const { error } = useToast()
const { chainId: walletChainId, switchChain } = useWagmi()
const { runSimulation, simulationError } = useTransactionPlanSimulation()

const isClaiming = ref(false)
const isPreparing = ref(false)
const isAddingToBatch = ref(false)
const plan = ref<TransactionPlan | null>(null)

const rewardAmount = computed(() => Number(formatUnits(BigInt(reward.unclaimed), reward.token.decimals)))
const rewardUsdValue = computed(() => rewardAmount.value * reward.tokenPrice)
const providerLabel = computed(() => REWARD_PROVIDER_LABELS[reward.provider] ?? reward.provider)
const planKind = computed(() => REWARD_PROVIDER_TYPES[reward.provider] ?? 'reward')
const isREULReward = computed(() => {
  const reulAddress = eulerTokenAddresses.value?.rEUL
  if (reulAddress) {
    return reward.token.address.toLowerCase() === reulAddress.toLowerCase()
  }
  return reward.token.symbol.toLowerCase() === 'reul'
})
const canAddToBatch = computed(() =>
  settings.value.enableAdvancedMode && reward.provider !== 'turtle' && !isREULReward.value,
)
const isInBatch = computed(() =>
  batchEntries.value.some(entry => entry.rewardClaimKey === rewardClaimKey.value),
)
const isREULBatchBlocked = computed(() => isREULReward.value && entryCount.value > 0)
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
  if (isREULBatchBlocked.value) {
    error('Clear the current batch before claiming rEUL')
    return
  }

  if (isSpyMode.value) {
    error('Exit spy mode to claim rewards')
    return
  }

  try {
    isClaiming.value = true

    if (!plan.value) {
      plan.value = await buildClaimRewardPlan(reward)
    }
    if (isREULBatchBlocked.value) {
      error('Clear the current batch before claiming rEUL')
      return
    }
    await executePlan(plan.value)
    if (isREULReward.value) {
      await refreshLocks(true)
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

const onAddToBatchClick = async () => {
  if (!canAddToBatch.value || isPreparing.value || isClaiming.value || isAddingToBatch.value || isInBatch.value) return
  isAddingToBatch.value = true
  try {
    await ensureWalletOnClaimChain()
    await addBatchEntry({
      label: `Claim ${reward.token.symbol}`,
      rewardClaimKey: rewardClaimKey.value,
      requiresPlanningAccount: false,
      buildPlan: async () => buildClaimRewardPlan(reward),
      review: {
        type: planKind.value,
        asset: {
          symbol: reward.token.symbol,
          address: reward.token.address,
          decimals: reward.token.decimals,
        },
        assetIconUrl: externalIconUrl.value,
        amount: rewardAmount.value,
        submittingLabel: 'Claiming...',
      },
    })
  }
  catch (e) {
    let description = 'Unable to prepare this reward claim.'
    try {
      description = await getTxErrorMessage(e)
    }
    catch (messageError) {
      logWarn('PortfolioSdkRewardItem/onAddToBatchClick/getTxErrorMessage', messageError)
    }
    error('Failed to add to batch', { description })
    logWarn('PortfolioSdkRewardItem/onAddToBatchClick', e)
  }
  finally {
    isAddingToBatch.value = false
  }
}

const onClaimClick = async () => {
  if (isREULBatchBlocked.value) {
    error('Clear the current batch before claiming rEUL')
    return
  }
  if (isInBatch.value) return

  if (isSpyMode.value) {
    error('Exit spy mode to claim rewards')
    return
  }

  if (isPreparing.value || isAddingToBatch.value) return
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
    if (isREULBatchBlocked.value) {
      error('Clear the current batch before claiming rEUL')
      return
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
    class="relative overflow-hidden bg-surface rounded-xl border border-line-subtle shadow-card p-16 transition-all duration-default ease-default"
    :class="{ '!border !border-dashed !border-line-emphasis': isInBatch }"
    data-id="portfolio-list-item"
    data-list="sdk-rewards"
    :data-key="rewardKey"
    :data-token-address="reward.token.address.toLowerCase()"
    :data-batch-queued="isInBatch ? 'true' : undefined"
  >
    <div
      v-if="isInBatch"
      class="pointer-events-none absolute inset-0 z-10"
      style="background: repeating-linear-gradient(45deg, transparent 0 9px, rgba(114, 131, 149, .06) 9px 18px);"
      aria-hidden="true"
    />
    <div
      class="relative z-0 flex flex-col gap-12"
      :class="{ 'opacity-50 pointer-events-none': isInBatch }"
    >
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
      <div :class="canAddToBatch ? 'grid grid-cols-2 gap-8' : 'grid grid-cols-1'">
        <UiButton
          rounded
          :loading="isClaiming || isPreparing"
          :disabled="isSpyMode || isAddingToBatch || isInBatch || isREULBatchBlocked"
          @click="onClaimClick"
        >
          Claim
        </UiButton>
        <UiButton
          v-if="canAddToBatch"
          rounded
          variant="primary-stroke"
          :loading="isAddingToBatch"
          :disabled="isSpyMode || isClaiming || isPreparing || isInBatch"
          @click="onAddToBatchClick"
        >
          {{ isInBatch ? 'In batch' : 'Add to batch' }}
        </UiButton>
      </div>
      <p
        v-if="isREULBatchBlocked"
        class="text-center text-p3 text-content-tertiary"
        data-testid="reward-batch-blocked"
      >
        Clear the current batch before claiming rEUL ·
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
