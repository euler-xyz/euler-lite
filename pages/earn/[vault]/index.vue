<script setup lang="ts">
import { useAccount } from '@wagmi/vue'
import { useModal } from '~/components/ui/composables/useModal'
import { OperationReviewModal, VaultSupplyApyModal, VaultUnverifiedDisclaimerModal } from '#components'
import { useTermsOfUseGate } from '~/composables/useTermsOfUseGate'
import { useToast } from '~/components/ui/composables/useToast'
import type { EarnVault, VaultAsset } from '~/entities/vault'
import { getAssetUsdValueOrZero } from '~/services/pricing/priceProvider'
import type { TxPlan } from '~/entities/txPlan'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'
import { isVaultBlockedByCountry } from '~/composables/useGeoBlock'
import VaultFormInfoBlock from '~/components/entities/vault/form/VaultFormInfoBlock.vue'
import VaultFormSubmit from '~/components/entities/vault/form/VaultFormSubmit.vue'
import { formatNumber, compactNumber } from '~/utils/string-utils'

const router = useRouter()
const route = useRoute()
const modal = useModal()
const { error } = useToast()
const { getSubmitLabel, getSubmitDisabled, guardWithTerms } = useTermsOfUseGate()
const reviewSupplyLabel = getSubmitLabel('Review Supply')
const { buildSupplyPlan, executeTxPlan } = useEulerOperations()
const { getEarnVault, updateEarnVault } = useVaults()
const { isConnected, address } = useAccount()
const { fetchSingleBalance } = useWallets()
const { runSimulation, simulationError, clearSimulationError } = useTxPlanSimulation()
const vaultAddress = route.params.vault as string
const { name } = useEulerProductOfVault(vaultAddress)
const { getIntrinsicApy, getIntrinsicApyInfo } = useIntrinsicApy()
const { getSupplyRewardApy, hasSupplyRewards, getSupplyRewardCampaigns } = useRewardsApy()

const isLoading = ref(false)
const isSubmitting = ref(false)
const isPreparing = ref(false)
const isEstimatesLoading = ref(false)
const amount = ref('')
const plan = ref<TxPlan | null>(null)
const vault: Ref<EarnVault | undefined> = ref(undefined)
const asset: Ref<VaultAsset | undefined> = ref(undefined)
const estimateSupplyAPY = ref(0)
const monthlyEarnings = ref(0)
const monthlyEarningsUsd = ref(0)
const balance = ref(0n)

const fetchBalance = async () => {
  if (!asset.value?.address) {
    balance.value = 0n
    return
  }
  balance.value = await fetchSingleBalance(asset.value.address)
}

