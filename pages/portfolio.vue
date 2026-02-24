<script setup lang="ts">
import { useAccount } from '@wagmi/vue'
import { formatNumber, formatCompactUsdValue } from '~/utils/string-utils'
import { POLL_INTERVAL_10S_MS } from '~/entities/tuning-constants'

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
  portfolioRoe,
  portfolioNetApy,
  isPositionsLoaded,
  isShowAllPositions,
  refreshAllPositions,
} = useEulerAccount()
const { rewards } = useMerkl()
const { locks } = useREULLocks()
const { isConnected, address } = useAccount()
const { isLoaded: isBalancesLoaded, updateBalances } = useWallets()
const { eulerLensAddresses } = useEulerAddresses()

const interval: Ref<NodeJS.Timeout | null> = ref(null)

const tabsModel = ref(route.name as string)

const tabs = computed(() => [
  {
    label: 'Positions',
    value: 'portfolio',
    badge: borrowPositions.value.length || null,
  },
  {
    label: 'Savings',
    value: 'portfolio-saving',
    badge: depositPositions.value.length || null,
  },
  {
    label: 'Rewards',
    value: 'portfolio-rewards',
    badge: rewards.value.length + locks.value.length || null,
  },
])

const checkTab = () => {
  if (route.name !== tabsModel.value) {
    router.replace({ name: tabsModel.value })
  }
}

const updatePositions = async () => {
  await refreshAllPositions(eulerLensAddresses.value, address.value as string)
}

watch(tabsModel, checkTab, { immediate: true })
onActivated(async () => {
  checkTab()
  await updateBalances()
  updatePositions()
  interval.value = setInterval(updatePositions, POLL_INTERVAL_10S_MS)
})
onDeactivated(() => {
  if (interval.value) {
    clearInterval(interval.value)
    interval.value = null
  }
})
</script>

