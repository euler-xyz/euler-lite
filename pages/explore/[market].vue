<script setup lang="ts">
import { useMarketGroups } from '~/composables/useMarketGroups'

defineOptions({
  name: 'ExploreMarketPage',
})

const route = useRoute()
const marketKey = computed(() => route.params.market as string)

const { marketGroups, isResolvingTVL } = useMarketGroups()
const { isEVKUpdating, isEarnUpdating, isSecuritizeUpdating, isEscrowUpdating } = useVaults()

const isLoading = computed(() =>
  isEVKUpdating.value || isEarnUpdating.value || isSecuritizeUpdating.value || isEscrowUpdating.value
  || isResolvingTVL.value,
)

const market = computed(() =>
  marketGroups.value.find(g => g.id === marketKey.value),
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
