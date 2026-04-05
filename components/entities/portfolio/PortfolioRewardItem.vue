<script setup lang="ts">
import { OperationReviewModal } from '#components'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import type { Reward } from '~/entities/merkl'
import type { TxPlan } from '~/entities/txPlan'
import { logWarn } from '~/utils/errorHandling'
import { formatNumber, formatUsdValue } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'

const { reward } = defineProps<{ reward: Reward }>()

const { isTokensLoading, rewardTokens, claimReward, loadRewards, buildClaimRewardPlan } = useMerkl()
const { isSpyMode } = useSpyMode()
const modal = useModal()
const { error } = useToast()
const { chainId: siteChainId } = useEulerAddresses()
const { chainId: walletChainId, switchChain } = useWagmi()
const { runSimulation, simulationError } = useTxPlanSimulation()

const isClaiming = ref(false)
const isPreparing = ref(false)
const plan = ref<TxPlan | null>(null)

const amount = computed(() => nanoToValue(reward.amount, reward.token.decimals))
const claimed = computed(() => nanoToValue(reward.claimed, reward.token.decimals))
const amountToClaim = computed(() => amount.value - claimed.value)
const amountInUsd = computed(() => amountToClaim.value * reward.token.price)
const isEulFamily = computed(() => ['rEUL', 'EUL'].includes(reward.token.symbol))
const externalIconUrl = computed(() => {
  if (isTokensLoading.value || isEulFamily.value) return undefined
  return rewardTokens.value.find(token => token.address === reward.token.address)?.icon
    || undefined
})
const hasIcon = computed(() => isEulFamily.value || !!externalIconUrl.value)
const avatarAsset = computed(() => isEulFamily.value
  ? { address: reward.token.address, symbol: 'EUL' }
  : { address: reward.token.address, symbol: reward.token.symbol },
)

const ensureWalletOnSiteChain = async () => {
  const targetChainId = siteChainId.value
  if (!targetChainId) {
    return
  }

  if (walletChainId.value === targetChainId) {
    return
  }

  await switchChain({ chainId: targetChainId })
  await until(walletChainId).toBe(targetChainId, { timeout: 8000, throwOnTimeout: false })
}

const claim = async () => {
  try {
    isClaiming.value = true

    await claimReward(reward)
    modal.close()
    loadRewards(siteChainId.value, false, true)
  }
  catch (e) {
    error('Transaction failed')
    logWarn('PortfolioRewardItem/claim', e)
  }
  finally {
    isClaiming.value = false
  }
}

const onClaimClick = async () => {
  if (isPreparing.value) return
  isPreparing.value = true
  try {
    await ensureWalletOnSiteChain()

    try {
      plan.value = await buildClaimRewardPlan(reward)
    }
    catch (e) {
      logWarn('PortfolioRewardItem/buildPlan', e)
      plan.value = null
    }

    if (plan.value) {
      const ok = await runSimulation(plan.value)
      if (!ok) {
        return
      }
    }

    modal.open(OperationReviewModal, {
      props: {
        type: 'reward',
        asset: reward.token,
        assetIconUrl: externalIconUrl.value,
        amount: amountToClaim.value,
        plan: plan.value || undefined,
        submittingLabel: 'Claiming...',
        onConfirm: async () => {
          await claim()
        },
      },
    })
  }
  catch (e) {
    logWarn('PortfolioRewardItem/onClaimClick', e)
  }
  finally {
    isPreparing.value = false
  }
}
</script>

<template>
  <div
    class="bg-surface rounded-xl border border-line-subtle shadow-card p-16"
  >
    <div
      class="flex flex-col gap-12"
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
        <h4 class="text-h5 ml-12 text-content-primary">
          {{ reward.token.symbol }}
        </h4>
        <div class="flex flex-col gap-8 ml-auto text-right">
          <p class="text-p2 text-content-primary">
            {{ formatUsdValue(amountInUsd) }}
          </p>
          <p class="text-p3 text-content-tertiary">
            ~ {{ amountToClaim < 0.01 ? '< 0.01' : formatNumber(amountToClaim, 2) }} {{ reward.token.symbol }}
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
      <UiToast
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
