<script setup lang="ts">
import { isExternalMigrationDustPosition } from '~/composables/useExternalMigrationPositions'
import { formatNumber, formatCompactUsdValue } from '~/utils/string-utils'
import { POLL_INTERVAL_60S_MS } from '~/entities/tuning-constants'

defineOptions({
  name: 'PortfolioPage',
})

const route = useRoute()
const router = useRouter()
const {
  borrowPositions,
  depositPositions,
  totalSuppliedValueInfo,
  totalBorrowedValueInfo,
  netAssetMarketValueInfo,
  portfolioRoe,
  portfolioNetApy,
  isPositionsLoaded,
  isShowAllPositions,
  refreshAllPositions,
} = useEulerAccount()
const { refresh: refreshFreshAccount } = useFreshAccount()
const { rewards } = useSdkRewards()
const { locks, refreshLocks } = useREULLocks()
const { isConnected, address, spyAddress, effectiveAddress, isSpyMode } = useEffectiveAddress()
const { isLoaded: isBalancesLoaded, updateBalances } = useWallets()
const { eulerLensAddresses } = useEulerAddresses()
const { portfolioRefreshCounter } = usePortfolioRefresh()
const showAllLabelEntries = useShowAllLabelEntries()
const {
  positions: migrationPositions,
  isLoading: isMigrationLoading,
  error: migrationError,
  hasLoaded: hasMigrationLoaded,
} = useExternalMigrationPositions()

const interval: Ref<NodeJS.Timeout | null> = ref(null)
const hasShownMigrationTab = ref(false)
type PortfolioTab = {
  label: string
  value: string
  badge?: number | null
  icon?: string
  badgeLoading?: boolean
  badgeVariant?: 'neutral' | 'accent'
  ariaLabel?: string
}

// Drive the tab selection directly off the route so there is no stored state
// to drift out of sync with the URL while PortfolioPage is kept-alive.
// Initialising a separate ref and syncing it via `router.replace` in
// `onActivated` queued a second nested navigation while the first inner
// `<NuxtPage>` swap was still in flight. On prod (where child routes are
// async-imported chunks) that produced a timing race with the `out-in` page
// transition, leaving the inner slot empty.
const tabsModel = computed<string>({
  get: () => route.name as string,
  set: (value) => {
    if (route.name !== value) {
      router.replace({ name: value, query: route.query })
    }
  },
})

const hasActiveMigrationSession = computed(() => isConnected.value || isSpyMode.value)
const visibleMigrationPositions = computed(() =>
  migrationPositions.value.filter(position => !isExternalMigrationDustPosition(position)),
)
const visibleMigrationPositionCount = computed(() => visibleMigrationPositions.value.length)
const hasMigrationTabSignal = computed(() =>
  hasActiveMigrationSession.value && (visibleMigrationPositionCount.value > 0 || isMigrationLoading.value),
)
watch(hasMigrationTabSignal, (value) => {
  if (value) hasShownMigrationTab.value = true
}, { immediate: true })
watch(hasActiveMigrationSession, (value) => {
  if (!value) hasShownMigrationTab.value = false
})

const showMigrationTab = computed(() =>
  hasActiveMigrationSession.value
  && (
    visibleMigrationPositionCount.value > 0
    || isMigrationLoading.value
    || (!!migrationError.value && hasShownMigrationTab.value)
  ),
)

const tabs = computed(() => {
  const items: PortfolioTab[] = [
    {
      label: 'Positions',
      value: 'portfolio',
      badge: borrowPositions.value.length || null,
    },
    {
      label: 'Deposits',
      value: 'portfolio-saving',
      badge: depositPositions.value.length || null,
    },
    {
      label: 'Rewards',
      value: 'portfolio-rewards',
      badge: rewards.value.length + locks.value.length || null,
    },
  ]

  if (showMigrationTab.value) {
    items.push({
      label: 'Migrate',
      value: 'portfolio-migrate',
      badge: visibleMigrationPositionCount.value || null,
      badgeVariant: 'accent',
      ariaLabel: isMigrationLoading.value
        ? 'Migrate, scanning positions available'
        : `Migrate, ${visibleMigrationPositionCount.value} positions available`,
    })
  }

  return items
})

watch([() => route.name, showMigrationTab, hasMigrationLoaded, isMigrationLoading], () => {
  if (
    route.name === 'portfolio-migrate'
    && !showMigrationTab.value
    && hasMigrationLoaded.value
    && !isMigrationLoading.value
  ) {
    router.replace({ name: 'portfolio', query: route.query })
  }
})

