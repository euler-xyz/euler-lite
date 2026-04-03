<script setup lang="ts">
import { OperationReviewModal } from '#components'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import type { Campaign } from '~/entities/brevis'
import type { TxPlan } from '~/entities/txPlan'
import { logWarn } from '~/utils/errorHandling'
import { formatNumber, formatUsdValue } from '~/utils/string-utils'

const { campaign } = defineProps<{ campaign: Campaign }>()

const { getVault } = useVaults()
const { claimReward, loadRewards, buildClaimRewardPlan } = useBrevis()
const { isSpyMode } = useSpyMode()
const modal = useModal()
const { error } = useToast()
const { chainId: siteChainId } = useEulerAddresses()
const { chainId: walletChainId, switchChain } = useWagmi()
const { runSimulation, simulationError } = useTxPlanSimulation()

const vault = ref(campaign.vault_address ? await getVault(campaign.vault_address) : undefined)
const isClaiming = ref(false)
const isPreparing = ref(false)
const plan = ref<TxPlan | null>(null)
const rewardAmount = computed(() => Number.parseFloat(campaign.reward_info.reward_amt))
const rewardUsdValue = computed(() => rewardAmount.value * Number.parseFloat(campaign.reward_info.reward_usd_price))
const actionLabel = computed(() => campaign.action === 2001 ? 'Borrow' : 'Lend')

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

    await claimReward(campaign)
    modal.close()
    loadRewards(false, true)
  }
  catch (e) {
    error('Transaction failed')
    logWarn('PortfolioBrevisRewardItem/claim', e)
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
      plan.value = await buildClaimRewardPlan(campaign)
    }
    catch (e) {
      logWarn('PortfolioBrevisRewardItem/buildPlan', e)
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
        type: 'brevis-reward',
        asset: {
          symbol: campaign.reward_info.token_symbol,
          address: campaign.reward_info.token_address,
          decimals: 18,
        },
        amount: rewardAmount.value,
        campaignInfo: campaign,
        plan: plan.value || undefined,
        onConfirm: () => {
          setTimeout(() => {
            claim()
          }, 400)
        },
      },
    })
  }
  catch (e) {
    logWarn('PortfolioBrevisRewardItem/onClaimClick', e)
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
        <div class="flex items-center">
          <AssetAvatar
            v-if="vault"
            :asset="vault.asset"
            size="40"
          />
          <div class="ml-12">
            <h4 class="text-h5 mb-4 text-content-primary">
              {{ campaign.reward_info.token_symbol }}
            </h4>
            <p class="text-p3 text-content-tertiary">
              {{ actionLabel }} {{ vault?.asset.symbol }}
            </p>
          </div>
        </div>
        <div class="flex flex-col gap-8 text-right">
          <p class="text-p2 text-content-primary">
            {{ formatUsdValue(rewardUsdValue) }}
          </p>
          <p class="text-p3 text-content-tertiary">
            ~ {{ rewardAmount < 0.01 ? '< 0.01' : formatNumber(rewardAmount, 2) }} {{ campaign.reward_info.token_symbol }}
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
