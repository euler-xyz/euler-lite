<script setup lang="ts">
import { OperationReviewModal } from '#components'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import type { FuulClaimableReward } from '~/entities/fuul'
import type { TxPlan } from '~/entities/txPlan'
import { logWarn } from '~/utils/errorHandling'
import { formatNumber } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'

const { reward } = defineProps<{ reward: FuulClaimableReward }>()
const rewardKey = computed(() => `${reward.currency_address}:${reward.amount.toString()}`.toLowerCase())

const { claimReward, loadClaimableRewards, buildClaimRewardPlan } = useFuul()
const { isSpyMode } = useSpyMode()
const modal = useModal()
const { error } = useToast()
const { chainId: siteChainId } = useEulerAddresses()
const { chainId: walletChainId, switchChain } = useWagmi()
const { runSimulation, simulationError } = useTxPlanSimulation()

const isClaiming = ref(false)
const isPreparing = ref(false)
const plan = ref<TxPlan | null>(null)

const rewardAmount = computed(() => nanoToValue(reward.amount, reward.currency_decimals))

const ensureWalletOnSiteChain = async () => {
  const targetChainId = siteChainId.value
  if (!targetChainId) return

  if (walletChainId.value === targetChainId) return

  await switchChain({ chainId: targetChainId })
  await until(walletChainId).toBe(targetChainId, { timeout: 8000, throwOnTimeout: false })
}

const claim = async () => {
  try {
    isClaiming.value = true

    await claimReward(reward)
    modal.close()
    loadClaimableRewards(false, true)
  }
  catch (e) {
    error('Transaction failed')
    logWarn('PortfolioFuulRewardItem/claim', e)
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
      logWarn('PortfolioFuulRewardItem/buildPlan', e)
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
        type: 'fuul-reward',
        asset: {
          symbol: reward.currency_name,
          address: reward.currency_address,
          decimals: reward.currency_decimals,
        },
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
    logWarn('PortfolioFuulRewardItem/onClaimClick', e)
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
    data-list="fuul-rewards"
    :data-key="rewardKey"
    :data-token-address="reward.currency_address.toLowerCase()"
  >
    <div
      class="flex flex-col gap-12"
    >
      <div class="flex justify-between items-center mb-12">
        <div class="flex items-center">
          <div class="ml-12">
            <h4
              class="text-h5 mb-4 text-content-primary"
              data-id="data-point"
              :data-key="rewardKey"
              data-field="reward-symbol"
              :data-value="reward.currency_name"
            >
              {{ reward.currency_name }}
            </h4>
          </div>
        </div>
        <div class="flex flex-col gap-8 text-right">
          <p
            class="text-p2 text-content-primary"
            data-id="data-point"
            :data-key="rewardKey"
            data-field="reward-amount"
            :data-value="rewardAmount"
          >
            ~ {{ rewardAmount < 0.01 ? '< 0.01' : formatNumber(rewardAmount, 2) }} {{ reward.currency_name }}
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
