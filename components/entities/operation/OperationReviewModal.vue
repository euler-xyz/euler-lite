<script setup lang="ts">
import { encodeFunctionData } from 'viem'
import type { Address, Hex } from 'viem'
import type { Campaign } from '~/entities/brevis'
import type { VaultAsset } from '~/entities/vault'
import type { TxPlan } from '~/entities/txPlan'
import type { SwapperMode } from '~/entities/swap'
import type { EVCCall } from '~/utils/evc-converter'
import { applyOperationGuards, assertOperationNotBlocked, isOperationBlocked, operationBlockReason } from '~/utils/operationGuardRegistry'
import { buildDisplaySteps, type DisplayStep, type StepDecodingContext } from '~/utils/stepDecoding'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
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

const { type, asset, assetIconUrl, campaignInfo: _campaignInfo, reulUnlockInfo, amount, onConfirm, plan, swapToAsset, swapToAmount, swapMode, swapEstimatedSide, supplyingAssetForBorrow, supplyingAmount, transferAmounts, submittingLabel } = defineProps<{
  type?: 'supply' | 'withdraw' | 'borrow' | 'repay' | 'swap' | 'transfer' | 'reward' | 'brevis-reward' | 'fuul-reward' | 'reul-unlock' | 'disableCollateral' | 'swap-supply' | 'swap-withdraw' | 'swap-borrow'
  asset: VaultAsset
  assetIconUrl?: string
  amount: number | string
  plan?: TxPlan
  supplyingAssetForBorrow?: VaultAsset
  supplyingAmount?: number | string
  swapToAsset?: VaultAsset
  swapToAmount?: number | string
  /** Swap mode behind this operation, when one is involved. Drives the
   *  "Swap to repay" relabel and default estimated leg. */
  swapMode?: SwapperMode
  /** Display-side override for which swap amount should receive "~". */
  swapEstimatedSide?: 'input' | 'output'
  campaignInfo?: Campaign
  reulUnlockInfo?: REULUnlockInfo
  onConfirm: () => void | Promise<void>
  subAccount?: string
  hasBorrows?: boolean
  /** Known amounts for transferFromMax steps, keyed by vault address (lowercase) */
  transferAmounts?: Record<string, string>
  /** Label shown on the button while executing */
  submittingLabel?: string
}>()

const { address: walletAddress, chainId: currentChainId } = useWagmi()
const { isSpyMode } = useSpyMode()
const { getVault } = useVaultRegistry()
const { buildSimulationStateOverride } = useEulerOperations()
const { eulerCoreAddresses } = useEulerAddresses()
const {
  isSimulating: isTenderlySimulating,
  simulationError: tenderlyError,
  simulationUrl: tenderlyUrl,
  simulate: tenderlySimulate,
  clearSimulation: clearTenderly,
  fetchEnabled: fetchTenderlyEnabled,
} = useTenderlySimulation()

const copied = ref(false)
const tenderlyEnabled = ref(false)

fetchTenderlyEnabled().then((enabled) => {
  tenderlyEnabled.value = enabled
})

const handleTenderlySimulate = async () => {
  if (!plan?.steps || !walletAddress.value || !currentChainId.value) return
  clearTenderly()

  try {
    const owner = walletAddress.value as Address
    const guardedPlan = applyOperationGuards(plan)
    const stateOverrides = await buildSimulationStateOverride(guardedPlan, owner)

    const mainStep = guardedPlan.steps.find(s => s.type === 'evc-batch')
    if (!mainStep) return

    const batchItems = mainStep.args?.[0] as EVCCall[] | undefined
    if (!batchItems?.length) return

    const permit2Address = eulerCoreAddresses.value?.permit2 as string | undefined

    const filteredItems = permit2Address
      ? batchItems.filter(
          call => call.targetContract.toLowerCase() !== permit2Address.toLowerCase(),
        )
      : batchItems

    const data = encodeFunctionData({
      abi: mainStep.abi,
      functionName: mainStep.functionName,
      args: [filteredItems],
    })

    const url = await tenderlySimulate({
      chainId: currentChainId.value,
      from: owner,
      to: mainStep.to,
      data: data as Hex,
      value: mainStep.value?.toString() || '0',
      stateOverrides,
    })

    if (url) {
      return
    }
  }
  catch {
    // Error is captured in tenderlyError ref by the composable
  }
}

