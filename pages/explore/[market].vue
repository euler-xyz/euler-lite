<script setup lang="ts">
import { useMarketGroups } from '~/composables/useMarketGroups'
import type { MarketGroup } from '~/entities/lend-discovery'

defineOptions({
  name: 'ExploreMarketPage',
})

const route = useRoute()
const marketKey = computed(() => route.params.market as string)

const { marketGroups, isResolvingTVL, fetchMarketGroupOnDemand } = useMarketGroups()
const { isEVKUpdating, isEarnUpdating, isSecuritizeUpdating, isEscrowUpdating, isCollateralResolved } = useVaults()

const isVaultsLoading = computed(() =>
  isEVKUpdating.value || isEarnUpdating.value || isSecuritizeUpdating.value || isEscrowUpdating.value
  || isResolvingTVL.value,
)

const isOnDemandBlocked = computed(() => isVaultsLoading.value || !isCollateralResolved.value)

// Regular market from pre-loaded groups
const indexedMarket = computed(() =>
  marketGroups.value.find(g => g.id === marketKey.value),
)

// On-demand market for non-explorable products accessed via direct URL
const onDemandMarket = ref<MarketGroup | null>(null)
const isLoadingOnDemand = ref(false)
let onDemandRunId = 0

watch(
  [indexedMarket, isOnDemandBlocked, marketKey],
  async ([found, loading, key]) => {
    // If the market appeared in regular groups, clear on-demand data
    if (found) {
      onDemandMarket.value = null
      return
    }

    // Skip while vault/collateral data is still loading, or no key — keep stale data visible
    if (loading || !key) return

    // Skip if already loaded for this key
    if (onDemandMarket.value?.id === key) return

    const runId = ++onDemandRunId
    isLoadingOnDemand.value = true
    try {
      const result = await fetchMarketGroupOnDemand(key)
      if (runId === onDemandRunId) {
        onDemandMarket.value = result
      }
    }
    finally {
      if (runId === onDemandRunId) {
        isLoadingOnDemand.value = false
      }
    }
  },
  { immediate: true },
)

const market = computed(() => indexedMarket.value || onDemandMarket.value)
const isLoading = computed(() =>
  isVaultsLoading.value || isLoadingOnDemand.value || (!market.value && !isCollateralResolved.value),
)
</script>

<template>
  <section class="relative flex flex-col min-h-[calc(100dvh-178px)]">
    <!-- Loading -->
    <UiLoader
      v-if="isLoading"
      class="flex-1 self-center justify-self-center"
    />

    <!-- Market not found -->
    <div
      v-else-if="!market"
      class="flex flex-col flex-1 gap-12 items-center justify-center text-content-tertiary"
    >
      <UiIcon
        name="search"
        class="!w-24 !h-24"
      />
      <div class="text-center max-w-[240px]">
        Market not found. It may not exist on this network.
      </div>
      <NuxtLink
        to="/explore"
        class="text-p3 text-accent-600 underline mt-8"
      >
        Browse all markets
      </NuxtLink>
    </div>

    <!-- Market page -->
    <template v-else>
      <BackButton
        class="hidden tablet:inline-flex tablet:absolute tablet:top-0 tablet:right-full tablet:mr-12"
        fallback="/explore"
      />
      <BackButton
        class="tablet:hidden mb-16"
        fallback="/explore"
      />
      <DiscoveryMarketAccordion
        :markets="[market]"
        :initial-expanded="[market.id]"
      />
    </template>
  </section>
</template>
