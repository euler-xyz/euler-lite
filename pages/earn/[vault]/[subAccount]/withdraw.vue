<script setup lang="ts">
import type { VaultAsset } from '~/types/asset'
import { getAssetUsdValueOrZero } from '~/utils/sdk-prices'
import { computeSupplyApyBreakdown, type TransactionPlan, type EulerEarn } from '@eulerxyz/euler-v2-sdk'
import { formatNumber, formatSmartAmount, formatExactAmount } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import { isOperationBlocked } from '~/utils/operationGuardRegistry'
import type { DisabledReasonInfo } from '~/components/entities/vault/form/types'
import { useToast } from '~/components/ui/composables/useToast'
import { getSubAccountAddress } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'
import { FixedPoint } from '~/utils/fixed-point'
import { getCashLimitedWithdrawAmount } from '~/utils/vault/withdraw'
import { createRaceGuard } from '~/utils/race-guard'
import { reportClientEvent } from '~/utils/client-observability'

const router = useRouter()
const route = useRoute()
const { error } = useToast()
const { planWithdrawOrRedeem } = useEulerTx()
const { create: createIntent } = useOperationIntentFactory()
const { open: openCeremonyReview } = useCeremonyReview()
const { addEntry: addBatchEntry } = useTxBatch()
const { redirectAfterAdd } = useBatchRedirect()
const { account: planAccount } = usePlanAccount()
const { getEarnVault, isMarketDataResolved } = useVaults()
const { isConnected, isSpyMode, effectiveAddress } = useEffectiveAddress()
const { runSimulation, simulationError, clearSimulationError } = useTransactionPlanSimulation()
const { viewer, visibleTotal } = useApyVisibility()
const vaultAddress = route.params.vault as string
useOperationGuard([vaultAddress])
const product = useEulerProductOfVault(vaultAddress)
const subAccountIndex = Number(route.params.subAccount)
const subAccount = computed(() => {
  const addr = effectiveAddress.value
  if (!addr || isNaN(subAccountIndex)) return undefined
  return getSubAccountAddress(getAddress(addr), subAccountIndex)
})

const isLoading = ref(false)
const isSubmitting = ref(false)
const isPreparing = ref(false)
const isEstimatesLoading = ref(false)
const amount = ref('')
const plan = ref<TransactionPlan | null>(null)
const vault: Ref<EulerEarn | undefined> = ref()
const asset: Ref<VaultAsset | undefined> = ref()
const earnVaultMarketLabel = computed(() => product.name || vault.value?.shares.name || '')
// Share/asset balances from the layer-aware account entity (no direct balanceOf).
const sharePosition = computed(() => {
  const acct = planAccount.value
  const sub = subAccount.value
  if (!acct || !sub || !vault.value?.address) return undefined
  try {
    const target = getAddress(vault.value.address)
    return acct.getSubAccount(getAddress(sub))?.positions.find(p => getAddress(p.vaultAddress) === target)
  }
  catch {
    return undefined
  }
})
const sharesBalance = computed(() => sharePosition.value?.shares ?? 0n)
const assetsBalance = computed(() => sharePosition.value?.assets ?? 0n)
const delta = ref(0n)
const estimateSupplyAPY = ref<number | undefined>(undefined)
const estimatesError = ref('')

// Reactive USD prices for display
const assetsBalanceUsd = ref(0)
const withdrawableAssetsUsd = ref(0)
const deltaUsd = ref(0)
const usdPriceGuard = createRaceGuard()

const supplyApyBreakdown = computed(() =>
  vault.value ? computeSupplyApyBreakdown(vault.value, viewer.value) : undefined,
)
const supplyApyTotal = computed(() => visibleTotal(supplyApyBreakdown.value) ?? 0)
const amountFixed = computed(() => {
  return FixedPoint.fromValue(
    valueToNano(amount.value || '0', asset.value?.decimals || 0),
    Number(asset.value?.decimals || 0),
  )
})
const withdrawableAssets = computed(() => getCashLimitedWithdrawAmount(
  assetsBalance.value,
  vault.value,
))
const isSubmitDisabled = computed(() => {
  if (!isConnected.value && !isSpyMode.value) return false
  return withdrawableAssets.value < amountFixed.value.value
    || isLoading.value
    || amountFixed.value.isZero() || amountFixed.value.isNegative()
    || !!(estimatesError.value)
})
const reviewWithdrawDisabled = isSubmitDisabled
const disabledReasonInfo = computed((): DisabledReasonInfo | undefined => {
  if (estimatesError.value) return { message: estimatesError.value, variant: 'error' }
  if (!amountFixed.value.isZero() && assetsBalance.value < amountFixed.value.value) return { message: 'Insufficient balance', variant: 'error' }
  if (!amountFixed.value.isZero() && withdrawableAssets.value < amountFixed.value.value) return { message: 'Not enough liquidity in vault', variant: 'error' }
  return undefined
})
const supplyAPYDisplay = computed(() => {
  return formatNumber(supplyApyTotal.value)
})
const estimateSupplyAPYDisplay = computed(() => {
  return formatNumber(estimateSupplyAPY.value ?? supplyApyTotal.value)
})

