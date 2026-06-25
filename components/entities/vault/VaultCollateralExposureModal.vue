<script setup lang="ts">
import type { SecuritizeCollateralVault, EVault } from '@eulerxyz/euler-v2-sdk'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { formatNumber } from '~/utils/string-utils'
import { getCollateralExposureGroups, getCollateralExposurePairs } from '~/utils/vault/collateral-exposure'

const emits = defineEmits(['close'])
const router = useRouter()
const route = useRoute()
const { vault } = defineProps<{ vault: EVault }>()
const { get: registryGet } = useVaultRegistry()

const allCollateralPairs = computed(() =>
  getCollateralExposurePairs(
    vault,
    addr => registryGet(addr)?.vault as EVault | SecuritizeCollateralVault | undefined,
  ),
)

const collateralGroups = computed(() => getCollateralExposureGroups(allCollateralPairs.value))
const collateralPairs = computed(() => collateralGroups.value.flatMap(group => group.items))

const formatTimeRemaining = (seconds: bigint): string => {
  const days = Number(seconds) / 86400
  if (days >= 1) {
    return `${Math.ceil(days)} day${Math.ceil(days) > 1 ? 's' : ''}`
  }
  const hours = Number(seconds) / 3600
  if (hours >= 1) {
    return `${Math.ceil(hours)} hour${Math.ceil(hours) > 1 ? 's' : ''}`
  }
  const minutes = Number(seconds) / 60
  return `${Math.ceil(minutes)} minute${Math.ceil(minutes) > 1 ? 's' : ''}`
}

const onCollateralClick = (address: string) => {
  emits('close')
  router.push({ path: `/borrow/${address}/${vault.address}`, query: { network: route.query.network } })
}
</script>

<template>
  <BaseModalWrapper
    title="Collateral exposure"
    @close="$emit('close')"
  >
    <div
      v-if="collateralGroups.length > 0"
      class="flex flex-col gap-12"
    >
      <p class="text-p3 text-content-secondary mb-4">
        Deposits in this vault can be borrowed.
        Make sure you're comfortable accepting the backing assets and collateral vaults listed below before supplying.
      </p>
      <div
        v-for="pair in collateralPairs"
        :key="pair.collateral.address"
        class="cursor-pointer rounded-12 border border-line-subtle bg-surface p-16 text-content-primary transition-colors hover:bg-card-hover"
        @click="onCollateralClick(pair.collateral.address)"
      >
        <div class="min-w-0">
          <VaultLabelsAndAssets
            class="min-w-0"
            :vault="pair.collateral"
            :assets="[pair.collateral.asset]"
          />
          <VaultTypeBadges
            class="mt-8 w-full justify-end"
            :vault="pair.collateral"
            summary-only
            @click.stop.prevent
          />
        </div>
        <div class="flex flex-col gap-12 pt-12">
          <VaultOverviewLabelValue
            label="Max LTV"
            orientation="horizontal"
            :value="`${formatNumber(ltvToPercent(pair.ltv.borrowLTV), 2)}%`"
          />
          <VaultOverviewLabelValue orientation="horizontal">
            <template #label>
              <span class="flex items-center gap-4">
                Liquidation LTV
                <span
                  v-if="pair.ltv.isLiquidationLTVRamping"
                  @click.stop.prevent
                >
                  <UiFootnote
                    title="LTV Ramping"
                    :text="`The Liquidation LTV for this collateral is currently being reduced. Target Liquidation LTV: ${formatNumber(ltvToPercent(pair.ltv.liquidationLTV), 2)}%. Time remaining: ${formatTimeRemaining(pair.ltv.rampTimeRemaining)}.`"
                    class="[--ui-footnote-icon-color:var(--c-content-tertiary)]"
                  />
                </span>
              </span>
            </template>
            <div class="flex items-center gap-4">
              <SvgIcon
                v-if="pair.ltv.isLiquidationLTVRamping"
                name="arrow-top-right"
                class="!w-14 !h-14 text-warning-500 shrink-0 rotate-180"
                title="Liquidation LTV ramping down"
              />
              <span>{{ `${formatNumber(ltvToPercent(pair.ltv.currentLiquidationLTV), 2)}%` }}</span>
            </div>
          </VaultOverviewLabelValue>
        </div>
      </div>
    </div>
    <div
      v-else
      class="py-24 text-center text-content-secondary"
    >
      No active collateral for this vault.
    </div>
  </BaseModalWrapper>
</template>
