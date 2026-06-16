<script setup lang="ts">
import { formatUnits, getAddress, maxUint256, type Address } from 'viem'
import type { TransactionPlan, TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { OperationReviewModal } from '#components'
import { getNewSubAccount } from '~/composables/useSubAccounts'
import { useExternalMigrationPositions, type MorphoMigrationCandidate } from '~/composables/useExternalMigrationPositions'
import { MORPHO_CONNECTOR_ID } from '~/entities/migration/protocols'
import type { AnyBorrowVaultPair } from '~/types/borrow-pair'
import { isSecuritizeBorrowPair } from '~/types/borrow-pair'
import { isOpDisabled, OP_BORROW, OP_DEPOSIT } from '~/utils/vault-hooks'
import { isAnyVaultBlockedByCountry } from '~/composables/useGeoBlock'
import { ltvToPercent } from '~/utils/crypto-utils'
import { formatNumber, formatSmartAmount, formatUsdValue } from '~/utils/string-utils'
import { getVaultProductName } from '~/utils/eulerLabelsUtils'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import { logWarn } from '~/utils/errorHandling'

defineOptions({
  name: 'BorrowMigratePage',
})

const router = useRouter()
const route = useRoute()
const modal = useModal()
const { error: showError } = useToast()
const { isConnected } = useWagmi()
const { isSpyMode } = useSpyMode()
const { settings } = useUserSettings()
const enableCrossProtocolRefinance = computed(() => settings.value.enableCrossProtocolRefinance)
const { borrowList, isEVaultUpdating, isEscrowUpdating } = useVaults()
const { chainId } = useEulerAddresses()
const {
  positions,
  owner,
  isLoading: isPositionsLoading,
  error: positionsError,
  load: reloadPositions,
} = useExternalMigrationPositions({
  enabled: enableCrossProtocolRefinance,
})
const {
  getMigrationAuthorization,
  signMigrationAuthorization,
  planCrossProtocolMigration,
  prepareTransactionPlan,
  executePreparedPlan,
} = useEulerTx()
const { runPreparedSimulation, simulationError, clearSimulationError } = useTransactionPlanSimulation()

const selectedPositionId = ref('')
const selectedPair = ref<string[]>([])
const isPreparing = ref(false)
const isSubmitting = ref(false)
const plan = shallowRef<TransactionPlan | null>(null)
const preparedPlan = shallowRef<TransactionPlanPrepared | null>(null)

const sameAddress = (a?: string, b?: string) => {
  if (!a || !b) return false
  try {
    return getAddress(a) === getAddress(b)
  }
  catch {
    return false
  }
}

const selectedPosition = computed(() =>
  positions.value.find(position => position.id === selectedPositionId.value) ?? positions.value[0],
)

const targetBorrowAmount = computed(() => {
  const debt = selectedPosition.value?.debt.amount ?? 0n
  return debt > 0n ? (debt * 10_100n) / 10_000n : 0n
})

const targetPairKey = (pair: AnyBorrowVaultPair) => `${pair.collateral.address}|${pair.borrow.address}`

const isCompatiblePair = (pair: AnyBorrowVaultPair, source: MorphoMigrationCandidate) => {
  if (isSecuritizeBorrowPair(pair)) return false
  if (!sameAddress(pair.borrow.asset.address, source.debt.address)) return false
  if (!sameAddress(pair.collateral.asset.address, source.collateral.address)) return false
  if (isOpDisabled(pair.borrow, OP_BORROW) || isOpDisabled(pair.collateral, OP_DEPOSIT)) return false
  if (isAnyVaultBlockedByCountry(pair.borrow.address, pair.collateral.address)) return false
  if (!pair.borrow.collaterals.some(ltv => sameAddress(ltv.address, pair.collateral.address) && ltv.borrowLTV > 0)) return false

  const borrowAmount = targetBorrowAmount.value
  if (borrowAmount > 0n && pair.borrow.availableLiquidity < borrowAmount) return false
  if (pair.borrow.caps.borrowCap > 0n && pair.borrow.caps.borrowCap < maxUint256 && pair.borrow.totalBorrowed + borrowAmount > pair.borrow.caps.borrowCap) return false
  if (pair.collateral.caps.supplyCap > 0n && pair.collateral.caps.supplyCap < maxUint256 && pair.collateral.totalAssets + source.collateral.amount > pair.collateral.caps.supplyCap) return false
  return true
}

const compatiblePairs = computed(() => {
  const source = selectedPosition.value
  if (!source) return []
  return borrowList.value.filter(pair => isCompatiblePair(pair, source))
})

const selectedTargetPair = computed(() => {
  const selected = selectedPair.value[0]
  return compatiblePairs.value.find(pair => targetPairKey(pair) === selected) ?? compatiblePairs.value[0]
})

const targetOptions = computed(() =>
  compatiblePairs.value.map((pair) => {
    const ltv = pair.borrow.collaterals.find(edge => sameAddress(edge.address, pair.collateral.address))
    const ltvLabel = ltv ? `${formatNumber(ltvToPercent(ltv.borrowLTV))}%` : '-'
    const product = getVaultProductName(pair.collateral.address) || getVaultProductName(pair.borrow.address)
    return {
      label: `${product || pair.collateral.asset.symbol}/${pair.borrow.asset.symbol} · ${ltvLabel}`,
      value: targetPairKey(pair),
    }
  }),
)

watch(selectedPosition, (position) => {
  selectedPositionId.value = position?.id ?? ''
  selectedPair.value = []
  clearSimulationError()
}, { immediate: true })

watch(compatiblePairs, (pairs) => {
  if (!pairs.length) {
    selectedPair.value = []
    return
  }
  if (!selectedPair.value[0] || !pairs.some(pair => targetPairKey(pair) === selectedPair.value[0])) {
    selectedPair.value = [targetPairKey(pairs[0])]
  }
}, { immediate: true })

watch(selectedPair, (value) => {
  if (value.length > 1) selectedPair.value = [value[value.length - 1]]
})

const formatAssetAmount = (amount: bigint, asset: { decimals: number, symbol: string }) =>
  `${formatSmartAmount(formatUnits(amount, asset.decimals))} ${asset.symbol}`

const buildPlan = async () => {
  const source = selectedPosition.value
  const target = selectedTargetPair.value
  if (!owner.value || !chainId.value || !source || !target) throw new Error('Migration inputs are incomplete')

  const eulerAccount = await getNewSubAccount(owner.value, target.borrow.address) as Address
  const eulerTarget = {
    eulerAccount,
    borrowVault: target.borrow.address as Address,
    collateralVault: target.collateral.address as Address,
    borrowAmount: targetBorrowAmount.value,
    minCollateralAssets: source.collateral.amount,
  }
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 60)
  const authorizationRequest = await getMigrationAuthorization({
    direction: 'external-to-euler',
    connectorId: MORPHO_CONNECTOR_ID,
    chainId: chainId.value,
    owner: owner.value,
    positionRef: source.ref,
    target: eulerTarget,
    deadline,
  })
  const authorization = authorizationRequest
    ? await signMigrationAuthorization(authorizationRequest)
    : undefined

  // The SDK Morpho connector sequences the in-batch insolvency window:
  // enable Euler risk checks, borrow on Euler, use Swapper multicall to repay
  // Morpho by shares, withdraw Morpho collateral, deposit into Euler, then let
  // EVC's deferred account check validate the final Euler position. Any revert
  // in the swapper multicall reverts the whole EVC batch.
  return planCrossProtocolMigration({
    direction: 'external-to-euler',
    connectorId: MORPHO_CONNECTOR_ID,
    chainId: chainId.value,
    owner: owner.value,
    positionRef: source.ref,
    target: eulerTarget,
    authorization,
    operationName: 'morphoToEulerMigration',
  })
}