const load = async () => {
  isLoading.value = true
  try {
    vault.value = await getEarnVault(vaultAddress)
    estimateSupplyAPY.value = supplyApyTotal.value
    asset.value = vault.value?.asset

    // Fetch fresh share balance and convert to assets
    updateBalance()
  }
  catch (e) {
    showError('Unable to load Vault')
    console.warn(e)
  }
  finally {
    isLoading.value = false
  }
}

// balances are reactive computeds over the account entity; sync delta baseline.
const updateBalance = () => {
  delta.value = (!isConnected.value && !isSpyMode.value) ? 0n : assetsBalance.value
}
const submit = async () => {
  if (isOperationBlocked.value) return
  if (isPreparing.value) return
  isPreparing.value = true
  try {
    if (!asset.value?.address) {
      return
    }

    const capturedAmount = amount.value
    const isMax = FixedPoint.fromValue(assetsBalance.value, asset.value?.decimals).lte(amountFixed.value)
    const owner = (subAccount.value ?? effectiveAddress.value!) as `0x${string}`
    const plannerArgs = isMax
      ? { vaultAddress: vaultAddress as `0x${string}`, owner, shares: sharesBalance.value }
      : { vaultAddress: vaultAddress as `0x${string}`, owner, assets: amountFixed.value.value }
    const intent = createIntent({
      kind: 'withdraw',
      planner: isMax ? 'redeem' : 'withdraw',
      args: plannerArgs,
      source: 'pages/earn/[vault]/[subAccount]/withdraw.vue',
      subAccounts: [owner],
    })

    try {
      plan.value = await planWithdrawOrRedeem({
        vaultAddress: vaultAddress as `0x${string}`,
        owner,
        isMax,
        shares: sharesBalance.value,
        assets: amountFixed.value.value,
        account: planAccount.value,
      })
    }
    catch (e) {
      console.warn('[OperationReviewModal] failed to build plan', e)
      void reportClientEvent({
        event: 'tx_plan_build_failed',
        flow: 'earn_withdraw',
        phase: 'build',
        operationType: 'withdraw',
        vaultAddress,
        assetAddress: asset.value?.address,
      }, e)
      plan.value = null
    }

    if (plan.value) {
      const ok = await runSimulation(plan.value)
      if (!ok) {
        return
      }
    }

    await openCeremonyReview([intent], {
      presentationKind: 'withdraw',
      review: {
        type: 'withdraw',
        asset: asset.value,
        amount: capturedAmount,
        submittingLabel: 'Submitting...',
      },
      onSucceeded: () => {
        setTimeout(() => {
          router.replace({ path: '/portfolio/saving', query: { network: route.query.network } })
        }, 400)
      },
      onFailed: (cause) => {
        error('Transaction failed')
        console.error('Transaction error:', cause)
        void reportClientEvent({
          event: 'tx_execute_failed',
          flow: 'earn_withdraw',
          phase: 'execute',
          operationType: 'withdraw',
          vaultAddress,
        }, cause)
      },
    })
  }
  finally {
    isPreparing.value = false
  }
}
const canAddToBatch = computed(() =>
  !!(+amount.value) && !reviewWithdrawDisabled.value && !!asset.value?.address && !!(subAccount.value ?? effectiveAddress.value),
)
const addToBatch = async () => {
  if (!canAddToBatch.value || !asset.value?.address) return
  const assets = amountFixed.value.value
  const ownerAddr = (subAccount.value ?? effectiveAddress.value) as `0x${string}` | undefined
  if (!ownerAddr) return
  const label = `Earn withdraw ${amount.value} ${asset.value.symbol}`
  // Max withdraw → redeem the full share balance (redeem(full_balance)) instead
  // of withdraw(assets), so the position clears without share-price rounding dust.
  const isMax = FixedPoint.fromValue(assetsBalance.value, asset.value?.decimals).lte(amountFixed.value)
  const shares = sharesBalance.value
  const plannerArgs = isMax
    ? { vaultAddress: vaultAddress as `0x${string}`, owner: ownerAddr, shares }
    : { vaultAddress: vaultAddress as `0x${string}`, owner: ownerAddr, assets }
  const intent = createIntent({
    kind: 'withdraw',
    planner: isMax ? 'redeem' : 'withdraw',
    args: plannerArgs,
    source: 'pages/earn/[vault]/[subAccount]/withdraw.vue#batch',
    subAccounts: [ownerAddr],
  })
  await addBatchEntry({
    intent,
    label,
    subAccount: ownerAddr,
    review: { type: 'withdraw', asset: asset.value, amount: amount.value, marketLabel: earnVaultMarketLabel.value },
  })
  amount.value = ''
  redirectAfterAdd('/portfolio/saving', { subAccount: ownerAddr, vault: vaultAddress })
}

