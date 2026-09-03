<script setup lang="ts">
import type {
  SecuritizeCollateralVault,
  EVault,
  OracleRouteStep,
} from '@eulerxyz/euler-v2-sdk'
import { formatOracleCheckTitle, getRouterRecognition, OracleAdapterCheckOutcome, OracleAdapterCheckSeverity } from '~/entities/oracle'
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
const {
  oracleAdapters,
  oracleAssessmentsAvailable,
  loadOracleAdapters,
} = useEulerLabels()
const { chainId } = useEulerAddresses()
const { buildKnownSymbols, resolveSymbol: resolveTokenSymbol, shortenAddress } = useTokenSymbolResolver()
const { recognizedRouters, recognizedRoutersChainId, loadRecognizedRouters } = useEulerOracleRouters()

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

const trustedRouteSteps = computed(() => oracleAssessmentsAvailable.value ? routeSteps.value : [])
const adapterViews = computed(() => buildOracleAdapterViews(trustedRouteSteps.value, oracleAdapters))

watch(
  () => routeSteps.value,
  async (stepList) => {
    if (!chainId.value) return

    const adapterAddresses = [...new Set(
      stepList
        .filter(isOracleAdapterRouteStep)
        .map(step => step.oracle),
    )]
    await loadOracleAdapters(chainId.value, adapterAddresses)
  },
  { immediate: true },
)

watch(
  chainId,
  (id) => {
    if (id) loadRecognizedRouters(id)
  },
  { immediate: true },
)

// LITE-236: flag whether the vault's price oracle (EulerRouter) was deployed by the
// recognized EulerRouterFactory (Data V3 only indexes factory deployments). Null
// while the set is still loading for the active chain or unavailable, so we never
// show a false "unrecognized" warning.
const routerRecognition = computed(() => {
  if (!oracleAssessmentsAvailable.value) return null
  if (recognizedRoutersChainId.value !== chainId.value) return null
  const routerAddresses = sourceVaults.value.map(vault => vault.oracle?.oracle)
  return getRouterRecognition(routerAddresses, recognizedRouters.value)
})

const resolveSymbol = (address: string) => resolveTokenSymbol(address, knownSymbols.value)

const { copyToClipboard } = useClipboardCopy()

const onCopyClick = (address: string) => {
  copyToClipboard(address).catch(() => {})
}

const getExplorerAddressLink = (address: string) => getExplorerLink(address, chainId.value, true)

