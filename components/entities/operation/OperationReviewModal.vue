<script setup lang="ts">
import type { VaultAsset } from '~/types/asset'
import { encodeFunctionData, type Address, type Hex, type StateOverride } from 'viem'
import { flattenBatchEntries, type SwapperMode, type EVCBatchItem, type TransactionPlan, type TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { buildTransactionPlanDisplaySteps, type DisplayStep, type StepDecodingContext } from '~/utils/stepDecoding'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { getEulerSdk } from '~/composables/useEulerSdk'
import { logWarn } from '~/utils/errorHandling'
import { formatNumber } from '~/utils/string-utils'
import { getAssetLogoUrl } from '~/composables/useTokenList'

const emits = defineEmits(['close', 'confirm'])

interface REULUnlockInfo {
  unlockableAmount: number
  amountToBeBurned: number
  maturityDate: string
  daysUntilMaturity: number
}

const { type, asset, assetIconUrl, reulUnlockInfo, amount, onConfirm, plan, prepared, swapToAsset, swapToAmount, swapMode, swapEstimatedSide, supplyingAssetForBorrow, supplyingAmount, transferAmounts, submittingLabel, quoteFetchedAt } = defineProps<{
  type?: 'supply' | 'withdraw' | 'borrow' | 'repay' | 'swap' | 'transfer' | 'reward' | 'brevis-reward' | 'fuul-reward' | 'reul-unlock' | 'disableCollateral' | 'swap-supply' | 'swap-withdraw' | 'swap-borrow'
  asset: VaultAsset
  assetIconUrl?: string
  amount: number | string
  /** Raw plan, used as a fallback when the caller hasn't pre-prepared.
   *  Migrated callers should pass `prepared` instead. */
  plan?: TransactionPlan
  /** Pre-prepared envelope. When set, the modal renders immediately — no
   *  in-modal plugin/approval-resolution round-trip. */
  prepared?: TransactionPlanPrepared
  supplyingAssetForBorrow?: VaultAsset
  supplyingAmount?: number | string
  swapToAsset?: VaultAsset
  swapToAmount?: number | string
  swapMode?: SwapperMode
  swapEstimatedSide?: 'input' | 'output'
  reulUnlockInfo?: REULUnlockInfo
  onConfirm: () => void | Promise<void>
  subAccount?: string
  hasBorrows?: boolean
  transferAmounts?: Record<string, string>
  submittingLabel?: string
  /** Milliseconds since epoch when the active swap quote was fetched */
  quoteFetchedAt?: number | null
}>()

const { address: walletAddress, chainId: currentChainId } = useWagmi()
const { isSpyMode } = useSpyMode()
const { getVault } = useVaultRegistry()
const { prepareTransactionPlan } = useEulerTx()
const {
  isSimulating: isTenderlySimulating,
  simulationError: tenderlyError,
  simulationUrl: tenderlyUrl,
  simulate: tenderlySimulate,
  clearSimulation: clearTenderly,
  fetchEnabled: fetchTenderlyEnabled,
} = useTenderlySimulation()

const tenderlyEnabled = ref(false)
const { copied, copyToClipboard } = useClipboardCopy()
const nowMs = ref(Date.now())
const staleQuoteThresholdMs = 3 * 60 * 1000
let nowTimer: ReturnType<typeof setInterval> | undefined
// `preparedPlan` is the prepared envelope's plan when the caller passed
// `prepared`, otherwise it's the result of an on-the-fly prepare for callers
// still on the legacy raw-plan path. Once every caller migrates, the
// raw-plan branch below can be deleted.
const preparedPlan = shallowRef<TransactionPlan | undefined>()
const prepareError = ref('')
const isPreparingPlan = ref(false)
const reviewPlan = computed(() => preparedPlan.value)
let prepareRequestId = 0

fetchTenderlyEnabled().then((enabled) => {
  tenderlyEnabled.value = enabled
})

onMounted(() => {
  nowTimer = setInterval(() => {
    nowMs.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (nowTimer) {
    clearInterval(nowTimer)
  }
})

const findFirstEvcBatch = (p?: TransactionPlan) => p?.find(item => item.type === 'evcBatch')
const toTenderlyStateOverrides = (overrides: StateOverride) =>
  overrides.flatMap((entry) => {
    if (!entry.stateDiff?.length) return []
    return [{
      address: entry.address,
      stateDiff: entry.stateDiff.map(diff => ({
        slot: diff.slot,
        value: diff.value,
      })),
    }]
  })

watch(
  () => [prepared, plan, walletAddress.value, currentChainId.value] as const,
  async () => {
    const requestId = ++prepareRequestId
    prepareError.value = ''
    preparedPlan.value = undefined

    // Preferred path: caller pre-prepared the envelope. No async work — modal
    // renders the prepared plan synchronously.
    if (prepared?.plan?.length) {
      preparedPlan.value = prepared.plan
      isPreparingPlan.value = false
      return
    }

    if (!plan?.length) {
      isPreparingPlan.value = false
      prepareError.value = 'Transaction plan is unavailable. Close this review and try again.'
      return
    }

    // Legacy fallback: caller passed only a raw plan. Run prepare here.
    // Migrated callers should pass `prepared` and bypass this.
    isPreparingPlan.value = true
    try {
      const envelope = await prepareTransactionPlan(plan)
      if (requestId === prepareRequestId) {
        preparedPlan.value = envelope.plan
        prepareError.value = ''
      }
    }
    catch (err) {
      logWarn('OperationReviewSdkModal/prepareTransactionPlan', err)
      if (requestId === prepareRequestId) {
        preparedPlan.value = undefined
        prepareError.value = 'Transaction preparation failed. Close this review and try again.'
      }
    }
    finally {
      if (requestId === prepareRequestId) {
        isPreparingPlan.value = false
      }
    }
  },
  { immediate: true },
)

const handleTenderlySimulate = async () => {
  const currentPlan = reviewPlan.value
  if (!currentPlan || !walletAddress.value || !currentChainId.value) return
  clearTenderly()

  try {
    const owner = walletAddress.value as Address
    const batchItem = findFirstEvcBatch(currentPlan)
    if (!batchItem || batchItem.type !== 'evcBatch') return

    const sdk = await getEulerSdk()
    const items: EVCBatchItem[] = flattenBatchEntries(batchItem.items)
    const evcAddress = sdk.deploymentService.getDeployment(currentChainId.value).addresses.coreAddrs.evc
    const data = sdk.executionService.encodeBatch(items)
    const value = items.reduce((sum, it) => sum + it.value, 0n)
    const stateOverrides = await sdk.executionService.deriveStateOverrides(
      currentChainId.value,
      owner,
      currentPlan,
    )

    await tenderlySimulate({
      chainId: currentChainId.value,
      from: owner,
      to: evcAddress,
      data: data as Hex,
      value: value.toString(),
      stateOverrides: toTenderlyStateOverrides(stateOverrides),
    })
  }
  catch (err) {
    logWarn('OperationReviewSdkModal/tenderly', err)
  }
}

const internalSubmitting = ref(false)

const handleConfirm = async () => {
  if (!reviewPlan.value || prepareError.value || isPreparingPlan.value) return
  if (internalSubmitting.value) return
  const result = onConfirm()
  if (result && typeof (result as Promise<void>).then === 'function') {
    internalSubmitting.value = true
    try {
      await result
    }
    finally {
      internalSubmitting.value = false
    }
  }
  else {
    emits('close')
  }
}

const displaySteps = computed((): DisplayStep[] => {
  const currentPlan = reviewPlan.value
  if (!currentPlan?.length) return []
  const ctx: StepDecodingContext = {
    type, asset, assetIconUrl, amount,
    supplyingAssetForBorrow, supplyingAmount,
    swapToAsset, swapToAmount, swapMode, swapEstimatedSide, transferAmounts,
  }
  return buildTransactionPlanDisplaySteps(currentPlan, ctx, getVault, getAssetLogoUrl)
})

const copyCalldata = async () => {
  const currentPlan = reviewPlan.value
  if (!currentPlan?.length) return
  try {
    const sdk = await getEulerSdk()
    const cid = currentChainId.value
    const entries: { to: string, data: string, value: string }[] = []

    for (const item of currentPlan) {
      if (item.type === 'requiredApproval') {
        for (const r of item.resolved ?? []) {
          if (r.type === 'approve') {
            entries.push({ to: r.token, data: r.data, value: '0' })
          }
          // permit2 signatures have no calldata until signed; skip
        }
        continue
      }
      if (item.type === 'evcBatch' && cid) {
        const items = flattenBatchEntries(item.items)
        const evcAddress = sdk.deploymentService.getDeployment(cid).addresses.coreAddrs.evc
        const data = sdk.executionService.encodeBatch(items)
        const value = items.reduce((sum, it) => sum + it.value, 0n)
        entries.push({ to: evcAddress, data, value: value.toString() })
        continue
      }
      if (item.type === 'contractCall') {
        entries.push({
          to: item.to,
          data: encodeFunctionData({
            abi: item.abi,
            functionName: item.functionName,
            args: item.args,
          }),
          value: item.value.toString(),
        })
      }
    }

    copyToClipboard(JSON.stringify(entries, null, 2), 'calldata')
  }
  catch (err) {
    logWarn('OperationReviewSdkModal/copyCalldata', err)
  }
}

const btnLabel = computed(() => {
  switch (type) {
    case 'supply':
    case 'swap-supply':
      return 'Supply'
    case 'withdraw':
    case 'swap-withdraw':
      return 'Withdraw'
    case 'borrow':
    case 'swap-borrow':
      return 'Borrow'
    case 'repay':
      return 'Repay'
    case 'swap':
      return 'Swap'
    case 'transfer':
      return 'Transfer'
    case 'reul-unlock':
      return 'Unlock'
    case 'reward':
    case 'brevis-reward':
    case 'fuul-reward':
      return 'Claim'
    case 'disableCollateral':
      return 'Disable collateral'
    default:
      return 'Submit'
  }
})

const reulUnlockDisclaimerText = computed(() => {
  if (type !== 'reul-unlock' || !reulUnlockInfo) return

  return `This action will unlock ${formatNumber(reulUnlockInfo.unlockableAmount, 6)} EUL, and ${formatNumber(reulUnlockInfo.amountToBeBurned, 6)} EUL will be permanently burned. To fully redeem your EUL rewards, you must wait for the 6-month vesting period to complete (${reulUnlockInfo.daysUntilMaturity} days remaining, maturity date: ${reulUnlockInfo.maturityDate}).`
})

const disclaimerText = computed(() => {
  if (type !== 'reward') return
  const displayAmount = Number(amount) < 0.01 ? '< 0.01' : formatNumber(amount)
  return `You're claiming all ${displayAmount} ${asset.symbol} on Merkl. Part of this amount could have been earned outside of Euler.`
})

const hasPermit2Approval = computed(() => {
  return reviewPlan.value?.some(item => item.type === 'requiredApproval'
    && item.resolved?.some(r => r.type === 'permit2')) ?? false
})

const usesPermit2 = computed(() => hasPermit2Approval.value)

const hasTenderlyFailedSimulation = computed(() => {
  return !!(tenderlyUrl.value && tenderlyError.value)
})

const isSwapQuoteStale = computed(() => {
  return typeof quoteFetchedAt === 'number'
    && nowMs.value - quoteFetchedAt > staleQuoteThresholdMs
})

const permit2DisclaimerText = 'You are granting the Permit2 contract an unlimited token allowance. Permit2 is a Uniswap contract used to authorize future transfers with signatures. Each future transfer still requires your explicit signature and can be limited by amount and duration.'
const isConfirmDisabled = computed(() => isSpyMode.value || internalSubmitting.value || isPreparingPlan.value || !!prepareError.value || !reviewPlan.value?.length)
const confirmLabel = computed(() => {
  if (isSpyMode.value) return 'Spy mode (read-only)'
  if (isPreparingPlan.value) return 'Preparing...'
  return internalSubmitting.value && submittingLabel ? submittingLabel : btnLabel.value
})
</script>

<template>
  <BaseModalWrapper
    title="Transaction review"
    @close="!internalSubmitting && $emit('close')"
  >
    <div class="flex flex-col gap-24">
      <div
        v-if="displaySteps.length"
        class="flex flex-col gap-8"
      >
        <div class="bg-surface-secondary rounded-12 p-12 flex flex-col gap-8">
          <OperationStepsList :steps="displaySteps" />
        </div>
      </div>

      <div
        v-if="reviewPlan?.length"
        class="flex items-center justify-center gap-16"
      >
        <button
          type="button"
          class="flex items-center gap-6 text-p3 text-content-primary hover:text-content-primary transition-colors"
          @click="copyCalldata"
        >
          <SvgIcon
            :name="copied ? 'check' : 'copy'"
            class="!w-16 !h-16"
          />
          {{ copied ? 'Copied!' : 'Copy calldata' }}
        </button>
        <a
          v-if="tenderlyEnabled && tenderlyUrl"
          :href="tenderlyUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center gap-6 text-p3 transition-colors"
          :class="hasTenderlyFailedSimulation
            ? 'text-error-500 hover:text-error-600'
            : 'text-success-500 hover:text-success-600'"
        >
          <SvgIcon
            :name="hasTenderlyFailedSimulation ? 'warning-circle' : 'check-circle'"
            class="!w-16 !h-16"
          />
          {{ hasTenderlyFailedSimulation ? 'Simulation failed' : 'View simulation' }}
          <SvgIcon
            v-if="hasTenderlyFailedSimulation"
            name="arrow-top-right"
            class="!w-14 !h-14"
          />
        </a>
        <button
          v-else-if="tenderlyEnabled"
          type="button"
          class="flex items-center gap-6 text-p3 text-content-primary hover:text-content-primary transition-colors"
          :disabled="isTenderlySimulating"
          @click="handleTenderlySimulate"
        >
          <SvgIcon
            :name="isTenderlySimulating ? 'loading' : 'arrow-top-right'"
            class="!w-16 !h-16"
            :class="{ 'animate-spin': isTenderlySimulating }"
          />
          Simulate on Tenderly
        </button>
      </div>
      <p
        v-if="usesPermit2"
        class="text-p4 text-content-primary text-center"
      >
        Copied calldata does not contain the permit() call. It is only known after the permit2 message is signed.
      </p>

      <UiToast
        v-if="tenderlyError && !hasTenderlyFailedSimulation"
        title="Simulation failed"
        variant="warning"
        :description="tenderlyError"
        size="compact"
      />
      <UiToast
        v-if="prepareError"
        title="Preparation failed"
        variant="error"
        :description="prepareError"
        size="compact"
      />

      <div
        v-if="isSwapQuoteStale"
        class="flex items-start gap-8 rounded-12 bg-warning-100 p-12 text-warning-500"
      >
        <SvgIcon
          name="warning-circle"
          class="!w-16 !h-16 shrink-0 mt-1"
        />
        <p class="text-p4">
          This swap quote is more than 3 minutes old. Consider refreshing quotes with the
          <SvgIcon
            name="refresh"
            class="inline-block !w-14 !h-14 align-[-2px]"
          />
          icon before submitting to get the best execution price.
        </p>
      </div>

      <UiToast
        v-if="type === 'reward'"
        title="Disclaimer"
        variant="warning"
        :description="disclaimerText"
        size="compact"
      />
      <UiToast
        v-if="type === 'reul-unlock'"
        title="Important"
        variant="warning"
        :description="reulUnlockDisclaimerText"
        size="compact"
      />
      <UiToast
        v-if="hasPermit2Approval"
        title="Infinite approval"
        variant="info"
        :description="permit2DisclaimerText"
        size="compact"
      />

      <UiButton
        variant="primary"
        size="xlarge"
        rounded
        :disabled="isConfirmDisabled"
        :loading="internalSubmitting || isPreparingPlan"
        @click="handleConfirm"
      >
        {{ confirmLabel }}
      </UiButton>
    </div>
  </BaseModalWrapper>
</template>
