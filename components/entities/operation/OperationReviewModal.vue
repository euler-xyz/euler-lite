<script setup lang="ts">
import type { VaultAsset } from '~/types/asset'
import { encodeFunctionData, getAddress, type Address, type StateOverride } from 'viem'
import { flattenBatchEntries, getEulerLabelProductByVault, getSubAccountId, type SwapperMode, type TransactionPlan, type TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { buildPlanMarketLabel, buildTransactionPlanDisplaySteps, type DisplayStep, type StepDecodingContext, type StepKnownAsset, type StepKnownSwapOutput } from '~/utils/stepDecoding'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { getEulerSdkForChain } from '~/composables/useEulerSdk'
import { getCurrentEulerLabelsData } from '~/composables/useEulerLabels'
import { logWarn } from '~/utils/errorHandling'
import { formatNumber } from '~/utils/string-utils'
import { getAssetLogoUrl } from '~/composables/useTokenList'
import { useStateOverrideResolution } from '~/composables/useStateOverrideOptions'
import { hasPermit2Signature, hasPermit2TokenApproval } from '~/utils/transactionPlanApprovals'
import { buildTenderlySimulationPayload } from '~/utils/tenderly-plan'

const emits = defineEmits(['close', 'confirm'])

interface REULUnlockInfo {
  unlockableAmount: number
  amountToBeBurned: number
  maturityDate: string
  daysUntilMaturity: number
}

const { type, asset, assetIconUrl, reulUnlockInfo, amount, onConfirm, plan, prepared, calldataPrepared, calldataUsesPlaceholderSignatures, tenderlyPrepared, tenderlyPlan, tenderlyStateOverrides, displayPlan, signatureSteps: providedSignatureSteps, postSteps, swapFromAsset, swapFromAmount, swapToAsset, swapToAmount, swapMode, swapEstimatedSide, supplyingAssetForBorrow, supplyingAmount, transferAmounts, vaultAmounts, knownAssets, swapQuoteOutputs, confirmLabel: providedConfirmLabel, submittingLabel, quoteFetchedAt, hideExecute, subAccount, marketLabel, allowConfirmWithoutPlan } = defineProps<{
  type?: 'supply' | 'withdraw' | 'borrow' | 'repay' | 'swap' | 'transfer' | 'refinance' | 'migration' | 'reward' | 'brevis-reward' | 'fuul-reward' | 'turtle-reward' | 'reul-unlock' | 'disableCollateral' | 'swap-supply' | 'swap-withdraw' | 'swap-borrow'
  asset: VaultAsset
  assetIconUrl?: string
  amount: number | string
  /** Raw plan, prepared inside the modal when no prepared envelope is provided. */
  plan?: TransactionPlan
  /** Pre-prepared envelope. When set, the modal renders immediately — no
   *  in-modal plugin/approval-resolution round-trip. */
  prepared?: TransactionPlanPrepared
  /** Tenderly-only prepared plan. Used for display-only reviews that need a pre-signature simulation path. */
  tenderlyPrepared?: TransactionPlanPrepared
  /** Copy-calldata-only prepared plan. Used when executable calldata needs placeholder signatures before confirm-time signing. */
  calldataPrepared?: TransactionPlanPrepared
  /** The copy-calldata-only plan contains placeholder wallet signatures. */
  calldataUsesPlaceholderSignatures?: boolean
  /** Tenderly-only raw plan fallback. */
  tenderlyPlan?: TransactionPlan
  /** Additional simulation overrides required by the Tenderly-only plan. */
  tenderlyStateOverrides?: StateOverride
  /** Optional plan used only to decode displayed operation rows. */
  displayPlan?: TransactionPlan
  /** Optional wallet-signature rows shown separately before transaction rows. */
  signatureSteps?: DisplayStep[]
  /** Standalone transactions sent after the plan, e.g. migration authorization revokes. */
  postSteps?: DisplayStep[]
  supplyingAssetForBorrow?: VaultAsset
  supplyingAmount?: number | string
  swapFromAsset?: VaultAsset
  swapFromAmount?: number | string
  swapToAsset?: VaultAsset
  swapToAmount?: number | string
  swapMode?: SwapperMode
  swapEstimatedSide?: 'input' | 'output'
  reulUnlockInfo?: REULUnlockInfo
  onConfirm?: () => void | Promise<void>
  subAccount?: string
  hasBorrows?: boolean
  transferAmounts?: Record<string, string>
  knownAssets?: StepKnownAsset[]
  swapQuoteOutputs?: StepKnownSwapOutput[]
  confirmLabel?: string
  vaultAmounts?: Record<string, string>
  submittingLabel?: string
  /** Milliseconds since epoch when the active swap quote was fetched */
  quoteFetchedAt?: number | null
  /** Read-only review (e.g. opened from a batch item): hides the execute button. */
  hideExecute?: boolean
  /** Overrides the inferred Euler product name for non-product contexts, such as Earn vaults. */
  marketLabel?: string
  /** Allow display-step-only reviews when the executable plan needs a confirm-time wallet authorization first. */
  allowConfirmWithoutPlan?: boolean
}>()

const { address: walletAddress, isSpyMode, effectiveAddress } = useEffectiveAddress()
const { chainId: currentChainId } = useWagmi()
const { getVault } = useVaultRegistry()
const { prepareTransactionPlan } = useEulerTx()
const { isSafeWallet } = useSafeWallet()
const { eulerCoreAddresses } = useEulerAddresses()
const { isResolvingStateOverrideHints } = useStateOverrideResolution()
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
const hasCopiedCalldata = ref(false)
const nowMs = ref(Date.now())
const staleQuoteThresholdMs = 3 * 60 * 1000
let nowTimer: ReturnType<typeof setInterval> | undefined
// `preparedPlan` is either the caller-provided prepared envelope's plan or the
// result of preparing a raw plan inside this modal.
const preparedPlan = shallowRef<TransactionPlan | undefined>()
const prepareError = ref('')
const tenderlyLocalError = ref('')
const isPreparingPlan = ref(false)
const reviewPlan = computed(() => preparedPlan.value)
const tenderlyReviewPlan = computed(() => reviewPlan.value ?? tenderlyPrepared?.plan ?? tenderlyPlan)
const tenderlyChainId = computed(() => prepared?.chainId ?? tenderlyPrepared?.chainId ?? currentChainId.value)
// calldataPrepared is the dedicated copy-calldata plan (e.g. carrying
// placeholder signatures) — it must win over the review plan when both exist.
const calldataPlan = computed(() => calldataPrepared?.plan ?? reviewPlan.value)
const calldataChainId = computed(() => calldataPrepared?.chainId ?? prepared?.chainId ?? currentChainId.value)
const displayReviewPlan = computed(() => displayPlan ?? reviewPlan.value ?? calldataPrepared?.plan ?? tenderlyPrepared?.plan ?? tenderlyPlan)
const canCopyCalldata = computed(() => !!calldataPlan.value?.length)
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

watch(
  () => [prepared, plan, walletAddress.value, currentChainId.value, allowConfirmWithoutPlan] as const,
  async () => {
    const requestId = ++prepareRequestId
    hasCopiedCalldata.value = false
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
      if (allowConfirmWithoutPlan) return
      prepareError.value = 'Transaction plan is unavailable. Close this review and try again.'
      return
    }

    // Raw plans are prepared here so the displayed rows use resolved approvals.
    isPreparingPlan.value = true
    try {
      const envelope = await prepareTransactionPlan(plan)
      if (requestId === prepareRequestId) {
        preparedPlan.value = envelope.plan
        prepareError.value = ''
      }
    }
    catch (err) {
      logWarn('OperationReviewModal/prepareTransactionPlan', err)
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
  const currentPlan = tenderlyReviewPlan.value
  if (!currentPlan || !walletAddress.value) return
  tenderlyLocalError.value = ''
  clearTenderly()

  try {
    const owner = walletAddress.value as Address
    // Capture the plan's chain id once so the SDK backend selection and the
    // payload can't diverge if the user switches chains mid-await. Uses the
    // tenderly plan chain (not the wallet chain) so cross-chain migration
    // plans simulate against the correct network.
    const targetChainId = tenderlyChainId.value
    const sdk = await getEulerSdkForChain(targetChainId)
    const payload = await buildTenderlySimulationPayload({
      plan: currentPlan,
      owner,
      chainId: targetChainId,
      sdk,
      extraStateOverrides: tenderlyStateOverrides,
    })

    if (!payload) {
      tenderlyLocalError.value = 'Tenderly simulation is not available for this transaction plan.'
      return
    }

    await tenderlySimulate(payload)
  }
  catch (err) {
    logWarn('OperationReviewModal/tenderly', err)
  }
}

const internalSubmitting = ref(false)

const handleConfirm = async () => {
  if (isConfirmDisabled.value || !onConfirm) return
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

const isWalletSignatureStep = (step: DisplayStep) =>
  step.label === 'Sign permit2 message'

const rawDisplaySteps = computed((): DisplayStep[] => {
  const currentPlan = displayReviewPlan.value
  if (!currentPlan?.length) return []
  const ctx: StepDecodingContext = {
    type, asset, assetIconUrl, amount,
    supplyingAssetForBorrow, supplyingAmount,
    swapFromAsset, swapFromAmount, swapToAsset, swapToAmount, swapMode, swapEstimatedSide, transferAmounts, vaultAmounts, knownAssets, swapQuoteOutputs,
    bundledApprovals: isSafeWallet.value,
  }
  return buildTransactionPlanDisplaySteps(currentPlan, ctx, getVault, getAssetLogoUrl)
})

// Batch operation details show this as a muted context line. EVK operations use
// the label product name(s) of the vaults the op touches, joined with " / " when
// it spans markets (same shape as the positions list's pair label); Earn
// operations can pass the Earn vault display name.
const market = computed<string | undefined>(() => {
  if (marketLabel) return marketLabel
  const labels = getCurrentEulerLabelsData()
  return buildPlanMarketLabel(displayReviewPlan.value, addr => getEulerLabelProductByVault(labels, addr)?.name)
})

// "Position N" / "Deposits" tag for the sub-account this operation targets,
// mirroring the pill in the batch review's operations list. Sub-account 0 is the
// main account ("Deposits"); numbered borrow positions are "Position N".
const positionTag = computed<string | undefined>(() => {
  const ownerAddr = effectiveAddress.value || ''
  if (!subAccount || !ownerAddr) return undefined
  try {
    const idx = getSubAccountId(getAddress(ownerAddr), getAddress(subAccount))
    return idx === 0 ? 'Deposits' : `Position ${idx}`
  }
  catch {
    return undefined
  }
})

const displaySteps = computed((): DisplayStep[] => {
  // Wallet-signature rows always render in the signature section, never among
  // the transaction steps — also when the caller provides its own signature
  // rows (a raw permit2 row would otherwise appear in both sections).
  const steps = rawDisplaySteps.value.filter(step => !isWalletSignatureStep(step))
  return steps.map((step, idx) => ({ ...step, index: idx + 1 }))
})

const signatureSteps = computed((): DisplayStep[] =>
  (providedSignatureSteps?.length
    ? providedSignatureSteps
    : rawDisplaySteps.value.filter(isWalletSignatureStep)
  ).map((step, idx) => ({ ...step, index: idx + 1 })),
)

// Numbered from 1 like the other groups; the divider separates them.
const postExecutionSteps = computed((): DisplayStep[] =>
  (postSteps ?? []).map((step, idx) => ({ ...step, index: idx + 1 })),
)

const copyCalldata = async () => {
  const currentPlan = calldataPlan.value
  if (!currentPlan?.length) return
  try {
    const cid = calldataChainId.value
    const sdk = await getEulerSdkForChain(cid)
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

    await copyToClipboard(JSON.stringify(entries, null, 2), 'calldata')
    hasCopiedCalldata.value = true
  }
  catch (err) {
    logWarn('OperationReviewModal/copyCalldata', err)
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
    case 'refinance':
      return 'Refinance'
    case 'migration':
      return 'Migrate'
    case 'reul-unlock':
      return 'Unlock'
    case 'reward':
    case 'brevis-reward':
    case 'fuul-reward':
    case 'turtle-reward':
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
  if (type !== 'reward' && type !== 'turtle-reward') return
  const displayAmount = Number(amount) < 0.01 ? '< 0.01' : formatNumber(amount)
  if (type === 'turtle-reward') {
    return `You're claiming all ${displayAmount} ${asset.symbol} through Turtle. Part of this amount could have been earned outside of Euler.`
  }
  return `You're claiming all ${displayAmount} ${asset.symbol} on Merkl. Part of this amount could have been earned outside of Euler.`
})

const hasPermit2Approval = computed(() => {
  return hasPermit2TokenApproval(reviewPlan.value, eulerCoreAddresses.value?.permit2)
})

const usesPermit2 = computed(() => hasPermit2Signature(reviewPlan.value) || hasPermit2Approval.value)
const hasTenderlyPlan = computed(() => !!tenderlyReviewPlan.value?.length)

const hasTenderlyFailedSimulation = computed(() => {
  return !!(tenderlyUrl.value && tenderlyError.value)
})
const tenderlyDisplayError = computed(() => tenderlyLocalError.value || tenderlyError.value)

const isSwapQuoteStale = computed(() => {
  return typeof quoteFetchedAt === 'number'
    && nowMs.value - quoteFetchedAt > staleQuoteThresholdMs
})

const permit2DisclaimerText = 'You are granting the Permit2 contract an unlimited token allowance. Permit2 is a Uniswap contract used to authorize future transfers with signatures. Each future transfer still requires your explicit signature and can be limited by amount and duration.'
const hasDisplayOnlyConfirmation = computed(() => allowConfirmWithoutPlan && (displaySteps.value.length > 0 || signatureSteps.value.length > 0))
const isConfirmDisabled = computed(() => isSpyMode.value || internalSubmitting.value || isPreparingPlan.value || isResolvingStateOverrideHints.value || !!prepareError.value || (!reviewPlan.value?.length && !hasDisplayOnlyConfirmation.value))
const isTenderlyPreparing = computed(() => isTenderlySimulating.value || isResolvingStateOverrideHints.value)
const confirmLabel = computed(() => {
  if (isSpyMode.value) return 'Spy mode (read-only)'
  if (isPreparingPlan.value || isResolvingStateOverrideHints.value) return 'Preparing...'
  return internalSubmitting.value && submittingLabel ? submittingLabel : (providedConfirmLabel || btnLabel.value)
})
</script>

<template>
  <BaseModalWrapper
    :title="hideExecute ? 'Operations' : 'Transaction review'"
    @close="!internalSubmitting && $emit('close')"
  >
    <div class="flex flex-col gap-24">
      <!-- Operation context (market + position) grouped tightly above its steps,
           so the operation reads in the context of the position it acts on. -->
      <div class="flex flex-col gap-10">
        <div
          v-if="hideExecute && (market || positionTag)"
          class="flex items-center justify-between gap-8 px-12"
        >
          <div class="min-w-0 flex-1">
            <BatchMarketLabel :market="market" />
          </div>
          <span
            v-if="hideExecute && positionTag"
            class="shrink-0 text-h6 text-content-secondary bg-card py-2 px-8 rounded-8 border border-line-default"
          >
            {{ positionTag }}
          </span>
        </div>
        <div
          v-if="signatureSteps.length || displaySteps.length || postExecutionSteps.length"
          class="w-full rounded-8 bg-card p-12"
        >
          <div class="flex w-full flex-col gap-8">
            <OperationStepsList
              v-if="signatureSteps.length"
              :steps="signatureSteps"
            />
            <div
              v-if="signatureSteps.length && displaySteps.length"
              class="border-t border-border-primary my-4"
            />
            <OperationStepsList
              v-if="displaySteps.length"
              :steps="displaySteps"
            />
            <template v-if="postExecutionSteps.length">
              <div
                v-if="signatureSteps.length || displaySteps.length"
                class="border-t border-border-primary my-4"
              />
              <div class="text-p3 text-content-muted">
                After execution
              </div>
              <OperationStepsList :steps="postExecutionSteps" />
            </template>
          </div>
        </div>
      </div>

      <div
        v-if="(canCopyCalldata || hasTenderlyPlan) && !hideExecute"
        class="flex items-center justify-center gap-16"
      >
        <button
          v-if="canCopyCalldata"
          type="button"
          class="inline-flex h-36 items-center gap-6 rounded-8 border border-line-default bg-card px-12 text-p3 text-content-primary hover:border-line-emphasis hover:bg-card-hover transition-colors"
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
          class="inline-flex h-36 items-center gap-6 rounded-8 border border-line-default bg-card px-12 text-p3 transition-colors hover:border-line-emphasis hover:bg-card-hover"
          :class="hasTenderlyFailedSimulation
            ? 'text-error-500 hover:text-error-500'
            : 'text-success-500 hover:text-success-500'"
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
          class="inline-flex h-36 items-center gap-6 rounded-8 border border-line-default bg-card px-12 text-p3 text-content-primary hover:border-line-emphasis hover:bg-card-hover disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
          :disabled="isTenderlyPreparing"
          @click="handleTenderlySimulate"
        >
          <SvgIcon
            :name="isTenderlyPreparing ? 'loading' : 'arrow-top-right'"
            class="!w-16 !h-16"
            :class="{ 'animate-spin': isTenderlyPreparing }"
          />
          Simulate on Tenderly
        </button>
      </div>
      <p
        v-if="usesPermit2 && !hideExecute && hasCopiedCalldata"
        class="text-p4 text-content-primary text-center"
      >
        Copied calldata does not contain the permit() call. It is only known after the permit2 message is signed.
      </p>
      <p
        v-if="calldataUsesPlaceholderSignatures && canCopyCalldata && !hideExecute"
        class="text-p4 text-content-primary text-center"
      >
        Copied calldata contains placeholder authorization signatures. Sign the wallet messages to execute the final calldata.
      </p>

      <UiAlert
        v-if="tenderlyDisplayError && !hasTenderlyFailedSimulation"
        title="Simulation failed"
        variant="warning"
        :description="tenderlyDisplayError"
        size="compact"
      />
      <UiAlert
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

      <UiAlert
        v-if="disclaimerText"
        title="Disclaimer"
        variant="warning"
        :description="disclaimerText"
        size="compact"
      />
      <UiAlert
        v-if="type === 'reul-unlock'"
        title="Important"
        variant="warning"
        :description="reulUnlockDisclaimerText"
        size="compact"
      />
      <UiAlert
        v-if="hasPermit2Approval"
        title="Infinite approval"
        variant="info"
        :description="permit2DisclaimerText"
        size="compact"
      />

      <UiButton
        v-if="!hideExecute"
        data-id="operation-review-confirm"
        :data-operation-type="type"
        variant="primary"
        size="xlarge"
        rounded
        :disabled="isConfirmDisabled"
        :loading="internalSubmitting || isPreparingPlan || isResolvingStateOverrideHints"
        @click="handleConfirm"
      >
        {{ confirmLabel }}
      </UiButton>
    </div>
  </BaseModalWrapper>
</template>
