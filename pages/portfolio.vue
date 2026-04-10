<script setup lang="ts">
import { useAccount } from '@wagmi/vue'
import { formatNumber, formatCompactUsdValue } from '~/utils/string-utils'
import { POLL_INTERVAL_30S_MS } from '~/entities/tuning-constants'

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
const { portfolioRefreshCounter } = usePortfolioRefresh()
const { isSpyMode, spyAddress } = useSpyMode()

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
  const targetAddress = isSpyMode.value ? spyAddress.value : address.value
  if (!targetAddress) return
  await refreshAllPositions(eulerLensAddresses.value, targetAddress)
}

watch(tabsModel, checkTab, { immediate: true })
const isActive = ref(false)

onActivated(async () => {
  isActive.value = true
  checkTab()
  await updateBalances()
  updatePositions()
  if (interval.value) clearInterval(interval.value)
  interval.value = setInterval(updatePositions, POLL_INTERVAL_30S_MS)
})
onDeactivated(() => {
  isActive.value = false
  if (interval.value) {
    clearInterval(interval.value)
    interval.value = null
  }
})

watch(portfolioRefreshCounter, () => {
  if (isActive.value) {
    updatePositions()
  }
})
</script>

<template>
  <section class="flex flex-col gap-16 min-h-[calc(100dvh-178px)] mobile:-mx-16">
    <div class="flex items-center justify-between px-16">
      <h2 class="text-h2 text-content-primary">
        Your Portfolio
      </h2>
      <div class="flex items-center gap-8">
        <span class="text-h6 text-content-secondary">Show all</span>
        <UiFootnote
          title="Show all"
          text="When enabled, shows positions and deposits in unverified vaults. Interacting with unverified vaults may pose security risks, as such vaults could potentially be used for phishing attempts. Ensure you trust the source before continuing."
          tooltip-placement="top-end"
        />
        <UiSwitch
          v-model="isShowAllPositions"
        />
      </div>
    </div>

    <PortfolioShowAllHint />

    <div class="flex flex-col gap-16 mx-16 laptop:flex-row laptop:items-stretch">
      <div class="flex flex-col gap-16 p-16 rounded-12 border border-line-default bg-card shadow-card laptop:flex-1">
        <div class="text-h4 text-content-primary">
          Portfolio performance
        </div>
        <div class="flex justify-between items-center">
          <div class="flex items-center gap-4 text-p2 text-content-secondary">
            Net APY
            <UiFootnote
              title="Portfolio Net APY"
              text="Net annual percentage yield across all positions. Calculated as total net yield (supply income minus borrow costs) divided by total supplied value."
              tooltip-placement="bottom-start"
              class="[--ui-footnote-icon-color:var(--c-content-tertiary)]"
            />
          </div>
          <BaseLoadableContent :loading="isConnected && (!isPositionsLoaded || !isBalancesLoaded)">
            <div
              class="text-h5"
              :class="[portfolioNetApy >= 0 ? 'text-accent-600' : 'text-error-500']"
            >
              {{ Number.isFinite(portfolioNetApy) ? `${formatNumber(portfolioNetApy)}%` : '-' }}
            </div>
          </BaseLoadableContent>
        </div>
        <div class="flex justify-between items-center">
          <div class="flex items-center gap-4 text-p2 text-content-secondary">
            ROE
            <UiFootnote
              title="Portfolio ROE"
              text="Return on equity across all positions. Calculated as total net yield divided by total equity (supplied value minus borrowed value)."
              tooltip-placement="bottom-start"
              class="[--ui-footnote-icon-color:var(--c-content-tertiary)]"
            />
          </div>
          <BaseLoadableContent :loading="isConnected && (!isPositionsLoaded || !isBalancesLoaded)">
            <div
              class="text-h5"
              :class="[portfolioRoe >= 0 ? 'text-accent-600' : 'text-error-500']"
            >
              {{ Number.isFinite(portfolioRoe) ? `${formatNumber(portfolioRoe)}%` : '-' }}
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
            <UiFootnote
              v-if="totalSuppliedValueInfo.hasMissingPrices"
              title="Incomplete pricing"
              text="Some supplied assets don't have price data available. The displayed value may be higher than shown."
              tooltip-placement="bottom-end"
              class="[--ui-footnote-icon-color:var(--warning-500)]"
            />
          </div>
          <BaseLoadableContent :loading="isConnected && (!isPositionsLoaded || !isBalancesLoaded)">
            <div class="text-h5 text-content-primary">
              {{ (() => {
                const { total, hasMissingPrices } = totalSuppliedValueInfo
                if (total === 0 && hasMissingPrices) return '—'
                return formatCompactUsdValue(total)
              })() }}
            </div>
          </BaseLoadableContent>
        </div>
        <div class="flex justify-between items-center">
          <div class="flex items-center gap-4 text-p2 text-content-secondary">
            Total borrowed
            <UiFootnote
              v-if="totalBorrowedValueInfo.hasMissingPrices"
              title="Incomplete pricing"
              text="Some borrowed assets don't have price data available. The displayed value may be higher than shown."
              tooltip-placement="bottom-end"
              class="[--ui-footnote-icon-color:var(--warning-500)]"
            />
          </div>
          <BaseLoadableContent :loading="isConnected && (!isPositionsLoaded || !isBalancesLoaded)">
            <div class="text-h5 text-content-primary">
              {{ (() => {
                const { total, hasMissingPrices } = totalBorrowedValueInfo
                if (total === 0 && hasMissingPrices) return '—'
                return formatCompactUsdValue(total)
              })() }}
            </div>
          </BaseLoadableContent>
        </div>
        <div class="flex justify-between items-center">
          <div class="flex items-center gap-4 text-p2 text-content-secondary">
            Net asset value
            <UiFootnote
              v-if="totalSuppliedValueInfo.hasMissingPrices || totalBorrowedValueInfo.hasMissingPrices"
              title="Incomplete pricing"
              text="Some assets in your portfolio don't have price data available. The displayed value may be higher than shown."
              tooltip-placement="bottom-end"
              class="[--ui-footnote-icon-color:var(--warning-500)]"
            />
          </div>
          <BaseLoadableContent :loading="isConnected && (!isPositionsLoaded || !isBalancesLoaded)">
            <div class="text-h5 text-content-primary">
              {{ (() => {
                const netValue = totalSuppliedValueInfo.total - totalBorrowedValueInfo.total
                const hasMissing = totalSuppliedValueInfo.hasMissingPrices || totalBorrowedValueInfo.hasMissingPrices
                if (netValue === 0 && hasMissing) return '—'
                return formatCompactUsdValue(netValue)
              })() }}
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

    <NuxtPage />
  </section>
</template>