// Load vault data with top-level await
try {
  vault.value = await getEarnVault(vaultAddress)
  asset.value = vault.value?.asset

  // Fetch fresh underlying asset balance for this specific vault
  await fetchBalance()

  if (!vault.value?.verified) {
    modal.open(VaultUnverifiedDisclaimerModal, {
      isNotClosable: true,
      props: {
        onCancel: () => {
          router.replace('/')
        },
      },
    })
  }
}
catch (e) {
  showError('Unable to load Vault')
  console.warn(e)
}
const errorText = computed(() => {
  if (balance.value < valueToNano(amount.value, asset.value?.decimals)) {
    return 'Not enough balance'
  }
  return null
})
const assets = computed(() => [asset.value!])
const isSubmitDisabled = computed(() => {
  if (!isConnected.value) return false
  return balance.value < valueToNano(amount.value, asset.value?.decimals)
    || isLoading.value || !(+amount.value)
})
const isGeoBlocked = computed(() => isVaultBlockedByCountry(vaultAddress))
const reviewSupplyDisabled = getSubmitDisabled(computed(() => isGeoBlocked.value || isSubmitDisabled.value))
const totalRewardsAPY = computed(() => getSupplyRewardApy(vaultAddress))
const hasRewards = computed(() => hasSupplyRewards(vaultAddress))
const intrinsicApy = computed(() => getIntrinsicApy(vault.value?.asset.address))
const supplyAPYDisplay = computed(() => {
  if (!vault.value) return '0.00'
  return formatNumber(nanoToValue(vault.value!.interestRateInfo.supplyAPY, 25) + totalRewardsAPY.value)
})
const estimateSupplyAPYDisplay = computed(() => {
  return formatNumber(estimateSupplyAPY.value)
})
const submit = async () => {
  if (isPreparing.value || isGeoBlocked.value) return
  isPreparing.value = true
  try {
    await guardWithTerms(async () => {
      if (!asset.value?.address) {
        return
      }

      try {
        plan.value = await buildSupplyPlan(
          vaultAddress,
          asset.value.address,
          valueToNano(amount.value || '0', asset.value.decimals),
          undefined,
          { includePermit2Call: false },
        )
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
          onConfirm: () => {
            setTimeout(() => {
              send()
            }, 400)
          },
        },
      })
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
      return
    }
    const txPlan = await buildSupplyPlan(vaultAddress, asset.value.address, valueToNano(amount.value || '0', asset.value.decimals), undefined, { includePermit2Call: true })
    await executeTxPlan(txPlan)

    modal.close()
    await updateEstimates()
    setTimeout(() => {
      router.replace('/portfolio/saving')
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
const updateEstimates = useDebounceFn(async () => {
  if (!vault.value) {
    return
  }
  try {
    await updateEarnVault(vault.value.address)
    if (!asset.value?.address) {
      return
    }
    estimateSupplyAPY.value = nanoToValue(vault.value.interestRateInfo.supplyAPY, 25) + totalRewardsAPY.value
    monthlyEarnings.value = !amount.value
      ? 0
      : +(amount.value || 0) * (estimateSupplyAPY.value / 12 / 100)
  }
  catch (e) {
    console.warn(e)
  }
  finally {
    isEstimatesLoading.value = false
  }
}, 500)
const onSupplyInfoIconClick = () => {
  modal.open(VaultSupplyApyModal, {
    props: {
      lendingAPY: nanoToValue(vault.value!.interestRateInfo.supplyAPY, 25),
      intrinsicAPY: intrinsicApy.value,
      intrinsicApyInfo: getIntrinsicApyInfo(vault.value?.asset.address),
      campaigns: getSupplyRewardCampaigns(vaultAddress),
    },
  })
}

// Initialize estimateSupplyAPY after vault is loaded
estimateSupplyAPY.value = nanoToValue(vault.value?.interestRateInfo.supplyAPY ?? 0n, 25) + totalRewardsAPY.value

// Update USD value when monthlyEarnings or vault changes
watchEffect(async () => {
  if (!vault.value || !monthlyEarnings.value) {
    monthlyEarningsUsd.value = 0
    return
  }
  monthlyEarningsUsd.value = await getAssetUsdValueOrZero(monthlyEarnings.value, vault.value, 'off-chain')
})

watch(amount, async () => {
  clearSimulationError()
  if (!vault.value) {
    return
  }
  if (!isEstimatesLoading.value) {
    isEstimatesLoading.value = true
  }
  updateEstimates()
})

watch(address, () => {
  fetchBalance()
})
</script>

<template>
  <div class="flex gap-32">
    <div class="flex flex-col gap-16 w-full laptop:sticky laptop:top-[104px] laptop:self-start">
      <BaseBackButton class="laptop:!hidden" />
      <VaultForm
        title="Open earn position"
        class="w-full"
        @submit.prevent="submit"
      >
        <div
          v-if="vault && asset"
          class="flex justify-between"
        >
          <VaultLabelsAndAssets
            :vault="vault"
            :assets="assets"
            size="large"
          />

          <div class="flex flex-col items-end justify-end">
            <p class="mb-4 text-content-tertiary flex items-center gap-4">
              Supply APY
              <SvgIcon
                class="!w-20 !h-20 text-content-muted cursor-pointer hover:text-content-secondary"
                name="info-circle"
                @click="onSupplyInfoIconClick"
              />
            </p>

            <p class="flex justify-end gap-4 text-h3">
              <VaultPoints
                :vault="vault"
              />
              <SvgIcon
                v-if="hasRewards"
                class="!w-24 !h-24 text-aquamarine-700 cursor-pointer"
                name="sparks"
                @click="onSupplyInfoIconClick"
              />
              <span>
                {{ supplyAPYDisplay }}%
              </span>
            </p>
          </div>
        </div>

        <AssetInput
          v-if="asset"
          v-model="amount"
          label="Deposit amount"
          :desc="name"
          :asset="asset"
          :vault="vault"
          :balance="balance"
          maxable
        />

        <UiToast
          v-if="isGeoBlocked"
          title="Region restricted"
          description="This operation is not available in your region. You can still withdraw existing deposits."
          variant="warning"
          size="compact"
        />
        <UiToast
          v-show="errorText"
          title="Error"
          variant="error"
          :description="errorText || ''"
          size="compact"
        />
        <UiToast
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
          <SummaryRow
            label="Projected earnings per month"
            align-top
          >
            <p class="text-content-tertiary">
              <span class="text-content-primary text-p2">{{ compactNumber(monthlyEarnings, 4) }}</span> {{
                asset.symbol
              }}
              ≈ ${{ compactNumber(monthlyEarningsUsd) }}
            </p>
          </SummaryRow>

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
            :loading="isSubmitting || isPreparing"
          >
            {{ reviewSupplyLabel }}
          </VaultFormSubmit>
        </template>
      </VaultForm>
    </div>
    <div class="w-full mobile:hidden">
      <VaultOverviewEarn
        v-if="vault"
        :vault="vault as EarnVault"
        desktop-overview
        @vault-click="(address: string) => router.push(`/lend/${address}`)"
      />
    </div>
  </div>
</template>
