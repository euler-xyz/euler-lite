<script setup lang="ts">
import type { VaultAsset } from '~/types/asset'
import { getAssetUsdValueOrZero } from '~/utils/sdk-prices'
import type { TransactionPlan, EulerEarn } from '@eulerxyz/euler-v2-sdk'
import { formatNumber, formatSmartAmount, formatExactAmount } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import { isOperationBlocked } from '~/utils/operationGuardRegistry'
import type { DisabledReasonInfo } from '~/components/entities/vault/form/types'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import { getSubAccountAddress } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'
import { OperationReviewModal } from '#components'
import { FixedPoint } from '~/utils/fixed-point'
import { getCashLimitedWithdrawAmount } from '~/utils/vault/withdraw'

const router = useRouter()
const route = useRoute()
const modal = useModal()
const { error } = useToast()
const { planWithdrawOrRedeem, executePlan } = useEulerTx()
const { getEarnVault } = useVaults()
const { isConnected, address } = useWagmi()
const { isSpyMode, spyAddress } = useSpyMode()
const effectiveAddress = computed(() => isSpyMode.value ? spyAddress.value : address.value)
const { fetchVaultShareBalance } = useWallets()
const { runSimulation, simulationError, clearSimulationError } = useTransactionPlanSimulation()
const { getSupplyRewardApy } = useRewardsApy()
const vaultAddress = route.params.vault as string
useOperationGuard([vaultAddress])
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
const assetsBalance = ref(0n)
const sharesBalance = ref(0n)
const delta = ref(0n)
const estimateSupplyAPY = ref(0)
const estimatesError = ref('')

// Reactive USD prices for display
const assetsBalanceUsd = ref(0)
const withdrawableAssetsUsd = ref(0)
const deltaUsd = ref(0)

const rewardApy = computed(() => getSupplyRewardApy(vault.value?.address || ''))
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
  if (!isConnected.value) return false
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
  if (!vault.value) return '0.00'
  return formatNumber(getVaultSupplyApy(vault.value) + rewardApy.value)
})
const estimateSupplyAPYDisplay = computed(() => {
  return formatNumber(estimateSupplyAPY.value + rewardApy.value)
})

const load = async () => {
  isLoading.value = true
  try {
    vault.value = await getEarnVault(vaultAddress)
    estimateSupplyAPY.value = getVaultSupplyApy(vault.value)
    asset.value = vault.value?.asset

    // Fetch fresh share balance and convert to assets
    await fetchShareBalance()
    await updateBalance()
  }
  catch (e) {
    showError('Unable to load Vault')
    console.warn(e)
  }
  finally {
    isLoading.value = false
  }
}

const fetchShareBalance = async () => {
  if (!vault.value?.address) {
    sharesBalance.value = 0n
    return
  }
  sharesBalance.value = await fetchVaultShareBalance(vault.value.address, subAccount.value)
}

const updateBalance = async () => {
  if (!vault.value || (!isConnected.value && !isSpyMode.value) || sharesBalance.value === 0n) {
    assetsBalance.value = 0n
    delta.value = 0n
    return
  }

  assetsBalance.value = vault.value.convertToAssets(sharesBalance.value)
  delta.value = assetsBalance.value
}
const submit = async () => {
  if (isOperationBlocked.value) return
  if (isPreparing.value) return
  isPreparing.value = true
  try {
    if (!asset.value?.address) {
      return
    }

    const isMax = FixedPoint.fromValue(assetsBalance.value, asset.value?.decimals).lte(amountFixed.value)

    try {
      plan.value = await planWithdrawOrRedeem({
        vaultAddress: vaultAddress as `0x${string}`,
        owner: (subAccount.value ?? effectiveAddress.value!) as `0x${string}`,
        isMax,
        shares: sharesBalance.value,
        assets: amountFixed.value.value,
      })
    }
    catch (e) {
      console.warn('[OperationReviewModal] failed to build plan', e)
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
        type: 'withdraw',
        asset: asset.value,
        amount: amount.value,
        plan: plan.value || undefined,
        submittingLabel: 'Submitting...',
        onConfirm: async () => {
          await send()
        },
      },
    })
  }
  finally {
    isPreparing.value = false
  }
}
const send = async () => {
  try {
    isSubmitting.value = true
    if (!asset.value?.address) {
      console.error('No asset address')
      return
    }

    if (!plan.value) return
    await executePlan(plan.value)

    modal.close()
    setTimeout(() => {
      router.replace({ path: '/portfolio/saving', query: { network: route.query.network } })
    }, 400)
  }
  catch (e) {
    error('Transaction failed')
    console.error('Transaction error:', e)
  }
  finally {
    isSubmitting.value = false
  }
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
    estimateSupplyAPY.value = getVaultSupplyApy(vault.value)
  }
  catch (e) {
    logWarn('earn-withdraw/estimates', e)
    delta.value = assetsBalance.value || 0n
    estimateSupplyAPY.value = getVaultSupplyApy(vault.value)
    estimatesError.value = (e as { message: string }).message
  }
  isEstimatesLoading.value = false
}

load()

// Update USD prices when vault or amounts change
watchEffect(async () => {
  if (!vault.value) {
    assetsBalanceUsd.value = 0
    withdrawableAssetsUsd.value = 0
    deltaUsd.value = 0
    return
  }
  assetsBalanceUsd.value = await getAssetUsdValueOrZero(assetsBalance.value, vault.value, 'off-chain')
  withdrawableAssetsUsd.value = await getAssetUsdValueOrZero(withdrawableAssets.value, vault.value, 'off-chain')
  deltaUsd.value = await getAssetUsdValueOrZero(delta.value, vault.value, 'off-chain')
})

watch([isConnected, effectiveAddress], async () => {
  if (vault.value) {
    await fetchShareBalance()
    await updateBalance()
  }
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

            <UiToast
              v-show="estimatesError"
              title="Error"
              variant="error"
              :description="estimatesError"
              size="compact"
            />
            <UiToast
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
            >
              Review Withdraw
            </VaultFormSubmit>
          </div>
        </div>
      </template>
    </VaultForm>
  </div>
</template>
