<script setup lang="ts">
import type {
  SecuritizeCollateralVault,
  EVault,
  OracleRouteStep,
} from '@eulerxyz/euler-v2-sdk'
import { getRouterIndexStatus, OracleAdapterCheckOutcome, OracleAdapterCheckSeverity } from '~/entities/oracle'
import { getExplorerLink } from '~/utils/block-explorer'
import { formatNumber } from '~/utils/string-utils'
import { getOracleRouteStepKey, useOracleAdapterPrices } from '~/composables/useOracleAdapterPrices'
import { isOracleAdapterRouteStep } from '~/utils/oracle-route-steps'
import { buildOracleAdapterViews, collectOracleRouteSteps, type OracleAdapterView } from '~/utils/oracle-adapter-views'
import { OracleAdapterChecksModal } from '#components'

const props = defineProps<{
  vault?: EVault
  vaults?: EVault[]
  collateralVaults?: (EVault | SecuritizeCollateralVault)[]
  defaultOpen?: boolean
}>()
const { oracleAdapters, loadOracleAdapter } = useEulerLabels()
const { chainId } = useEulerAddresses()
const { buildKnownSymbols, resolveSymbol: resolveTokenSymbol, shortenAddress } = useTokenSymbolResolver()
const { indexedRouters, indexedRoutersChainId, loadIndexedRouters } = useEulerOracleRouters()

const sourceVaults = computed(() => {
  if (props.vaults?.length) {
    return props.vaults
  }

  if (props.vault) {
    return [props.vault]
  }

  return []
})

const routeSteps = computed(() => collectOracleRouteSteps(sourceVaults.value, props.collateralVaults ?? []))

const knownSymbols = computed(() => {
  const map = buildKnownSymbols()

  sourceVaults.value.forEach((vault) => {
    map.set(vault.asset.address.toLowerCase(), vault.asset.symbol)
    if (vault.unitOfAccount) {
      map.set(vault.unitOfAccount.address.toLowerCase(), vault.unitOfAccount.symbol)
    }
  })

  props.collateralVaults?.forEach((vault) => {
    map.set(vault.address.toLowerCase(), vault.asset.symbol)
    map.set(vault.asset.address.toLowerCase(), vault.asset.symbol)
  })

  return map
})

const adapterViews = computed(() => buildOracleAdapterViews(routeSteps.value, oracleAdapters))

watch(
  () => routeSteps.value,
  async (stepList) => {
    if (!chainId.value || !stepList.length) return

    await Promise.all(
      stepList
        .filter(isOracleAdapterRouteStep)
        .map(step => loadOracleAdapter(chainId.value, step.oracle)),
    )
  },
  { immediate: true },
)

watch(
  chainId,
  (id) => {
    if (id) loadIndexedRouters(id)
  },
  { immediate: true },
)

// Flag whether Data V3 has indexed the vault's EulerRouter. This is an index
// membership signal, not an independent security verdict. Null while the
// active chain is loading or the router index is unavailable.
const routerIndexStatus = computed(() => {
  if (indexedRoutersChainId.value !== chainId.value) return null
  const routerAddresses = sourceVaults.value.map(vault => vault.oracle?.oracle)
  return getRouterIndexStatus(routerAddresses, indexedRouters.value)
})

const resolveSymbol = (address: string) => resolveTokenSymbol(address, knownSymbols.value)

const { copyToClipboard } = useClipboardCopy()

const onCopyClick = (address: string) => {
  copyToClipboard(address).catch(() => {})
}

const getExplorerAddressLink = (address: string) => getExplorerLink(address, chainId.value, true)

const { prices: adapterPrices, isLoading: isPriceLoading } = useOracleAdapterPrices(
  routeSteps,
  sourceVaults,
  computed(() => props.collateralVaults ?? []),
)

type RouteStepKeyInput = Pick<OracleRouteStep, 'kind' | 'oracle' | 'base' | 'quote'>

const isAdapterPriceFailed = (adapter: RouteStepKeyInput) => {
  const key = getOracleRouteStepKey(adapter)
  const info = adapterPrices.value.get(key)
  return !info?.success
}