const { prices: adapterPrices, isLoading: isPriceLoading } = useOracleAdapterPrices(
  trustedRouteSteps,
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

// One-line summary for the Checks cell. Recognized adapters count their health
// findings; adapters V3 assessed but could not identify say so, and adapters
// V3 has no row for are "Not assessed". Backend availability is section-wide.
const getChecksSummary = (adapter: OracleAdapterView): string => {
  if (adapter.assessmentState === 'unrecognized') return 'Unrecognized'
  if (adapter.assessmentState === 'unassessed') return adapter.isCustomAdapter ? 'Not assessed' : 'N/A'
  if (adapter.checksStatus === 'positive') return `${adapter.passedChecks} passed`
  const parts = [
    adapter.failedChecks.length ? `${adapter.failedChecks.length} failed` : '',
    adapter.unknownChecks.length ? `${adapter.unknownChecks.length} unknown` : '',
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'N/A'
}

const getChecksModalData = (adapter: OracleAdapterView) => ({
  props: {
    modalTitle: adapter.assessmentState === 'unrecognized' ? 'Identity checks' : 'Checks',
    checks: adapter.checks ?? [],
    lastCheckedAt: adapter.lastCheckedAt,
    note: adapter.assessmentState === 'unrecognized'
      ? 'This adapter could not be identified, so no health checks are reported for it.'
      : undefined,
    quoteContext: {
      baseSymbol: resolveSymbol(adapter.metaBase ?? adapter.base),
      quoteSymbol: resolveSymbol(adapter.metaQuote ?? adapter.quote),
    },
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
        v-if="oracleAssessmentsAvailable && routerRecognition === 'unrecognized'"
        title="Unrecognized oracle router"
        text="The vault's price oracle was not deployed by the recognized EulerRouterFactory. Verify the oracle configuration before trusting its prices."
        placement="top-start"
      >
        <span
          class="inline-flex items-center gap-4 rounded-8 px-8 py-2 bg-error-100 text-error-500 text-p5"
          data-id="data-point"
          data-field="oracle-router-recognition"
          data-value="unrecognized"
        >
          <SvgIcon
            name="warning"
            class="!w-12 !h-12"
          />
          Unrecognized router
        </span>
      </UiHoverPreviewTooltip>
    </template>
    <div
      v-if="!oracleAssessmentsAvailable"
      class="text-p3 text-content-tertiary"
    >
      Oracle information not available
    </div>
    <div
      v-else-if="!adapterViews.length"
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
          <div class="p2 min-w-0 break-words text-content-primary">
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
        <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.35fr)_minmax(0,0.8fr)_minmax(0,1.2fr)_max-content] gap-8 text-p3">
          <div class="flex min-w-0 flex-col gap-4">
            <span class="text-content-tertiary">Provider</span>
            <div class="flex min-w-0 items-center gap-8">
              <BaseAvatar
                v-if="adapter.logo"
                :src="adapter.logo"
                :label="adapter.name"
                class="icon--20 flex-shrink-0"
              />
              <SvgIcon
                v-else
                name="question-circle"
                class="!w-20 !h-20 flex-shrink-0 text-content-tertiary"
              />
              <span class="min-w-0 break-words text-content-primary">{{ adapter.provider || 'Unknown' }}</span>
            </div>
          </div>
          <div class="flex min-w-0 flex-col gap-4">
            <span class="text-content-tertiary">Methodology</span>
            <span class="min-w-0 break-words text-content-primary">{{ adapter.methodology || 'Unknown' }}</span>
          </div>
          <UiModalPreviewTrigger
            v-if="adapter.checks?.length"
            class="flex min-w-0 flex-col gap-4 items-start cursor-default text-left"
            :component="OracleAdapterChecksModal"
            :modal-data="getChecksModalData(adapter)"
            aria-label="Show oracle adapter checks"
            placement="top-start"
            :clickable="false"
            popover-width="wide"
          >
            <span class="text-content-tertiary">Checks</span>
            <span class="flex min-w-0 items-center gap-6 cursor-default">
              <span
                class="inline-block w-8 h-8 rounded-full flex-shrink-0"
                :class="{
                  'bg-success-500': adapter.checksStatus === 'positive',
                  'bg-warning-500': adapter.checksStatus === 'warning',
                  'bg-error-500': adapter.checksStatus === 'negative',
                  'bg-content-muted': adapter.checksStatus === null,
                }"
              />
              <span class="min-w-0 break-words text-content-primary">{{ getChecksSummary(adapter) }}</span>
            </span>
          </UiModalPreviewTrigger>
          <div
            v-else
            class="flex min-w-0 flex-col gap-4"
          >
            <span class="text-content-tertiary">Checks</span>
            <span class="min-w-0 break-words text-content-secondary">{{ getChecksSummary(adapter) }}</span>
          </div>
          <div class="flex min-w-0 flex-col gap-4">
            <span class="text-content-tertiary">Route</span>
            <span class="min-w-0 break-words text-content-primary">
              {{ resolveSymbol(adapter.base) }}/{{ resolveSymbol(adapter.quote) }}
            </span>
          </div>
          <div class="flex min-w-0 flex-col gap-4">
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
              class="min-w-0 break-words text-content-primary"
            >{{ formatAdapterPrice(adapter) }}</span>
          </div>
        </div>
        <div
          v-if="adapter.reason"
          class="flex items-start gap-8 border-t border-line-subtle pt-12 text-p3"
        >
          <SvgIcon
            name="info-circle"
            class="!w-16 !h-16 mt-1 flex-shrink-0 text-content-tertiary"
          />
          <span class="text-content-secondary">{{ adapter.reason }}</span>
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
              <span class="text-content-primary font-medium">{{ formatOracleCheckTitle(check.id) }}: </span>
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
