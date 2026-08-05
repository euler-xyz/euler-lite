<script setup lang="ts">
import { DateTime } from 'luxon'
import { OperationReviewModal } from '#components'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import type { REULLock } from '~/entities/reul'
import type { TransactionPlan, TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { logWarn } from '~/utils/errorHandling'
import { formatNumber } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import { requireReviewedExecution } from '~/utils/reviewed-execution'

const modal = useModal()
const { error } = useToast()
const { isSpyMode } = useSpyMode()
const { getTokenByAddress } = useTokenList()
const { buildUnlockREULPlan, reulTokenContractAddress, eulTokenContractAddress, refreshLocks } = useREULLocks()
const { addEntry: addBatchEntry } = useTxBatch()
const { executePreparedPlan } = useEulerTx()
const { chainId: siteChainId } = useEulerAddresses()
const { chainId: walletChainId, switchChain } = useWagmi()
const { runSimulation, simulationError } = useTransactionPlanSimulation()
const { settings } = useUserSettings()
const { item } = defineProps<{ item: REULLock }>()
const itemKey = computed(() => item.timestamp.toString())

const isUnlocking = ref(false)
const isPreparing = ref(false)
const isAddingToBatch = ref(false)
const plan = ref<TransactionPlan | null>(null)

// rEUL address is read from chain contract config (reulTokenContractAddress) —
// the authoritative source. Its metadata (symbol, decimals, logo) is looked
// up in the unified token list like any other token; Merkl's reward-token
// feed is one of the token-list sources and typically covers rEUL.
const reulToken = computed(() => getTokenByAddress(reulTokenContractAddress.value))
const eulToken = computed(() => getTokenByAddress(eulTokenContractAddress.value))
const walletChangeTokenAddress = computed(() => eulTokenContractAddress.value || reulTokenContractAddress.value)
const walletChangeToken = computed(() => eulTokenContractAddress.value ? eulToken.value : reulToken.value)
const walletChangeTokenSymbol = computed(() =>
  walletChangeToken.value?.symbol ?? (eulTokenContractAddress.value ? 'EUL' : 'rEUL'),
)
const walletChangeTokenDecimals = computed(() => eulToken.value?.decimals ?? reulToken.value?.decimals ?? 18)
const canAddToBatch = computed(() => settings.value.enableAdvancedMode)

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

const unlock = async (reviewed: TransactionPlanPrepared | undefined) => {
  try {
    isUnlocking.value = true

    await executePreparedPlan(requireReviewedExecution(reviewed))
    modal.close()
    await refreshLocks(false)
  }
  catch (e) {
    error('Transaction failed')
    logWarn('RewardUnlockItem/unlock', e)
  }
  finally {
    isUnlocking.value = false
  }
}

const getReviewProps = () => ({
  type: 'reul-unlock',
  asset: {
    symbol: walletChangeTokenSymbol.value,
    address: walletChangeTokenAddress.value,
    decimals: walletChangeTokenDecimals.value,
  },
  amount: unlockableAmount.value,
  reulUnlockInfo: {
    unlockableAmount: unlockableAmount.value,
    amountToBeBurned: amountToBeBurned.value,
    maturityDate: formattedDate.value,
    daysUntilMaturity: daysUntilMaturity.value,
  },
  submittingLabel: 'Unlocking...',
})

const onAddToBatchClick = async () => {
  if (!canAddToBatch.value || isPreparing.value || isUnlocking.value || isAddingToBatch.value) return
  isAddingToBatch.value = true
  try {
    await ensureWalletOnSiteChain()
    await addBatchEntry({
      label: 'Unlock rEUL',
      requiresPlanningAccount: false,
      buildPlan: async () => buildUnlockREULPlan([item.timestamp]),
      review: getReviewProps(),
    })
  }
  catch (e) {
    error('Failed to add to batch')
    logWarn('RewardUnlockItem/onAddToBatchClick', e)
  }
  finally {
    isAddingToBatch.value = false
  }
}

const onUnlockClick = async () => {
  if (isPreparing.value || isAddingToBatch.value) return
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

    // Open the operation review modal (same pattern as reward claims)
    modal.open(OperationReviewModal, {
      props: {
        ...getReviewProps(),
        amount: unlockableAmount.value,
        plan: plan.value || undefined,
        onConfirm: async (reviewed: TransactionPlanPrepared | undefined) => {
          await unlock(reviewed)
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
    class="flex flex-col gap-12 bg-card rounded-16"
    data-id="reward-unlock-list-item"
    data-list="reul-unlock"
    :data-key="itemKey"
    :data-timestamp="item.timestamp.toString()"
  >
    <div
      class="flex justify-between items-center p-16 pb-12 border-b border-line-default"
    >
      <AssetAvatar
        :asset="{ address: '', symbol: 'EUL' }"
        size="40"
      />
      <h4 class="text-h5 ml-12">
        rEUL
      </h4>
      <div class="flex flex-col gap-8 ml-auto text-right">
        <p
          class="text-p2"
          data-id="data-point"
          :data-key="itemKey"
          data-field="unlockable-amount"
          :data-value="unlockableAmount"
        >
          {{ reulToken ? `${formatNumber(unlockableAmount, 6)} rEUL` : '...' }}
        </p>
        <p
          class="text-p3 text-content-primary"
          data-id="data-point"
          :data-key="itemKey"
          data-field="locked-amount"
          :data-value="amount"
        >
          {{ reulToken ? `of ${formatNumber(amount, 6)} rEUL` : '...' }}
        </p>
      </div>
    </div>
    <div class="pb-16 pl-16 pr-16">
      <div class="flex justify-between items-center mb-16">
        <div class="text-content-primary">
          Maturity date
        </div>
        <div class="text-right flex flex-col gap-4 text-p2">
          <div
            data-id="data-point"
            :data-key="itemKey"
            data-field="days-until-maturity"
            :data-value="daysUntilMaturity"
          >
            in {{ daysUntilMaturity }} days
          </div>
          <div
            class="text-content-primary"
            data-id="data-point"
            :data-key="itemKey"
            data-field="maturity-date"
            :data-value="formattedDate"
          >
            {{ formattedDate }}
          </div>
        </div>
      </div>
      <div :class="canAddToBatch ? 'grid grid-cols-2 gap-8' : 'grid grid-cols-1'">
        <UiButton
          rounded
          :loading="isUnlocking || isPreparing"
          :disabled="isSpyMode || isAddingToBatch"
          @click="onUnlockClick"
        >
          Unlock
        </UiButton>
        <UiButton
          v-if="canAddToBatch"
          rounded
          variant="primary-stroke"
          :loading="isAddingToBatch"
          :disabled="isSpyMode || isUnlocking || isPreparing"
          @click="onAddToBatchClick"
        >
          Add to batch
        </UiButton>
      </div>
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