const internalSubmitting = ref(false)

const handleConfirm = async () => {
  if (internalSubmitting.value) return
  assertOperationNotBlocked()
  const result = onConfirm()
  // If onConfirm returns a promise, keep the modal open with a loading state
  // and let the caller close it via modal.close(). Otherwise close immediately
  // (backwards-compatible with existing sync callbacks).
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
  if (!plan?.steps) return []

  const ctx: StepDecodingContext = {
    type, asset, assetIconUrl, amount,
    supplyingAssetForBorrow, supplyingAmount,
    swapToAsset, swapToAmount, swapMode, swapEstimatedSide, transferAmounts,
  }

  return buildDisplaySteps(plan, ctx, getVault, getAssetLogoUrl, hasPermit2Approval.value)
})

const copyCalldata = () => {
  if (!plan?.steps) return

  try {
    const calldataEntries = plan.steps.map(step => ({
      to: step.to,
      data: encodeFunctionData({
        abi: step.abi,
        functionName: step.functionName,
        args: step.args,
      }),
      value: step.value?.toString() || '0',
    }))

    navigator.clipboard.writeText(JSON.stringify(calldataEntries, null, 2))
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 2000)
  }
  catch (err) {
    logWarn('OperationReviewModal/calldataCopy', err)
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
  return plan?.steps?.some(step => step.type === 'permit2-approve') ?? false
})

const usesPermit2 = computed(() => {
  return plan?.steps?.some(step => step.label?.includes('Permit2')) ?? false
})

const hasTenderlyFailedSimulation = computed(() => {
  return !!(tenderlyUrl.value && tenderlyError.value)
})

const permit2DisclaimerText = 'You are granting the Permit2 contract an unlimited token allowance. Permit2 is a Uniswap contract used to authorize future transfers with signatures. Each future transfer still requires your explicit signature and can be limited by amount and duration.'
</script>

<template>
  <BaseModalWrapper
    title="Transaction review"
    @close="$emit('close')"
  >
    <div class="flex flex-col gap-24">
      <!-- Transaction Steps -->
      <div
        v-if="displaySteps.length"
        class="flex flex-col gap-8"
      >
        <div class="bg-surface-secondary rounded-12 p-12 flex flex-col gap-8">
          <OperationStepsList :steps="displaySteps" />
        </div>
      </div>

      <!-- Copy calldata & Tenderly simulate -->
      <div
        v-if="plan?.steps?.length"
        class="flex items-center justify-center gap-16"
      >
        <button
          type="button"
          class="flex items-center gap-6 text-p3 text-content-primary hover:text-content-primary transition-colors"
          @click="copyCalldata"
        >
          <SvgIcon
            name="copy"
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

      <!-- Tenderly error -->
      <UiToast
        v-if="tenderlyError && !hasTenderlyFailedSimulation"
        title="Simulation failed"
        variant="warning"
        :description="tenderlyError"
        size="compact"
      />

      <!-- Disclaimers -->
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
      <UiToast
        v-if="operationBlockReason"
        title="Action required"
        variant="warning"
        :description="operationBlockReason"
        size="compact"
      />

      <!-- Confirm button -->
      <UiButton
        variant="primary"
        size="xlarge"
        rounded
        :disabled="isSpyMode || internalSubmitting || isOperationBlocked"
        :loading="internalSubmitting"
        @click="handleConfirm"
      >
        {{ isSpyMode ? 'Spy mode (read-only)' : (internalSubmitting && submittingLabel ? submittingLabel : btnLabel) }}
      </UiButton>
    </div>
  </BaseModalWrapper>
</template>