<template>
  <section class="flex flex-col min-h-[calc(100dvh-178px)]">
    <div class="bg-surface border border-line-default rounded-6 flex flex-col flex-1">
      <div class="bg-surface-secondary rounded-t-6 border-b border-line-default p-20 pb-16 animate-fade-in-up">
        <!-- Row 1: title + show all toggle -->
        <div class="flex items-center justify-between mb-16">
          <h1 class="text-h1 text-content-primary">
            Your Portfolio
          </h1>
          <div class="flex items-center gap-8">
            <span class="text-h6 text-content-secondary">Show all</span>
            <UiFootnote
              title="Show all"
              text="When enabled, shows positions and deposits in the hidden (unknown) vaults."
              tooltip-placement="top-end"
            />
            <UiSwitch
              v-model="isShowAllPositions"
            />
          </div>
        </div>

        <!-- Row 2: stats -->
        <div class="flex mobile:flex-col gap-16">
          <!-- Hero: Net Asset Value -->
          <div class="flex flex-col w-[200px] shrink-0 pr-16 mobile:w-auto mobile:pr-0 border-r mobile:border-r-0 mobile:border-b border-line-default mobile:pb-16">
            <div class="flex items-center gap-4 text-p3 text-content-tertiary mb-4 whitespace-nowrap">
              Net asset value
              <UiFootnote
                v-if="(totalSuppliedValueInfo.hasMissingPrices || totalBorrowedValueInfo.hasMissingPrices) && (totalSuppliedValueInfo.total - totalBorrowedValueInfo.total) !== 0"
                title="Incomplete pricing"
                text="Some assets in your portfolio don't have price data available. The displayed value may be higher than shown."
                tooltip-placement="bottom-start"
                class="[--ui-footnote-icon-color:var(--c-content-tertiary)]"
              />
            </div>
            <BaseLoadableContent :loading="isConnected && (!isPositionsLoaded || !isBalancesLoaded)">
              <div class="text-h1 text-content-primary whitespace-nowrap">
                {{ (() => {
                  const netValue = totalSuppliedValueInfo.total - totalBorrowedValueInfo.total
                  const hasMissing = totalSuppliedValueInfo.hasMissingPrices || totalBorrowedValueInfo.hasMissingPrices
                  if (netValue === 0 && hasMissing) return '—'
                  return formatCompactUsdValue(netValue)
                })() }}
              </div>
            </BaseLoadableContent>
          </div>

          <!-- Grid: APY, ROE, Supplied, Borrowed -->
          <div class="grid grid-cols-2 gap-16 flex-1">
            <div>
              <div class="flex items-center gap-4 text-p3 text-content-tertiary mb-4">
                Net APY
                <UiFootnote
                  title="Portfolio Net APY"
                  text="Net annual percentage yield across all borrow positions. Calculated as total net yield (supply income minus borrow costs) divided by total supplied value."
                  tooltip-placement="bottom-start"
                  class="[--ui-footnote-icon-color:var(--c-content-tertiary)]"
                />
              </div>
              <BaseLoadableContent :loading="isConnected && (!isPositionsLoaded || !isBalancesLoaded)">
                <div
                  class="text-h4"
                  :class="[portfolioNetApy >= 0 ? 'text-accent-600' : 'text-error-500']"
                >
                  {{ Number.isFinite(portfolioNetApy) ? `${formatNumber(portfolioNetApy)}%` : '-' }}
                </div>
              </BaseLoadableContent>
            </div>

            <div>
              <div class="flex items-center gap-4 text-p3 text-content-tertiary mb-4">
                Total supplied
                <UiFootnote
                  v-if="totalSuppliedValueInfo.hasMissingPrices && totalSuppliedValueInfo.total !== 0"
                  title="Incomplete pricing"
                  text="Some supplied assets don't have price data available. The displayed value may be higher than shown."
                  tooltip-placement="top-end"
                  class="[--ui-footnote-icon-color:var(--c-content-tertiary)]"
                />
              </div>
              <BaseLoadableContent :loading="isConnected && (!isPositionsLoaded || !isBalancesLoaded)">
                <div class="text-h4 text-content-primary">
                  {{ (() => {
                    const { total, hasMissingPrices } = totalSuppliedValueInfo
                    if (total === 0 && hasMissingPrices) return '—'
                    return formatCompactUsdValue(total)
                  })() }}
                </div>
              </BaseLoadableContent>
            </div>

            <div>
              <div class="flex items-center gap-4 text-p3 text-content-tertiary mb-4">
                ROE
                <UiFootnote
                  title="Portfolio ROE"
                  text="Return on equity across all borrow positions. Calculated as total net yield divided by total equity (supplied value minus borrowed value)."
                  tooltip-placement="bottom-start"
                  class="[--ui-footnote-icon-color:var(--c-content-tertiary)]"
                />
              </div>
              <BaseLoadableContent :loading="isConnected && (!isPositionsLoaded || !isBalancesLoaded)">
                <div
                  class="text-h4"
                  :class="[portfolioRoe >= 0 ? 'text-accent-600' : 'text-error-500']"
                >
                  {{ Number.isFinite(portfolioRoe) ? `${formatNumber(portfolioRoe)}%` : '-' }}
                </div>
              </BaseLoadableContent>
            </div>

            <div>
              <div class="flex items-center gap-4 text-p3 text-content-tertiary mb-4">
                Total borrowed
                <UiFootnote
                  v-if="totalBorrowedValueInfo.hasMissingPrices && totalBorrowedValueInfo.total !== 0"
                  title="Incomplete pricing"
                  text="Some borrowed assets don't have price data available. The displayed value may be higher than shown."
                  tooltip-placement="top-end"
                  class="[--ui-footnote-icon-color:var(--c-content-tertiary)]"
                />
              </div>
              <BaseLoadableContent :loading="isConnected && (!isPositionsLoaded || !isBalancesLoaded)">
                <div class="text-h4 text-content-primary">
                  {{ (() => {
                    const { total, hasMissingPrices } = totalBorrowedValueInfo
                    if (total === 0 && hasMissingPrices) return '—'
                    return formatCompactUsdValue(total)
                  })() }}
                </div>
              </BaseLoadableContent>
            </div>
          </div>
        </div>
      </div>
      <!-- end header card -->

      <UiTabs
        v-model="tabsModel"
        pills
        :list="tabs"
        class="border border-line-default"
        style="--ui-tabs-pills-background-color: transparent; --ui-tabs-block-background-color: var(--bg-surface)"
      />

      <NuxtPage />
    </div>
  </section>
</template>