const canSubmit = computed(() =>
  isConnected.value
  && !isSpyMode.value
  && !!selectedPosition.value
  && !!selectedTargetPair.value
  && !isPreparing.value
  && !isSubmitting.value
  && !simulationError.value,
)

const disabledReason = computed(() => {
  if (!isConnected.value) return 'Connect wallet to migrate'
  if (isSpyMode.value) return 'Migration requires the connected wallet'
  if (!selectedPosition.value) return 'No Morpho position selected'
  if (!selectedTargetPair.value) return 'No compatible Euler target'
  if (simulationError.value) return simulationError.value
  return undefined
})

const review = async () => {
  if (!canSubmit.value || !selectedPosition.value) return
  isPreparing.value = true
  clearSimulationError()
  try {
    plan.value = await buildPlan()
    preparedPlan.value = await prepareTransactionPlan(plan.value)
    const ok = await runPreparedSimulation(preparedPlan.value)
    if (!ok) return
    modal.open(OperationReviewModal, {
      props: {
        type: 'refinance',
        asset: selectedPosition.value.debt,
        amount: formatUnits(selectedPosition.value.debt.amount, selectedPosition.value.debt.decimals),
        prepared: preparedPlan.value,
        onConfirm: async () => {
          await submit()
        },
        submittingLabel: 'Migrating...',
      },
    })
  }
  catch (err) {
    logWarn('migrateMorpho/review', err)
    showError(err instanceof Error ? err.message : 'Failed to prepare migration')
  }
  finally {
    isPreparing.value = false
  }
}

const submit = async () => {
  if (!preparedPlan.value) return
  isSubmitting.value = true
  try {
    await executePreparedPlan(preparedPlan.value)
    modal.close()
    setTimeout(() => {
      router.replace({ path: '/portfolio', query: { network: route.query.network } })
    }, 400)
  }
  catch (err) {
    logWarn('migrateMorpho/submit', err)
    showError('Migration failed')
  }
  finally {
    isSubmitting.value = false
  }
}
</script>

