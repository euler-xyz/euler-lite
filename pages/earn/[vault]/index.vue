<script setup lang="ts">
import type { VaultAsset } from '~/types/asset'
import { computeSupplyApyBreakdown, type TransactionPlan, type EulerEarn } from '@eulerxyz/euler-v2-sdk'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'
import { getVaultIntrinsicApyInfo } from '~/utils/vault-intrinsic-apy'
import { isVaultBlockedByCountry } from '~/composables/useGeoBlock'
import VaultFormInfoBlock from '~/components/entities/vault/form/VaultFormInfoBlock.vue'
import VaultFormSubmit from '~/components/entities/vault/form/VaultFormSubmit.vue'
import { formatNumber } from '~/utils/string-utils'
import { isOperationBlocked } from '~/utils/operationGuardRegistry'
import type { DisabledReasonInfo } from '~/components/entities/vault/form/types'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import type { Address } from 'viem'
import { VaultUnverifiedDisclaimerModal, OperationReviewModal, VaultApyModal } from '#components'

const router = useRouter()
const route = useRoute()
const modal = useModal()
const { error } = useToast()
const { planDeposit, executePlan } = useEulerTx()
const { addEntry: addBatchEntry } = useTxBatch()
const { redirectAfterAdd } = useBatchRedirect()
const { account: planAccount } = usePlanAccount()
const { getEarnVault, updateEarnVault } = useVaults()
const { isReady: isLabelsReady } = useEulerLabels()
const { isConnected, address } = useWagmi()
const { isSpyMode } = useSpyMode()
const { chainId } = useEulerAddresses()
const { primeSlotHintsFor } = useStateOverrideOptions()
const shareLinkQuery = computed(() => {
  const network = route.query.network

  return {
    network: Array.isArray(network) ? network[0] ?? chainId.value : network ?? chainId.value,
  }
})
const { getBalance } = useWallets()
const { runSimulation, simulationError, clearSimulationError } = useTransactionPlanSimulation()
const vaultAddress = route.params.vault as string
useOperationGuard([vaultAddress])
const { name } = useEulerProductOfVault(vaultAddress)
const { settings } = useUserSettings()
const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
const { hasSupplyRewards, getSupplyRewardCampaigns } = useRewardsApy()
const { viewer, visibleTotal, visibleBreakdown } = useApyVisibility()

const isLoading = ref(false)
const isSubmitting = ref(false)
const isPreparing = ref(false)
const isEstimatesLoading = ref(false)
const amount = ref('')
const plan = ref<TransactionPlan | null>(null)
const vault: Ref<EulerEarn | undefined> = ref(undefined)
const asset: Ref<VaultAsset | undefined> = ref(undefined)
const estimateSupplyAPY = ref(0)
const earnVaultMarketLabel = computed(() => unref(name) || vault.value?.shares.name || '')
// Wallet balance from the central (layer-aware) wallet entity — reactive, no
// direct balanceOf.
const balance = computed(() => asset.value?.address ? getBalance(asset.value.address as Address) : 0n)
const supplyRewardCampaigns = computed(() => getSupplyRewardCampaigns(vaultAddress))
const hasRewards = computed(() => settings.value.enableRewardsApy && hasSupplyRewards(vaultAddress))
const supplyApyBreakdown = computed(() => vault.value ? computeSupplyApyBreakdown(vault.value, viewer.value) : undefined)
const visibleApyBreakdown = computed(() => visibleBreakdown(supplyApyBreakdown.value))
const supplyApyTotal = computed(() => visibleTotal(supplyApyBreakdown.value) ?? 0)

watch(
  () => asset.value?.address,
  (assetAddress) => {
    if (assetAddress) void primeSlotHintsFor([assetAddress as Address])
  },
  { immediate: true },
)

const applyLoadedVault = (loadedVault: EulerEarn) => {
  vault.value = loadedVault
  asset.value = loadedVault.asset
  estimateSupplyAPY.value = supplyApyTotal.value
}

const refreshEarnVault = async (address: string, silent = false) => {
  try {
    applyLoadedVault(await updateEarnVault(address))
  }
  catch (e) {
    if (!silent) throw e
    logWarn('[earn] failed to refresh vault', e)
  }
}