const formatAdapterPrice = (adapter: RouteStepKeyInput & { invertPrice: boolean }) => {
  const key = getOracleRouteStepKey(adapter)
  const info = adapterPrices.value.get(key)
  if (!info?.success) return '-'
  const rate = adapter.invertPrice && info.rate > 0 ? 1 / info.rate : info.rate
  return formatNumber(rate, 4)
}

const getChecksModalData = (adapter: OracleAdapterView) => ({
  props: {
    modalTitle: 'Checks',
    checks: adapter.checks ?? [],
    policyVersion: adapter.policyVersion,
    lastCheckedAt: adapter.lastCheckedAt,
  },
})
</script>

<template>
  <VaultOverviewAccordionSection
    title="Oracles"
    :default-open="props.defaultOpen ?? true"
    content-class="flex flex-col gap-24"
  >
    <template #actions>
      <UiHoverPreviewTooltip
        v-if="routerIndexStatus === 'not-indexed'"
        title="Oracle router not indexed"
        text="Data V3 does not currently include this price oracle in its indexed Euler router set. Verify the router and oracle configuration independently."
        placement="top-start"
      >
        <span
          class="inline-flex items-center gap-4 rounded-8 px-8 py-2 bg-error-100 text-error-500 text-p5"
          data-id="data-point"
          data-field="oracle-router-index-status"
          data-value="not-indexed"
        >
          <SvgIcon
            name="warning"
            class="!w-12 !h-12"
          />
          Router not indexed
        </span>
      </UiHoverPreviewTooltip>
    </template>
    <div
      v-if="!adapterViews.length"
      class="text-p3 text-content-tertiary"
    >
      No oracle adapters found
    </div>
    <div
      v-else
      class="flex flex-col items-start gap-16"
    >
      <div
        v-for="adapter in adapterViews"
        :key="getOracleRouteStepKey(adapter)"
        class="w-full rounded-xl bg-surface p-16 flex flex-col gap-12 border border-line-subtle"
      >
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 sm:gap-8">
          <div class="p2 text-content-primary">
            <template v-if="adapter.label">
              {{ adapter.label.primary }}
              <span
                v-if="adapter.label.suffix"
                class="text-content-tertiary ml-2"
              >{{ adapter.label.suffix }}</span>
            </template>
            <template v-else>
              {{ resolveSymbol(adapter.base) }}/{{ resolveSymbol(adapter.quote) }}
            </template>
          </div>
          <div class="flex items-center gap-8 flex-shrink-0">
            <NuxtLink
              :to="getExplorerAddressLink(adapter.oracle)"
              class="text-accent-600 underline cursor-pointer hover:text-accent-500"
              target="_blank"
            >
              {{ shortenAddress(adapter.oracle) }}
            </NuxtLink>
            <button
              :class="$style.copyBtn"
              class="text-content-muted"
              aria-label="Copy address"
              @click="onCopyClick(adapter.oracle)"
            >
              <SvgIcon
                class="!w-18 !h-18"
                name="copy"
              />
            </button>
          </div>
        </div>
        <div class="grid grid-cols-2 md:grid-cols-5 gap-12 text-p3">
          <div class="flex flex-col gap-4">
            <span class="text-content-tertiary">Provider</span>
            <div class="flex items-center gap-8">
              <BaseAvatar
                v-if="adapter.logo"
                :src="adapter.logo"
                :label="adapter.name"
                class="icon--20"
              />
              <SvgIcon
                v-else
                name="question-circle"
                class="!w-20 !h-20 text-content-tertiary"
              />
              <span class="text-content-primary">{{ adapter.provider || 'Unknown' }}</span>
            </div>
          </div>
          <div class="flex flex-col gap-4">
            <span class="text-content-tertiary">Methodology</span>
            <span class="text-content-primary">{{ adapter.methodology || 'Unknown' }}</span>
          </div>
          <UiModalPreviewTrigger
            v-if="adapter.checks?.length"
            class="flex flex-col gap-4 items-start cursor-default text-left"
            :component="OracleAdapterChecksModal"
            :modal-data="getChecksModalData(adapter)"
            aria-label="Show oracle adapter checks"
            placement="top-start"
            :clickable="false"
            popover-width="wide"
          >
            <span class="text-content-tertiary">Checks</span>
            <span class="flex items-center gap-6 cursor-default">
              <span
                class="inline-block w-8 h-8 rounded-full flex-shrink-0"
                :class="{
                  'bg-success-500': adapter.checksStatus === 'positive',
                  'bg-warning-500': adapter.checksStatus === 'warning',
                  'bg-error-500': adapter.checksStatus === 'negative',
                  'bg-content-muted': adapter.checksStatus === null,
                }"
              />
              <span class="text-content-primary">
                <template v-if="adapter.checksStatus === 'positive'">
                  {{ adapter.checks.filter(check => check.outcome === OracleAdapterCheckOutcome.Pass).length }} passed
                </template>
                <template v-else-if="adapter.failedChecks.length">
                  {{ adapter.failedChecks.length }} failed
                </template>
                <template v-else-if="adapter.unknownChecks.length">
                  {{ adapter.unknownChecks.length }} unknown
                </template>
                <template v-else>
                  No health verdict
                </template>
              </span>
            </span>
          </UiModalPreviewTrigger>
          <div
            v-else
            class="flex flex-col gap-4"
          >
            <span class="text-content-tertiary">Checks</span>
            <span
              v-if="adapter.isCustomAdapter"
              class="text-content-secondary"
            >Custom — set by risk manager</span>
            <span
              v-else
              class="text-content-secondary"
            >N/A</span>
          </div>
          <div class="flex flex-col gap-4">
            <span class="text-content-tertiary">Route</span>
            <span class="text-content-primary">
              {{ resolveSymbol(adapter.base) }}/{{ resolveSymbol(adapter.quote) }}
            </span>
          </div>
          <div class="flex flex-col gap-4">
            <span class="text-content-tertiary">Price</span>
            <span
              v-if="isPriceLoading"
              class="text-content-secondary animate-pulse"
            >...</span>
            <span
              v-else-if="isAdapterPriceFailed(adapter)"
              class="flex items-center text-warning-500"
            >
              <SvgIcon
                name="warning"
                class="mr-2 !w-20 !h-20"
              />
              Unknown
            </span>
            <span
              v-else
              class="text-content-primary"
            >{{ formatAdapterPrice(adapter) }}</span>
          </div>
        </div>
        <div
          v-if="adapter.assessmentPairMatchesRoute === false"
          class="flex items-start gap-8 border-t border-line-subtle pt-12 text-p3"
        >
          <SvgIcon
            name="warning"
            class="!w-16 !h-16 mt-1 flex-shrink-0 text-warning-500"
          />
          <span class="text-content-secondary">
            The assessed adapter pair differs from this configured route, so its health verdict is not applied here.
          </span>
        </div>
        <div
          v-if="adapter.failedChecks.length || adapter.unknownChecks.length"
          class="flex flex-col gap-6 border-t border-line-subtle pt-12 text-p3"
        >
          <div
            v-for="(check, i) in [...adapter.failedChecks, ...adapter.unknownChecks]"
            :key="`${check.id}-${i}`"
            class="flex items-start gap-8"
          >
            <SvgIcon
              name="warning"
              class="!w-16 !h-16 mt-1 flex-shrink-0"
              :class="{
                'text-error-500': check.outcome === OracleAdapterCheckOutcome.Fail && check.severity === OracleAdapterCheckSeverity.High,
                'text-warning-500': check.outcome !== OracleAdapterCheckOutcome.Fail || check.severity !== OracleAdapterCheckSeverity.High,
              }"
            />
            <div>
              <span class="text-content-primary font-medium">{{ check.id }}: </span>
              <span class="text-content-secondary">{{ check.message }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </VaultOverviewAccordionSection>
</template>

<style module lang="scss">
.copyBtn {
  cursor: pointer;
  outline: none;

  &:hover {
    color: var(--text-secondary);
  }

  &:active {
    color: var(--text-primary);
  }

  &:focus-visible {
    outline: 2px solid var(--color-accent-600);
    outline-offset: 2px;
    border-radius: 4px;
  }
}
</style>