const portfolioNetApyDisplay = computed(() =>
  Number.isFinite(portfolioNetApy.value) ? `${formatNumber(portfolioNetApy.value)}%` : '-',
)
const portfolioRoeDisplay = computed(() =>
  Number.isFinite(portfolioRoe.value) ? `${formatNumber(portfolioRoe.value)}%` : '-',
)
const totalSuppliedDisplay = computed(() => {
  const { total, hasMissingPrices } = totalSuppliedValueInfo.value
  if (total === 0 && hasMissingPrices) return '—'
  return formatCompactUsdValue(total)
})
const totalBorrowedDisplay = computed(() => {
  const { total, hasMissingPrices } = totalBorrowedValueInfo.value
  if (total === 0 && hasMissingPrices) return '—'
  return formatCompactUsdValue(total)
})
const netAssetValueInfo = computed(() => {
  return netAssetMarketValueInfo.value
})
const netAssetValueDisplay = computed(() => {
  const { total, hasMissingPrices } = netAssetValueInfo.value
  if (total === 0 && hasMissingPrices) return '—'
  return formatCompactUsdValue(total)
})

const updatePositions = async (
  options: { portfolioSource?: 'fast' | 'fresh', preemptPortfolio?: boolean } = {},
) => {
  const targetAddress = effectiveAddress.value
  if (!targetAddress) return
  // Refresh the rich portfolio snapshot (drives the UI on this page) and the
  // plan-time Account snapshot in parallel. The two write into disjoint stores,
  // so the calls are independent.
  refreshFreshAccount()
  await refreshAllPositions(eulerLensAddresses.value, targetAddress, {
    source: options.portfolioSource,
    preempt: options.preemptPortfolio,
  })
}

onActivated(async () => {
  await updateBalances()
  updatePositions()
  if (interval.value) clearInterval(interval.value)
  interval.value = setInterval(updatePositions, POLL_INTERVAL_60S_MS)
})
onDeactivated(() => {
  if (interval.value) {
    clearInterval(interval.value)
    interval.value = null
  }
})

watch(portfolioRefreshCounter, () => {
  updatePositions({ portfolioSource: 'fresh', preemptPortfolio: true })
  void refreshLocks(false)
})
watch(showAllLabelEntries, (showAll) => {
  isShowAllPositions.value = showAll
}, { immediate: true })
</script>