// Non-blocking to avoid Suspense + pageTransition crash on direct navigation
;(async () => {
  try {
    // Wait for labels so `verified` is set correctly on direct navigation.
    // Otherwise getEarnVault falls through to a direct fetch with empty
    // earnVaultAddresses and returns verified: false.
    if (!isLabelsReady.value) {
      await until(isLabelsReady).toBe(true)
    }
    applyLoadedVault(await getEarnVault(vaultAddress))

    if (!useVaultRegistry().isVerifiedVault(vault.value.address)) {
      modal.open(VaultUnverifiedDisclaimerModal, {
        isNotClosable: true,
        props: {
          cancelAction: () => {
            router.replace('/')
          },
        },
      })
    }

    void refreshEarnVault(vault.value.address, true)
  }
  catch (e) {
    showError('Unable to load Vault')
    logWarn('[earn] failed to load vault', e)
  }
})()
const errorText = computed(() => {
  if (balance.value < valueToNano(amount.value, asset.value?.decimals)) {
    return 'Not enough balance'
  }
  return null
})
const assets = computed(() => [asset.value!])
const isSubmitDisabled = computed(() => {
  if (!isConnected.value && !isSpyMode.value) return false
  return balance.value < valueToNano(amount.value, asset.value?.decimals)
    || isLoading.value || !(+amount.value)
})
const isGeoBlocked = computed(() => isVaultBlockedByCountry(vaultAddress))
const reviewSupplyDisabled = computed(() => isGeoBlocked.value || isSubmitDisabled.value)
const disabledReasonInfo = computed((): DisabledReasonInfo | undefined => {
  if (isGeoBlocked.value) return { message: 'This operation is not available in your region', variant: 'warning' }
  if (errorText.value) return { message: errorText.value, variant: 'error' }
  return undefined
})
const supplyAPYDisplay = computed(() => {
  if (!vault.value) return '0.00'
  return formatNumber(supplyApyTotal.value)
})
const estimateSupplyAPYDisplay = computed(() => {
  return formatNumber(estimateSupplyAPY.value)
})
const submit = async () => {
  if (isOperationBlocked.value) return
  if (isPreparing.value || isGeoBlocked.value) return
  isPreparing.value = true
  try {
    if (!asset.value?.address) {
      return
    }

    try {
      plan.value = await planDeposit({
        vaultAddress: vaultAddress as Address,
        assetAddress: asset.value.address as Address,
        amount: valueToNano(amount.value || '0', asset.value.decimals),
        account: planAccount.value,
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
        type: 'supply',
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
const canAddToBatch = computed(() => !!(+amount.value) && !isGeoBlocked.value)
const addToBatch = async () => {
  if (!asset.value?.address || !canAddToBatch.value) return
  const assetAddr = asset.value.address as Address
  const amt = valueToNano(amount.value, asset.value.decimals)
  const label = `Earn deposit ${amount.value} ${asset.value.symbol}`
  await addBatchEntry({
    label,
    buildPlan: account => planDeposit({ vaultAddress: vaultAddress as Address, assetAddress: assetAddr, amount: amt, account }),
    review: { type: 'supply', asset: asset.value, amount: amount.value, marketLabel: earnVaultMarketLabel.value },
  })
  amount.value = ''
  redirectAfterAdd('/portfolio/saving', { subAccount: address.value, vault: vaultAddress })
}

const send = async () => {
  try {
    isSubmitting.value = true
    if (!asset.value?.address) {
      return
    }
    const txPlan = plan.value ?? await planDeposit({
      vaultAddress: vaultAddress as Address,
      assetAddress: asset.value.address as Address,
      amount: valueToNano(amount.value || '0', asset.value.decimals),
      account: planAccount.value,
    })
    await executePlan(txPlan)

    modal.close()
    await updateEstimates()
    setTimeout(() => {
      router.replace({ path: '/portfolio/saving', query: { network: route.query.network } })
    }, 400)
  }
  catch (e) {
    error('Transaction failed')
    console.warn(e)
  }
  finally {
    isSubmitting.value = false
  }
}
const updateEstimates = async () => {
  if (!vault.value) return
  try {
    await refreshEarnVault(vault.value.address)
  }
  catch (e) {
    logWarn('earn-supply/estimates', e)
  }
  finally {
    isEstimatesLoading.value = false
  }
}
const supplyApyModalData = computed(() => ({
  props: {
    mode: 'supply',
    lendingAPY: visibleApyBreakdown.value?.lending ?? 0,
    intrinsicAPY: visibleApyBreakdown.value?.intrinsicApy ?? 0,
    intrinsicApyInfo: getVaultIntrinsicApyInfo(vault.value, enableIntrinsicApy.value),
    campaigns: settings.value.enableRewardsApy ? supplyRewardCampaigns.value : [],
    totalSupplyAPY: supplyApyTotal.value,
    rewardVaultAddress: vaultAddress,
  },
}))

watch(amount, () => {
  clearSimulationError()
  updateEstimates()
})
</script>

<template>
  <div class="relative">
    <div
      v-if="!vault"
      class="flex justify-center items-center min-h-[50dvh]"
    >
      <UiLoader />
    </div>
    <template v-else>
      <BackButton
        class="hidden tablet:inline-flex tablet:absolute tablet:top-8 tablet:right-full tablet:mr-12"
        fallback="/earn"
      />
      <div
        v-if="asset"
        class="mb-24"
      >
        <VaultLabelsAndAssets
          back
          back-fallback="/earn"
          :vault="vault"
          :assets="assets"
          size="large"
        >
          <UiShareLinkButton
            class="-ml-4 !w-24 !h-24"
            :path="`/earn/${vault.address}`"
            :query="shareLinkQuery"
            label="Copy vault link"
            variant="ghost"
          />
        </VaultLabelsAndAssets>
      </div>

      <div class="flex gap-32">
        <div class="hidden laptop:!block laptop:flex-[55] min-w-0">
          <VaultOverviewEarn
            v-if="vault"
            :vault="vault as EulerEarn"
            desktop-overview
            @vault-click="(address: string) => router.push({ path: `/lend/${address}`, query: { network: route.query.network } })"
          />
        </div>
        <div class="flex flex-col gap-16 w-full laptop:flex-[45] laptop:sticky laptop:top-[88px] laptop:self-start">
          <VaultForm
            class="w-full"
            @submit.prevent="submit"
          >
            <div
              v-if="vault && asset"
              class="flex items-center justify-between"
            >
              <p class="text-h3 text-content-tertiary flex items-center gap-4">
                Supply APY
                <UiModalPreviewTrigger
                  :component="VaultApyModal"
                  :modal-data="supplyApyModalData"
                  aria-label="Show supply APY breakdown"
                >
                  <SvgIcon
                    class="!w-20 !h-20 text-content-muted cursor-pointer hover:text-content-secondary"
                    name="info-circle"
                  />
                </UiModalPreviewTrigger>
              </p>

              <p class="flex items-center gap-4 text-h3">
                <VaultPoints
                  :vault="vault"
                />
                <UiModalPreviewTrigger
                  v-if="hasRewards"
                  :component="VaultApyModal"
                  :modal-data="supplyApyModalData"
                  aria-label="Show supply APY rewards breakdown"
                >
                  <SvgIcon
                    class="!w-24 !h-24 text-accent-500 cursor-pointer"
                    name="sparks"
                  />
                </UiModalPreviewTrigger>
                <span>
                  {{ supplyAPYDisplay }}%
                </span>
              </p>
            </div>

            <AssetInput
              v-if="asset"
              v-model="amount"
              label="Supply amount"
              :desc="name"
              :asset="asset"
              :vault="vault"
              :balance="balance"
              maxable
            />

            <UiAlert
              v-if="isGeoBlocked"
              title="Region restricted"
              description="This operation is not available in your region. You can still withdraw existing deposits."
              variant="warning"
              size="compact"
            />
            <UiAlert
              v-show="errorText"
              title="Error"
              variant="error"
              :description="errorText || ''"
              size="compact"
            />
            <UiAlert
              v-if="simulationError"
              title="Error"
              variant="error"
              :description="simulationError"
              size="compact"
            />

            <VaultFormInfoBlock
              v-if="vault && asset"
              :loading="isEstimatesLoading"
              variant="card"
            >
              <SummaryRow label="Supply APY">
                <SummaryValue
                  :after="estimateSupplyAPYDisplay"
                  suffix="%"
                  estimate-only
                />
              </SummaryRow>
            </VaultFormInfoBlock>

            <template #buttons>
              <VaultFormInfoButton
                :earn-vault="vault"
                class="laptop:!hidden"
                :disabled="isLoading || isSubmitting"
              />
              <VaultFormSubmit
                :disabled="reviewSupplyDisabled"
                :disabled-reason="disabledReasonInfo?.message"
                :disabled-reason-variant="disabledReasonInfo?.variant"
                :loading="isSubmitting || isPreparing"
                :can-add-to-batch="canAddToBatch"
                @add-to-batch="addToBatch"
              >
                Review Supply
              </VaultFormSubmit>
            </template>
          </VaultForm>
        </div>
      </div>
    </template>
  </div>
</template>