<template>
  <section class="flex flex-col gap-16 min-h-[calc(100dvh-178px)] mobile:-mx-16">
    <div class="flex items-center justify-between px-16">
      <div class="flex items-center gap-8">
        <BackButton fallback="/borrow" />
        <h2 class="text-h2 text-content-primary">
          Migrate from elsewhere
        </h2>
      </div>
      <UiButton
        size="small"
        variant="secondary"
        rounded
        :loading="enableCrossProtocolRefinance && isPositionsLoading"
        :disabled="!enableCrossProtocolRefinance"
        @click="reloadPositions"
      >
        Refresh
      </UiButton>
    </div>

    <div class="mx-16 flex flex-col gap-16">
      <UiAlert
        v-if="!enableCrossProtocolRefinance"
        title="Cross-protocol refinancing"
        description="Enable cross-protocol refinancing in Settings to use this flow."
        variant="warning"
        size="compact"
      />

      <UiAlert
        v-if="enableCrossProtocolRefinance && positionsError"
        title="Morpho positions"
        :description="positionsError"
        variant="warning"
        size="compact"
      />

      <div
        v-if="enableCrossProtocolRefinance"
        class="grid gap-16 laptop:grid-cols-[minmax(0,1fr)_360px] laptop:items-start"
      >
        <div class="flex flex-col gap-12">
          <BaseLoadableContent :loading="isPositionsLoading || isEVaultUpdating || isEscrowUpdating">
            <template v-if="positions.length">
              <button
                v-for="position in positions"
                :key="position.id"
                type="button"
                class="w-full rounded-8 border p-16 bg-card text-left transition-colors"
                :class="selectedPosition?.id === position.id ? 'border-accent-500' : 'border-line-default hover:border-neutral-400'"
                @click="selectedPositionId = position.id"
              >
                <div class="flex items-start justify-between gap-12">
                  <div>
                    <div class="text-h5 text-content-primary">
                      Migrate from Morpho
                    </div>
                    <div class="text-p2 text-content-secondary mt-4">
                      {{ position.collateral.symbol }}/{{ position.debt.symbol }}
                    </div>
                  </div>
                  <div class="text-p3 text-content-tertiary">
                    {{ position.lltv !== null ? `${formatNumber(position.lltv)}% LLTV` : 'LLTV -' }}
                  </div>
                </div>
                <div class="grid grid-cols-2 gap-12 mt-16">
                  <div>
                    <div class="text-p3 text-content-tertiary">
                      Debt
                    </div>
                    <div class="text-p2 text-content-primary">
                      {{ formatAssetAmount(position.debt.amount, position.debt) }}
                    </div>
                  </div>
                  <div>
                    <div class="text-p3 text-content-tertiary">
                      Collateral
                    </div>
                    <div class="text-p2 text-content-primary">
                      {{ formatAssetAmount(position.collateral.amount, position.collateral) }}
                    </div>
                  </div>
                </div>
              </button>
            </template>
            <div
              v-else
              class="rounded-8 border border-line-default bg-card p-16 text-p2 text-content-secondary"
            >
              No eligible Morpho borrow positions found.
            </div>
          </BaseLoadableContent>
        </div>

        <VaultFormInfoBlock
          variant="card"
          class="w-full laptop:max-w-[360px]"
        >
          <SummaryRow label="Target">
            <UiSelect
              v-model="selectedPair"
              :options="targetOptions"
              placeholder="Euler pair"
              title="Euler pair"
              show-selected-options
              modal-input-placeholder="Search Euler pair"
            />
          </SummaryRow>
          <SummaryRow label="Debt">
            <span class="text-p2 text-right">
              {{ selectedPosition ? formatAssetAmount(targetBorrowAmount, selectedPosition.debt) : '-' }}
            </span>
          </SummaryRow>
          <SummaryRow label="Collateral">
            <span class="text-p2 text-right">
              {{ selectedPosition ? formatAssetAmount(selectedPosition.collateral.amount, selectedPosition.collateral) : '-' }}
            </span>
          </SummaryRow>
          <SummaryRow label="Debt value">
            <span class="text-p2 text-right">
              {{ selectedPosition?.debt.amountUsd !== null && selectedPosition?.debt.amountUsd !== undefined ? formatUsdValue(selectedPosition.debt.amountUsd) : '-' }}
            </span>
          </SummaryRow>
          <SummaryRow label="Collateral value">
            <span class="text-p2 text-right">
              {{ selectedPosition?.collateral.amountUsd !== null && selectedPosition?.collateral.amountUsd !== undefined ? formatUsdValue(selectedPosition.collateral.amountUsd) : '-' }}
            </span>
          </SummaryRow>
          <SummaryRow label="Borrow APY">
            <span class="text-p2 text-right">
              {{ selectedPosition?.borrowApy !== null && selectedPosition?.borrowApy !== undefined ? `${formatNumber(selectedPosition.borrowApy * 100)}%` : '-' }}
            </span>
          </SummaryRow>

          <UiAlert
            v-if="simulationError"
            class="mt-12"
            title="Error"
            :description="simulationError"
            variant="error"
            size="compact"
          />

          <UiButton
            class="mt-16 w-full"
            size="medium"
            variant="primary"
            rounded
            :disabled="!canSubmit"
            :loading="isPreparing || isSubmitting"
            :title="disabledReason"
            @click="review"
          >
            Review Migration
          </UiButton>
        </VaultFormInfoBlock>
      </div>
    </div>
  </section>
</template>