<template>
  <section class="flex flex-col gap-16 min-h-[calc(100dvh-178px)] mobile:-mx-16">
    <div class="flex items-center justify-between px-16">
      <h2 class="text-h2 text-content-primary">
        Your Portfolio
      </h2>
      <div class="flex items-center gap-8">
        <span class="text-h6 text-content-secondary">Show all</span>
        <UiHoverPreviewTooltip
          title="Show all"
          text="When enabled, shows positions and deposits in unverified vaults. Interacting with unverified vaults may pose security risks, as such vaults could potentially be used for phishing attempts. Ensure you trust the source before continuing."
          placement="top-end"
        />
        <UiSwitch
          v-model="isShowAllPositions"
        />
      </div>
    </div>

    <PortfolioShowAllHint />

    <PortfolioRampingBanner />

    <div class="flex flex-col gap-16 mx-16 laptop:flex-row laptop:items-stretch">
      <div class="flex flex-col gap-16 p-16 rounded-12 border border-line-default bg-card shadow-card laptop:flex-1">
        <div class="text-h4 text-content-primary">
          Portfolio performance
        </div>
        <div class="flex justify-between items-center">
          <div class="flex items-center gap-4 text-p2 text-content-secondary">
            Net APY
            <UiHoverPreviewTooltip
              title="Portfolio Net APY"
              text="Net annual percentage yield across all positions. Calculated as total net yield (supply income minus borrow costs) divided by total supplied value."
              placement="bottom-start"
              icon-class="text-content-tertiary"
            />
          </div>
          <BaseLoadableContent :loading="isConnected && (!isPositionsLoaded || !isBalancesLoaded)">
            <div
              class="text-h5"
              :class="[portfolioNetApy >= 0 ? 'text-accent-600' : 'text-error-500']"
              data-id="data-point"
              :data-key="spyAddress || address"
              data-field="portfolio-net-apy"
              :data-value="Number.isFinite(portfolioNetApy) ? portfolioNetApy : '-'"
            >
              {{ portfolioNetApyDisplay }}
            </div>
          </BaseLoadableContent>
        </div>
        <div class="flex justify-between items-center">
          <div class="flex items-center gap-4 text-p2 text-content-secondary">
            ROE
            <UiHoverPreviewTooltip
              title="Portfolio ROE"
              text="Account-level return on equity. Calculated as total net yield divided by total equity, where equity is supplied value minus borrowed value."
              placement="bottom-start"
              icon-class="text-content-tertiary"
            />
          </div>
          <BaseLoadableContent :loading="isConnected && (!isPositionsLoaded || !isBalancesLoaded)">
            <div
              class="text-h5"
              :class="[portfolioRoe >= 0 ? 'text-accent-600' : 'text-error-500']"
              data-id="data-point"
              :data-key="spyAddress || address"
              data-field="portfolio-roe"
              :data-value="Number.isFinite(portfolioRoe) ? portfolioRoe : '-'"
            >
              {{ portfolioRoeDisplay }}
            </div>
          </BaseLoadableContent>
        </div>
      </div>
      <div class="flex flex-col gap-16 p-16 rounded-12 border border-line-default bg-card shadow-card laptop:flex-1">
        <div class="text-h4 text-content-primary">
          Portfolio value
        </div>
        <div class="flex justify-between items-center">
          <div class="flex items-center gap-4 text-p2 text-content-secondary">
            Total supplied
            <UiHoverPreviewTooltip
              v-if="totalSuppliedValueInfo.hasMissingPrices"
              title="Incomplete pricing"
              text="Some supplied assets don't have price data available. The displayed value may be higher than shown."
              placement="bottom-end"
              icon-class="text-warning-500"
            />
          </div>
          <BaseLoadableContent :loading="isConnected && (!isPositionsLoaded || !isBalancesLoaded)">
            <div
              class="text-h5 text-content-primary"
              data-id="data-point"
              :data-key="spyAddress || address"
              data-field="portfolio-total-supplied"
              :data-value="totalSuppliedValueInfo.hasMissingPrices ? totalSuppliedDisplay : totalSuppliedValueInfo.total"
            >
              {{ totalSuppliedDisplay }}
            </div>
          </BaseLoadableContent>
        </div>
        <div class="flex justify-between items-center">
          <div class="flex items-center gap-4 text-p2 text-content-secondary">
            Total borrowed
            <UiHoverPreviewTooltip
              v-if="totalBorrowedValueInfo.hasMissingPrices"
              title="Incomplete pricing"
              text="Some borrowed assets don't have price data available. The displayed value may be higher than shown."
              placement="bottom-end"
              icon-class="text-warning-500"
            />
          </div>
          <BaseLoadableContent :loading="isConnected && (!isPositionsLoaded || !isBalancesLoaded)">
            <div
              class="text-h5 text-content-primary"
              data-id="data-point"
              :data-key="spyAddress || address"
              data-field="portfolio-total-borrowed"
              :data-value="totalBorrowedValueInfo.hasMissingPrices ? totalBorrowedDisplay : totalBorrowedValueInfo.total"
            >
              {{ totalBorrowedDisplay }}
            </div>
          </BaseLoadableContent>
        </div>
        <div class="flex justify-between items-center">
          <div class="flex items-center gap-4 text-p2 text-content-secondary">
            Net asset value
            <UiHoverPreviewTooltip
              v-if="totalSuppliedValueInfo.hasMissingPrices || totalBorrowedValueInfo.hasMissingPrices"
              title="Incomplete pricing"
              text="Some assets in your portfolio don't have price data available. The displayed value may be higher than shown."
              placement="bottom-end"
              icon-class="text-warning-500"
            />
          </div>
          <BaseLoadableContent :loading="isConnected && (!isPositionsLoaded || !isBalancesLoaded)">
            <div
              class="text-h5 text-content-primary"
              data-id="data-point"
              :data-key="spyAddress || address"
              data-field="portfolio-net-asset-value"
              :data-value="netAssetValueInfo.hasMissingPrices ? netAssetValueDisplay : netAssetValueInfo.total"
            >
              {{ netAssetValueDisplay }}
            </div>
          </BaseLoadableContent>
        </div>
      </div>
    </div>

    <UiTabs
      v-model="tabsModel"
      class="mx-16"
      rounded
      pills
      :list="tabs"
    />

    <!-- transition disabled on the nested page: the global `mode: 'out-in'`
         page transition (nuxt.config.ts) interacts poorly with keep-alive and
         async-imported child chunks on prod, occasionally leaving the inner
         slot empty when toggling between top-level pages. -->
    <NuxtPage :transition="false" />
  </section>
</template>
