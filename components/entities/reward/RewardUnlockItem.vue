<script setup lang="ts">
import { DateTime } from 'luxon'
import { OperationReviewModal } from '#components'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import type { REULLock } from '~/entities/reul'
import type { TxPlan } from '~/entities/txPlan'
import { logWarn } from '~/utils/errorHandling'
import { formatNumber } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'

const modal = useModal()
const { error } = useToast()
const { rewardTokens, isTokensLoading } = useMerkl()
const { unlockREUL, buildUnlockREULPlan, reulTokenContractAddress } = useREULLocks()
const { chainId: siteChainId } = useEulerAddresses()
const { chainId: walletChainId, switchChain } = useWagmi()
const { runSimulation, simulationError } = useTxPlanSimulation()
const { item } = defineProps<{ item: REULLock }>()

const isUnlocking = ref(false)
const isPreparing = ref(false)
const plan = ref<TxPlan | null>(null)

const reulToken = computed(() => {
  if (isTokensLoading.value && rewardTokens.value.length === 0) {
    return
  }
  return rewardTokens.value.find(token => token.symbol === 'rEUL')
})

const unlockableAmount = computed(() => {
  return nanoToValue(item.unlockableAmount, reulToken.value?.decimals)
})

const amount = computed(() => {
  return nanoToValue(item.amount, reulToken.value?.decimals)
})

const amountToBeBurned = computed(() => {
  return nanoToValue(item.amountToBeBurned, reulToken.value?.decimals)
})

const formattedDate = computed(() => {
  return DateTime.fromSeconds(Number(item.timestamp)).plus({ days: 180 }).toFormat('MMMM dd, yyyy')
})

const daysUntilMaturity = computed(() => {
  return Math.max(0, Math.floor(DateTime.fromSeconds(Number(item.timestamp)).plus({ days: 180 }).diffNow('days').days))
})

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

const unlock = async () => {
  try {
    isUnlocking.value = true

    await unlockREUL([item.timestamp])
    modal.close()
  }
  catch (e) {
    error('Transaction failed')
    logWarn('RewardUnlockItem/unlock', e)
  }
  finally {
    isUnlocking.value = false
  }
}

const onUnlockClick = async () => {
  if (isPreparing.value) return
  isPreparing.value = true
  try {
    await ensureWalletOnSiteChain()

    // Build the transaction plan
    try {
      plan.value = await buildUnlockREULPlan([item.timestamp])
    }
    catch (e) {
      logWarn('RewardUnlockItem/buildPlan', e)
      plan.value = null
    }

    if (plan.value) {
      const ok = await runSimulation(plan.value)
      if (!ok) {
        return
      }
    }

    // Open the operation review modal (same pattern as Merkl/Brevis)
    modal.open(OperationReviewModal, {
      props: {
        type: 'reul-unlock',
        asset: {
          symbol: 'EUL',
          address: reulTokenContractAddress.value,
          decimals: reulToken.value?.decimals || 18,
        },
        amount: unlockableAmount.value,
        plan: plan.value || undefined,
        reulUnlockInfo: {
          unlockableAmount: unlockableAmount.value,
          amountToBeBurned: amountToBeBurned.value,
          maturityDate: formattedDate.value,
          daysUntilMaturity: daysUntilMaturity.value,
        },
        onConfirm: () => {
          setTimeout(() => {
            unlock()
          }, 400)
        },
      },
    })
  }
  catch (e) {
    logWarn('RewardUnlockItem/onUnlockClick', e)
  }
  finally {
    isPreparing.value = false
  }
}
</script>

<template>
  <div
    class="flex flex-col gap-12 bg-euler-dark-500 rounded-16"
  >
    <div
      class="flex justify-between items-center p-16 pb-12 border-b border-border-primary"
    >
      <AssetAvatar
        :asset="{ address: '', symbol: 'EUL' }"
        size="40"
      />
      <h4 class="text-h5 ml-12">
        rEUL
      </h4>
      <div class="flex flex-col gap-8 ml-auto text-right">
        <p class="text-p2 tabular-nums">
          {{ reulToken ? `${formatNumber(unlockableAmount, 6)} rEUL` : '...' }}
        </p>
        <p class="text-p3 text-euler-dark-900 tabular-nums">
          {{ reulToken ? `of ${formatNumber(amount, 6)} rEUL` : '...' }}
        </p>
      </div>
    </div>
    <div class="pb-16 pl-16 pr-16">
      <div class="flex justify-between items-center mb-16">
        <div class="text-euler-dark-900">
          Maturity date
        </div>
        <div class="text-right flex flex-col gap-4 text-p2">
          <div class="tabular-nums">
            in {{ daysUntilMaturity }} days
          </div>
          <div class="text-euler-dark-900">
            {{ formattedDate }}
          </div>
        </div>
      </div>
      <UiButton
        variant="primary-stroke"
        rounded
        :loading="isUnlocking || isPreparing"
        @click="onUnlockClick"
      >
        Unlock
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