const updateEstimates = () => {
  clearSimulationError()
  estimatesError.value = ''
  if (!vault.value) return
  try {
    if (assetsBalance.value < amountFixed.value.value) {
      throw new Error('Not enough balance')
    }
    if (withdrawableAssets.value < amountFixed.value.value) {
      throw new Error('Not enough liquidity in vault')
    }
    delta.value = assetsBalance.value - amountFixed.value.value
    estimateSupplyAPY.value = supplyApyTotal.value
  }
  catch (e) {
    logWarn('earn-withdraw/estimates', e)
    delta.value = assetsBalance.value || 0n
    estimateSupplyAPY.value = supplyApyTotal.value
    estimatesError.value = (e as { message: string }).message
  }
  isEstimatesLoading.value = false
}

load()

// Update USD prices when vault or amounts change
watchEffect(async () => {
  const gen = usdPriceGuard.next()
  void isMarketDataResolved.value
  if (!vault.value) {
    assetsBalanceUsd.value = 0
    withdrawableAssetsUsd.value = 0
    deltaUsd.value = 0
    return
  }
  const [nextAssetsBalanceUsd, nextWithdrawableAssetsUsd, nextDeltaUsd] = await Promise.all([
    getAssetUsdValueOrZero(assetsBalance.value, vault.value, 'off-chain'),
    getAssetUsdValueOrZero(withdrawableAssets.value, vault.value, 'off-chain'),
    getAssetUsdValueOrZero(delta.value, vault.value, 'off-chain'),
  ])
  if (usdPriceGuard.isStale(gen)) return
  assetsBalanceUsd.value = nextAssetsBalanceUsd
  withdrawableAssetsUsd.value = nextWithdrawableAssetsUsd
  deltaUsd.value = nextDeltaUsd
})

watch([isConnected, effectiveAddress, assetsBalance], () => {
  if (vault.value) updateBalance()
})
watch(amount, () => {
  updateEstimates()
})
</script>

<template>
  <div class="relative">
    <BackButton
      class="hidden tablet:inline-flex tablet:absolute tablet:top-20 tablet:right-full tablet:mr-4"
      :fallback="`/earn/${vaultAddress}`"
    />
    <VaultForm
      back
      :back-fallback="`/earn/${vaultAddress}`"
      title="Withdraw savings"
      description="Withdraw your supplied assets back to your wallet."
      class="flex flex-col gap-16"
      :loading="isLoading"
      @submit.prevent="submit"
    >
      <template v-if="vault && asset">
        <VaultLabelsAndAssets
          :vault="vault"
          :assets="[asset]"
          size="large"
        />

        <div class="grid gap-16 laptop:grid-cols-[minmax(0,1fr)_360px] laptop:items-start">
          <div class="flex flex-col gap-16 w-full">
            <AssetInput
              v-if="asset"
              v-model="amount"
              label="Withdraw amount"
              :asset="asset"
              :vault="vault"
              :balance="withdrawableAssets"
              maxable
            />

            <UiAlert
              v-show="estimatesError"
              title="Error"
              variant="error"
              :description="estimatesError"
              size="compact"
            />
            <UiAlert
              v-if="simulationError"
              title="Error"
              variant="error"
              :description="simulationError"
              size="compact"
            />
          </div>

          <VaultFormInfoBlock
            :loading="isEstimatesLoading"
            variant="card"
            class="w-full laptop:max-w-[360px]"
          >
            <SummaryRow label="Supply APY">
              <SummaryValue
                :before="supplyAPYDisplay"
                :after="estimateSupplyAPYDisplay"
                suffix="%"
              />
            </SummaryRow>
            <SummaryRow label="Supplied">
              <SummaryValue
                :before="`$${formatNumber(assetsBalanceUsd)}`"
                :after="amount && delta !== assetsBalance && delta >= 0n ? `$${formatNumber(deltaUsd)}` : undefined"
              />
            </SummaryRow>
            <SummaryRow label="Available for withdraw">
              <p
                v-if="asset"
                class="text-p2 flex items-center gap-4"
              >
                <UiExactAmount :exact="formatExactAmount(withdrawableAssets, asset.decimals, asset.symbol)">
                  {{ formatSmartAmount(nanoToValue(withdrawableAssets, asset.decimals)) }}
                  <span class="text-p3 text-content-tertiary">{{ asset.symbol }}</span>
                </UiExactAmount>
                <span class="text-p3 text-content-tertiary">&asymp; ${{ formatNumber(withdrawableAssetsUsd) }}</span>
              </p>
            </SummaryRow>
          </VaultFormInfoBlock>

          <div class="flex flex-col gap-8 laptop:col-start-1 laptop:row-start-2">
            <VaultFormSubmit
              :loading="isSubmitting || isPreparing"
              :disabled="reviewWithdrawDisabled"
              :disabled-reason="disabledReasonInfo?.message"
              :disabled-reason-variant="disabledReasonInfo?.variant"
              :can-add-to-batch="canAddToBatch"
              @add-to-batch="addToBatch"
            >
              Review Withdraw
            </VaultFormSubmit>
          </div>
        </div>
      </template>
    </VaultForm>
  </div>
</template>
