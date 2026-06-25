<script setup lang="ts">
import type { SecuritizeCollateralVault, EVaultCollateral, EVault } from '@eulerxyz/euler-v2-sdk'
import { getCollateralExposureGroups, getCollateralExposurePairs } from '~/utils/vault/collateral-exposure'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { logWarn } from '~/utils/errorHandling'
import { VaultRampDownModal } from '#components'
import { formatNumber } from '~/utils/string-utils'
import { formatExposureVaultCount } from '~/utils/vault/exposure-groups'

const emits = defineEmits<{
  'vault-click': [address: string]
}>()
const { vault, defaultOpen = true } = defineProps<{ vault: EVault, defaultOpen?: boolean }>()
const { get: registryGet } = useVaultRegistry()
const isExpanded = ref(false)
const COLLAPSED_GROUP_COUNT = 3

const onCollateralClick = (address: string) => {
  emits('vault-click', address)
}

const getRampDownModalData = (ltv: EVaultCollateral) => ({
  props: ltv,
})

// Module-scope dedupe so we warn at most once per (vault, missing-collateral)
// pair across recomputes and SFC instances. Mirrors the dedupe in
// composables/useMarketGroups.ts so a curator can spot the same gap reported
// by either site without one suppressing the other.
const warnedUnresolved = new Set<string>()

const allCollateralPairs = computed(() =>
  getCollateralExposurePairs(
    vault,
    (addr) => {
      const entry = registryGet(addr)
      if (!entry?.vault) {
        const key = `${vault.address.toLowerCase()}:${addr.toLowerCase()}`
        if (!warnedUnresolved.has(key)) {
          warnedUnresolved.add(key)
          logWarn(
            'vault-overview/missing-collateral',
            `EVault ${vault.address} references unresolved collateral ${addr}`,
          )
        }
      }
      return entry?.vault as EVault | SecuritizeCollateralVault | undefined
    },
  ),
)

const collateralGroups = computed(() => getCollateralExposureGroups(allCollateralPairs.value))
const visibleCollateralGroups = computed(() =>
  isExpanded.value ? collateralGroups.value : collateralGroups.value.slice(0, COLLAPSED_GROUP_COUNT),
)
const hiddenGroupCount = computed(() =>
  Math.max(0, collateralGroups.value.length - visibleCollateralGroups.value.length),
)
const toggleExpanded = () => {
  isExpanded.value = !isExpanded.value
}
</script>

<template>
  <VaultOverviewAccordionSection
    v-if="collateralGroups.length"
    title="Collateral exposure"
    :default-open="defaultOpen"
    content-class="flex flex-col gap-24"
  >
    <div>
      <p class="text-content-secondary">
        Deposits in this vault can be borrowed.
        Review the backing assets and underlying collateral vaults below before supplying.
      </p>
    </div>

    <div class="flex flex-col gap-12">
      <div
        v-for="group in visibleCollateralGroups"
        :key="group.asset.address"
        class="overflow-hidden rounded-12 border border-line-subtle bg-surface"
      >
        <div class="flex items-center justify-between gap-12 border-b border-line-subtle px-16 py-12">
          <div class="flex min-w-0 items-center gap-10">
            <AssetAvatar
              :asset="group.asset"
              size="36"
            />
            <div class="min-w-0">
              <p class="truncate text-p2 text-content-primary">
                {{ group.asset.symbol }}
              </p>
              <p class="text-p4 text-content-tertiary">
                {{ formatExposureVaultCount(group.vaultCount) }}
              </p>
            </div>
          </div>
        </div>

        <div class="divide-y divide-line-subtle">
          <div
            v-for="pair in group.items"
            :key="pair.collateral.address"
            class="cursor-pointer px-16 py-12 transition-colors hover:bg-card-hover"
            @click="onCollateralClick(pair.collateral.address)"
          >
            <VaultLabelsAndAssets
              :vault="pair.collateral"
              :assets="[pair.collateral.asset]"
            />
            <div class="mt-12 grid grid-cols-1 gap-12 sm:grid-cols-2">
              <VaultOverviewLabelValue
                label="Max LTV"
                orientation="horizontal"
                :value="`${formatNumber(ltvToPercent(pair.ltv.borrowLTV), 2)}%`"
              />
              <VaultOverviewLabelValue
                orientation="horizontal"
              >
                <template #label>
                  <span class="flex items-center gap-4">
                    Liquidation LTV
                    <UiModalPreviewTrigger
                      v-if="pair.ltv.isLiquidationLTVRamping"
                      :component="VaultRampDownModal"
                      :modal-data="() => getRampDownModalData(pair.ltv)"
                      aria-label="Show liquidation LTV ramp-down details"
                    >
                      <SvgIcon
                        class="!w-20 !h-20 text-content-muted cursor-pointer hover:text-content-secondary"
                        name="info-circle"
                      />
                    </UiModalPreviewTrigger>
                  </span>
                </template>
                <span class="flex items-center gap-4">
                  <UiModalPreviewTrigger
                    v-if="pair.ltv.isLiquidationLTVRamping"
                    :component="VaultRampDownModal"
                    :modal-data="() => getRampDownModalData(pair.ltv)"
                    aria-label="Show liquidation LTV ramp-down details"
                  >
                    <SvgIcon
                      name="arrow-top-right"
                      class="!w-14 !h-14 text-warning-500 shrink-0 rotate-180 cursor-pointer"
                    />
                  </UiModalPreviewTrigger>
                  {{ `${formatNumber(ltvToPercent(pair.ltv.currentLiquidationLTV), 2)}%` }}
                </span>
              </VaultOverviewLabelValue>
            </div>
          </div>
        </div>
      </div>

      <button
        v-if="collateralGroups.length > COLLAPSED_GROUP_COUNT"
        type="button"
        class="self-center text-p4 font-medium text-content-accent transition-colors hover:text-accent-600"
        @click="toggleExpanded"
      >
        {{ isExpanded ? 'Show less' : `Show more (${hiddenGroupCount})` }}
      </button>
    </div>
  </VaultOverviewAccordionSection>
</template>
