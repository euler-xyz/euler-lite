<script setup lang="ts">
import { formatNumber } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import type { Vault, SecuritizeVault } from '~/entities/vault'
import type { LTVRampConfig } from '~/entities/vault/ltv'
import {
  getCollateralExposurePairs,
  getCurrentLiquidationLTV,
  isLiquidationLTVRamping,
} from '~/entities/vault'
import { useModal } from '~/components/ui/composables/useModal'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { logWarn } from '~/utils/errorHandling'
import { VaultRampDownModal } from '#components'

const modal = useModal()

const emits = defineEmits<{
  'vault-click': [address: string]
}>()
const { vault } = defineProps<{ vault: Vault }>()
const { get: registryGet } = useVaultRegistry()

const onCollateralClick = (address: string) => {
  emits('vault-click', address)
}

const onRampDownInfoIconClick = (event: MouseEvent, pair: LTVRampConfig) => {
  modal.open(VaultRampDownModal, {
    props: pair,
  })
}

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
            `Vault ${vault.address} references unresolved collateral ${addr}`,
          )
        }
      }
      return entry?.vault as Vault | SecuritizeVault | undefined
    },
  ),
)
</script>

<template>
  <div
    v-if="allCollateralPairs.length"
    class="bg-surface-secondary rounded-xl flex flex-col gap-24 p-24 shadow-card"
  >
    <div>
      <p class="text-h3 text-content-primary mb-12">
        Collateral exposure
      </p>
      <p class="text-content-secondary">
        Deposits in this vault can be borrowed.
        Please make sure you're comfortable accepting the collaterals
        listed in the table below before supplying.
      </p>
    </div>

    <div class="flex flex-col gap-12">
      <div
        v-for="pair in allCollateralPairs"
        :key="pair.collateral.address"
        class="bg-surface rounded-xl text-content-primary block no-underline cursor-pointer hover:bg-card-hover transition-colors shadow-sm"
        @click="onCollateralClick(pair.collateral.address)"
      >
        <div
          class="px-16 pt-16 pb-12 border-b border-line-subtle"
        >
          <VaultLabelsAndAssets
            :vault="pair.collateral"
            :assets="[pair.collateral.asset]"
          />
        </div>
        <div class="flex flex-col gap-12 px-16 pt-12 pb-16">
          <VaultOverviewLabelValue
            label="Max LTV"
            orientation="horizontal"
            :value="`${formatNumber(nanoToValue(pair.borrowLTV, 2), 2)}%`"
          />
          <VaultOverviewLabelValue
            orientation="horizontal"
          >
            <template #label>
              <span class="flex items-center gap-4">
                Liquidation LTV
                <SvgIcon
                  v-if="isLiquidationLTVRamping(pair)"
                  class="!w-20 !h-20 text-content-muted cursor-pointer hover:text-content-secondary"
                  name="info-circle"
                  @click.stop.prevent="onRampDownInfoIconClick($event, pair)"
                />
              </span>
            </template>
            <span class="flex items-center gap-4">
              <SvgIcon
                v-if="isLiquidationLTVRamping(pair)"
                name="arrow-top-right"
                class="!w-14 !h-14 text-warning-500 shrink-0 rotate-180 cursor-pointer"
                title="Liquidation LTV ramping down"
                @click.stop.prevent="onRampDownInfoIconClick($event, pair)"
              />
              {{ `${formatNumber(nanoToValue(getCurrentLiquidationLTV(pair), 2), 2)}%` }}
            </span>
          </VaultOverviewLabelValue>
        </div>
      </div>
    </div>
  </div>
</template>
