<script setup lang="ts">
import { POLL_INTERVAL_60S_MS } from '~/entities/tuning-constants'
import { useModal } from '~/components/ui/composables/useModal'
import { MigrationAnnouncementModal } from '#components'

const route = useRoute()
const router = useRouter()
const { migrationAnnouncementUrl, migrationLegacyAppUrl } = useDeployConfig()
const migrationAnnouncementSeen = useLocalStorage('migration-announcement-seen', false)
const modal = useModal()

const { loadEulerConfig, chainId } = useEulerAddresses()
const { loadVaults, isReady: isVaultsReady, resetVaultsState, refreshVaults, setShowAllLabelEntries } = useVaults()
const { loadTokenList, isLoaded: isTokenListLoaded } = useTokenList()
const { loadLabels, discoverWrapPairs } = useEulerLabels()
const { loadCountry } = useGeoBlock()
const { updateBalances, resetBalances } = useWallets()
const { isConnected, address } = useWagmi()
const showAllLabelEntries = useShowAllLabelEntries()

// Eagerly instantiate useEulerAccount at app root so its internal watchers
// trigger updatePositions() as soon as balances + lens addresses are ready.
// Without this, positions only load when the user navigates to a page that
// imports the composable, making first detail-page visit wait on the full
// subgraph + accountLens round-trip.
useEulerAccount()

// Initialize price backend (configures endpoint when chainId changes)
usePriceBackend()

const { theme } = useTheme()

watch(theme, (newTheme) => {
  if (import.meta.client) {
    document.documentElement.setAttribute('data-theme', newTheme)
    document.documentElement.style.colorScheme = newTheme
  }
}, { immediate: true })

const envConfig = useEnvConfig()

useHead({
  title: envConfig.appTitle,
  htmlAttrs: {
    'data-theme': theme,
  },
  meta: [
    { name: 'description', content: envConfig.appDescription },
    { property: 'og:title', content: envConfig.appTitle },
    { property: 'og:description', content: envConfig.appDescription },
    { name: 'twitter:title', content: envConfig.appTitle },
    { name: 'twitter:description', content: envConfig.appDescription },
    // Crawlers (X, Slack, Discord) read these from the server-rendered HTML,
    // which is patched by server/plugins/app-config.ts. These entries keep
    // the SPA in sync after hydration when the env var changes at runtime.
    ...(envConfig.socialImageUrl
      ? [
          { property: 'og:image', content: envConfig.socialImageUrl },
          { name: 'twitter:image', content: envConfig.socialImageUrl },
        ]
      : []),
  ],
})

const isMenuVisible = ref(true)
const isHeaderVisible = ref(true)
let interval: NodeJS.Timeout | null = null

const checkOnboarding = () => {
  const isOnboardingCompleted = useLocalStorage('is-onboarding-completed', false)
  if (!isOnboardingCompleted.value) {
    const isDeepLink = route.path !== '/' && route.path !== '/onboarding'
    if (isDeepLink) {
      isOnboardingCompleted.value = true
      return
    }
    router.push('/onboarding')
  }
}

watch(route, () => {
  if (['onboarding', 'metrics'].includes(route.name as string)) {
    isMenuVisible.value = false
    isHeaderVisible.value = false
    return
  }

  nextTick(() => {
    isMenuVisible.value = ![
      'lend-vault',
      'lend-withdraw',
      'earn-vault',
      'borrow-collateral-borrow',
      'position-number-repay',
      'position-number-supply',
      'position-number-borrow',
      'position-number-withdraw',
    ].includes(route.name as string)
    isHeaderVisible.value = true
  })
}, { immediate: true })

const checkMigrationAnnouncement = () => {
  if (!migrationAnnouncementUrl || migrationAnnouncementSeen.value) return

  modal.open(MigrationAnnouncementModal, {
    isNotClosable: true,
    onClose: () => { migrationAnnouncementSeen.value = true },
    props: {
      announcementUrl: migrationAnnouncementUrl,
      legacyAppUrl: migrationLegacyAppUrl,
    },
  })
}

await loadEulerConfig()
checkOnboarding()
// onMounted (not synchronous like checkOnboarding) because the modal system requires the DOM
onMounted(checkMigrationAnnouncement)

watch([chainId, showAllLabelEntries], () => {
  setShowAllLabelEntries(showAllLabelEntries.value)
  resetVaultsState()
  resetBalances()
  const targetChainId = chainId.value
  const targetShowAll = showAllLabelEntries.value
  const labelsPromise = loadLabels()
  void loadTokenList()
  void loadCountry()
  void labelsPromise.then(async () => {
    if (chainId.value !== targetChainId) return
    if (showAllLabelEntries.value !== targetShowAll) return
    await loadVaults()
    if (chainId.value !== targetChainId) return
    if (showAllLabelEntries.value !== targetShowAll) return
    // Populate the wrap-pair map for the soft-restricted-asset bypass.
    // Runs once per labels/vaults cycle; cleared on next loadLabels.
    void discoverWrapPairs()
  })
}, { immediate: true })

// Refresh balances when token list finishes loading (includes new DefiLlama tokens)
watch(isTokenListLoaded, (loaded) => {
  if (loaded && (isConnected.value || isVaultsReady.value)) {
    updateBalances()
  }
})

watch([isConnected, isVaultsReady], ([val]) => {
  // Clear existing interval before setting a new one
  if (interval) {
    clearInterval(interval)
    interval = null
  }

  if (val && isVaultsReady.value) {
    updateBalances()
    interval = setInterval(async () => {
      await updateBalances()
      refreshVaults()
    }, POLL_INTERVAL_60S_MS)
  }
}, { immediate: true })

watch(address, () => {
  resetBalances()
  if (isConnected.value && isVaultsReady.value) {
    updateBalances()
  }
})

const { portfolioRefreshCounter } = usePortfolioRefresh()
watch(portfolioRefreshCounter, () => {
  updateBalances()
})

onUnmounted(() => {
  if (interval) {
    clearInterval(interval)
  }
})
</script>

<template>
  <div
    class="sticky top-0 z-[101]"
  >
    <SpyModeBanner />
    <TheHeader v-if="isHeaderVisible" />
  </div>
  <main>
    <section
      class="flex justify-center pt-32 mobile:pt-16"
      :class="isMenuVisible ? 'pb-[98px]' : 'pb-16'"
    >
      <div class="w-full max-w-container mx-16 mobile:px-16 mobile:mx-0">
        <NuxtLayout>
          <NuxtPage
            :keepalive="{ include: ['ExplorePage', 'EarnPage', 'LendPage', 'BorrowPage', 'PortfolioPage'] }"
          />
        </NuxtLayout>
      </div>
    </section>
  </main>
  <UiModals />
  <UiToastContainer />
  <Transition name="page">
    <TheMenu v-show="isMenuVisible" />
  </Transition>
</template>
