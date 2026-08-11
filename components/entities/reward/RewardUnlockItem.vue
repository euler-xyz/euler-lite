<script setup lang="ts">
import { DateTime } from 'luxon'
import { OperationReviewModal } from '#components'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import type { REULLock } from '~/entities/reul'
import { logWarn } from '~/utils/errorHandling'
import { getTxErrorMessage } from '~/utils/tx-errors'
import { formatNumber } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import { markTrackedExecutionSucceeded } from '~/composables/useSafeExecutionDetachment'
import {
  prepareREULUnlockPlan,
  refreshREULLockReview,
  runWithFreshREULLockReview,
  type REULLockReviewValidation,
} from '~/components/entities/reward/reulUnlockReview'

const modal = useModal()
const { error } = useToast()
const { isSpyMode } = useSpyMode()
const { getTokenByAddress } = useTokenList()
const { buildUnlockREULPlan, reulTokenContractAddress, eulTokenContractAddress, refreshLocks } = useREULLocks()
const { entryCount, clearBatch } = useTxBatch()
const { executePlan } = useEulerTx()
const { chainId: siteChainId } = useEulerAddresses()
const { chainId: walletChainId, switchChain } = useWagmi()
const { runSimulation, simulationError } = useTransactionPlanSimulation()
const { item } = defineProps<{ item: REULLock }>()
const itemKey = computed(() => item.timestamp.toString())

const isUnlocking = ref(false)
const isPreparing = ref(false)

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
const isBatchActive = computed(() => entryCount.value > 0)

const unlockableAmount = computed(() => {
  return nanoToValue(item.unlockableAmount, reulToken.value?.decimals)
})

const amount = computed(() => {
  return nanoToValue(item.amount, reulToken.value?.decimals)
})

const getFormattedDate = (lock: REULLock) =>
  DateTime.fromSeconds(Number(lock.timestamp)).plus({ days: 180 }).toFormat('MMMM dd, yyyy')
const formattedDate = computed(() => getFormattedDate(item))

const getDaysUntilMaturity = (lock: REULLock) =>
  Math.max(0, Math.floor(DateTime.fromSeconds(Number(lock.timestamp)).plus({ days: 180 }).diffNow('days').days))
const daysUntilMaturity = computed(() => getDaysUntilMaturity(item))

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

const showReviewRefreshError = (status: Exclude<REULLockReviewValidation['status'], 'fresh'>) => {
  if (status === 'changed') {
    error('The rEUL unlock amount changed. Review the updated values and try again.')
  }
  else if (status === 'missing') {
    error('This rEUL lock is no longer available.')
  }
  else {
    error('Unable to refresh the rEUL lock. Try again.')
  }
}

const showPreparationError = async (cause: unknown) => {
  let description = 'Unable to prepare this rEUL unlock.'
  try {
    description = await getTxErrorMessage(cause)
  }
  catch (messageError) {
    logWarn('RewardUnlockItem/getTxErrorMessage', messageError)
  }
  error('Unable to prepare rEUL unlock', { description })
}

const unlock = async (reviewedLock: REULLock) => {
  if (isBatchActive.value) {
    error('Clear the current batch before unlocking rEUL')
    return
  }

  try {
    isUnlocking.value = true

    const result = await runWithFreshREULLockReview(
      reviewedLock,
      () => refreshLocks(true),
      async (currentLock) => {
        if (isBatchActive.value) {
          modal.close()
          error('Clear the current batch before unlocking rEUL')
          return false
        }

        const unlockPlan = await buildUnlockREULPlan([currentLock.timestamp])
        if (isBatchActive.value) {
          modal.close()
          error('Clear the current batch before unlocking rEUL')
          return false
        }

        await executePlan(unlockPlan)
        // Success signal for a detached Safe completion toast — this flow
        // closes without navigating, so only the mark is needed.
        markTrackedExecutionSucceeded()
        modal.close()
        await refreshLocks(true)
        return true
      },
    )
    if (result.status === 'changed' || result.status === 'missing' || result.status === 'unavailable') {
      modal.close()
      showReviewRefreshError(result.status)
    }
  }
  catch (e) {
    error('Transaction failed')
    logWarn('RewardUnlockItem/unlock', e)
  }
  finally {
    isUnlocking.value = false
  }
}

const getReviewProps = (reviewedLock: REULLock) => ({
  type: 'reul-unlock',
  asset: {
    symbol: walletChangeTokenSymbol.value,
    address: walletChangeTokenAddress.value,
    decimals: walletChangeTokenDecimals.value,
  },
  amount: nanoToValue(reviewedLock.unlockableAmount, reulToken.value?.decimals),
  reulUnlockInfo: {
    unlockableAmount: nanoToValue(reviewedLock.unlockableAmount, reulToken.value?.decimals),
    amountToBeBurned: nanoToValue(reviewedLock.amountToBeBurned, reulToken.value?.decimals),
    maturityDate: getFormattedDate(reviewedLock),
    daysUntilMaturity: getDaysUntilMaturity(reviewedLock),
  },
  submittingLabel: 'Unlocking...',
})

const onUnlockClick = async () => {
  if (isBatchActive.value) {
    error('Clear the current batch before unlocking rEUL')
    return
  }

  if (isPreparing.value) return
  isPreparing.value = true
  try {
    await ensureWalletOnSiteChain()

    const validation = await refreshREULLockReview(item, () => refreshLocks(true))
    if (validation.status !== 'fresh') {
      showReviewRefreshError(validation.status)
      return
    }
    if (isBatchActive.value) {
      error('Clear the current batch before unlocking rEUL')
      return
    }
    const reviewedLock = validation.lock

    const preparation = await prepareREULUnlockPlan(
      reviewedLock,
      lock => buildUnlockREULPlan([lock.timestamp]),
      runSimulation,
    )
    if (preparation.status === 'build-failed') {
      logWarn('RewardUnlockItem/buildPlan', preparation.error)
      await showPreparationError(preparation.error)
      return
    }
    if (preparation.status === 'simulation-failed') {
      error('Simulation failed', {
        description: simulationError.value || 'Unable to simulate this rEUL unlock. Try again.',
      })
      return
    }
    if (isBatchActive.value) {
      error('Clear the current batch before unlocking rEUL')
      return
    }

    // Open the operation review modal (same pattern as reward claims)
    modal.open(OperationReviewModal, {
      props: {
        ...getReviewProps(reviewedLock),
        plan: preparation.plan,
        onConfirm: async () => {
          await unlock(reviewedLock)
        },
      },
    })
  }
  catch (e) {
    await showPreparationError(e)
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
      <div class="grid grid-cols-1">
        <UiButton
          rounded
          :loading="isUnlocking || isPreparing"
          :disabled="isSpyMode || isBatchActive"
          @click="onUnlockClick"
        >
          Unlock
        </UiButton>
      </div>
      <p
        v-if="isBatchActive"
        class="mt-8 text-center text-p3 text-content-tertiary"
        data-testid="reul-unlock-batch-blocked"
      >
        Clear the current batch before unlocking rEUL ·
        <button
          type="button"
          class="text-accent-500 hover:text-accent-600"
          data-testid="reul-unlock-clear-batch"
          @click="clearBatch"
        >
          Clear batch
        </button>
      </p>
    </div>
  </div>
</template>
