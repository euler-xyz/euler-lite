<script setup lang="ts">
import type { VaultAsset } from '~/types/asset'
import type { Address, Hex } from 'viem'
import type { TransactionPlan, EVCBatchItem, SwapperMode } from '@eulerxyz/euler-v2-sdk'
import { flattenBatchEntries } from '@eulerxyz/euler-v2-sdk'
import { buildSdkDisplaySteps } from '~/utils/sdkStepDecoding'
import type { DisplayStep, StepDecodingContext } from '~/utils/stepDecoding'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { getEulerSdk } from '~/composables/useEulerSdk'
import { logWarn } from '~/utils/errorHandling'
import { formatNumber } from '~/utils/string-utils'
import { getAssetLogoUrl } from '~/composables/useTokenList'
import { hasPermit2Signature, hasPermit2TokenApproval } from '~/utils/transactionPlanApprovals'

const emits = defineEmits(['close', 'confirm'])

const { type, asset, assetIconUrl, amount, onConfirm, plan, swapToAsset, swapToAmount, swapMode, swapEstimatedSide, supplyingAssetForBorrow, supplyingAmount, transferAmounts, submittingLabel } = defineProps<{
  type?: 'supply' | 'withdraw' | 'borrow' | 'repay' | 'swap' | 'transfer' | 'reward' | 'disableCollateral' | 'swap-supply' | 'swap-withdraw' | 'swap-borrow'
  asset: VaultAsset
  assetIconUrl?: string
  amount: number | string
  plan?: TransactionPlan
  supplyingAssetForBorrow?: VaultAsset
  supplyingAmount?: number | string
  swapToAsset?: VaultAsset
  swapToAmount?: number | string
  swapMode?: SwapperMode
  swapEstimatedSide?: 'input' | 'output'
  onConfirm: () => void | Promise<void>
  subAccount?: string
  hasBorrows?: boolean
  transferAmounts?: Record<string, string>
  submittingLabel?: string
}>()

const { address: walletAddress, chainId: currentChainId } = useWagmi()
const { isSpyMode } = useSpyMode()
const { getVault } = useVaultRegistry()
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

const findFirstEvcBatch = (p?: TransactionPlan) => p?.find(item => item.type === 'evcBatch')

const handleTenderlySimulate = async () => {
  if (!plan || !walletAddress.value || !currentChainId.value) return
  clearTenderly()

  try {
    const owner = walletAddress.value as Address
    const batchItem = findFirstEvcBatch(plan)
    if (!batchItem || batchItem.type !== 'evcBatch') return

    const sdk = await getEulerSdk()
    const items: EVCBatchItem[] = flattenBatchEntries(batchItem.items)
    const evcAddress = sdk.deploymentService.getDeployment(currentChainId.value).addresses.coreAddrs.evc
    const data = sdk.executionService.encodeBatch(items)
    const value = items.reduce((sum, it) => sum + it.value, 0n)
    const stateOverrides = await sdk.executionService.deriveStateOverrides(
      currentChainId.value,
      owner,
      plan,
    )

    await tenderlySimulate({
      chainId: currentChainId.value,
      from: owner,
      to: evcAddress,
      data: data as Hex,
      value: value.toString(),
      stateOverrides: stateOverrides as never,
    })
  }
  catch (err) {
    logWarn('OperationReviewSdkModal/tenderly', err)
  }
}

const internalSubmitting = ref(false)

const handleConfirm = async () => {
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
  if (!plan?.length) return []
  const ctx: StepDecodingContext = {
    type, asset, assetIconUrl, amount,
    supplyingAssetForBorrow, supplyingAmount,
    swapToAsset, swapToAmount, swapMode, swapEstimatedSide, transferAmounts,
  }
  return buildSdkDisplaySteps(plan, ctx, getVault, getAssetLogoUrl)
})

const copyCalldata = async () => {
  if (!plan?.length) return
  try {
    const sdk = await getEulerSdk()
    const cid = currentChainId.value
    const entries: { to: string, data: string, value: string }[] = []

    for (const item of plan) {
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
        // Encoded at execution time; show abi/function for diagnostic copy
        entries.push({
          to: item.to,
          data: JSON.stringify({ functionName: item.functionName, args: item.args }),
          value: item.value.toString(),
        })
      }
    }

    navigator.clipboard.writeText(JSON.stringify(entries, null, 2))
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 2000)
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
    case 'reward':
      return 'Claim'
    case 'disableCollateral':
      return 'Disable collateral'
    default:
      return 'Submit'
  }
})

const disclaimerText = computed(() => {
  if (type !== 'reward') return
  const displayAmount = Number(amount) < 0.01 ? '< 0.01' : formatNumber(amount)
  return `You're claiming all ${displayAmount} ${asset.symbol} on Merkl. Part of this amount could have been earned outside of Euler.`
})

const hasPermit2Approval = computed(() => {
  return hasPermit2TokenApproval(plan, eulerCoreAddresses.value?.permit2)
})

const usesPermit2 = computed(() => hasPermit2Signature(plan) || hasPermit2Approval.value)

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
      <div
        v-if="displaySteps.length"
        class="flex flex-col gap-8"
      >
        <div class="bg-surface-secondary rounded-12 p-12 flex flex-col gap-8">
          <OperationStepsList :steps="displaySteps" />
        </div>
      </div>

      <div
        v-if="plan?.length"
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

      <UiToast
        v-if="tenderlyError && !hasTenderlyFailedSimulation"
        title="Simulation failed"
        variant="warning"
        :description="tenderlyError"
        size="compact"
      />

      <UiToast
        v-if="type === 'reward'"
        title="Disclaimer"
        variant="warning"
        :description="disclaimerText"
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
        :disabled="isSpyMode || internalSubmitting"
        :loading="internalSubmitting"
        @click="handleConfirm"
      >
        {{ isSpyMode ? 'Spy mode (read-only)' : (internalSubmitting && submittingLabel ? submittingLabel : btnLabel) }}
      </UiButton>
    </div>
  </BaseModalWrapper>
</template>
