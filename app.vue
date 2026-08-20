<script setup lang="ts">
import { POLL_INTERVAL_60S_MS } from '~/entities/tuning-constants'
import { AnnouncementModal } from '#components'
import { useModal } from '~/components/ui/composables/useModal'

const route = useRoute()
const router = useRouter()
const { announcement } = useDeployConfig()
const isOnboardingCompleted = useLocalStorage('is-onboarding-completed', false)
const announcementSeenToken = useLocalStorage('announcement-seen-token', '')
const modal = useModal()
let isAnnouncementOpen = false

const { loadEulerConfig, chainId } = useEulerAddresses()
const { loadVaults, isReady: isVaultsReady, resetVaultsState, refreshVaults, setShowAllLabelEntries } = useVaults()
const { loadTokenList, isLoaded: isTokenListLoaded } = useTokenList()
const { loadLabels } = useEulerLabels()
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
// Start migratable-position discovery from the same app-root lifecycle so the
// Portfolio Migrate tab can appear from preloaded shared state.
useExternalMigrationPositions()

// Instantiate the batch store at app root so its simulation watchers stay
// alive across navigation (mirrors useEulerAccount above).
useTxBatch()
// Recovery is application-scoped so an unresolved attempt remains visible
// across navigation and independently of whether new reviewed executions are enabled.
useReviewedExecutionRecovery()
// Owns all in-scope reviewed execution preparation, acceptance, and recovery handlers.
useReviewedExecution()

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
  if (!isOnboardingCompleted.value) {
    const isDeepLink = route.path !== '/' && route.path !== '/onboarding'
    if (isDeepLink) {
      isOnboardingCompleted.value = true
      return
    }
    router.push('/onboarding')
  }
}

const getIsOnboardingCompleted = () => {
  if (isOnboardingCompleted.value) return true
  if (!import.meta.client) return false
  return window.localStorage.getItem('is-onboarding-completed') === 'true'
}

watch(route, () => {
  if (['onboarding', 'metrics'].includes(route.name as string)) {
    isMenuVisible.value = false
    isHeaderVisible.value = false
    return
  }

  nextTick(() => {
    const currentRouteName = route.name as string
    isMenuVisible.value = ![
      'lend-vault',
      'lend-withdraw',
      'earn-vault',
      'borrow-collateral-borrow',
      'position-number-repay',
      'position-number-supply',
      'position-number-borrow',
      'position-number-borrow-swap',
      'position-number-withdraw',
      'position-number-multiply',
      'position-number-collateral-swap',
    ].includes(currentRouteName)
    isHeaderVisible.value = true
  })
}, { immediate: true })

const checkAnnouncement = () => {
  if (!announcement.enabled || !announcement.token) return
  if (announcementSeenToken.value === announcement.token) return
  if (isAnnouncementOpen || route.name === 'onboarding') return
  if (!getIsOnboardingCompleted()) return

  isAnnouncementOpen = true
  modal.open(AnnouncementModal, {
    isNotClosable: true,
    onClose: () => {
      announcementSeenToken.value = announcement.token
      isAnnouncementOpen = false
    },
    props: {
      title: announcement.title,
      body: announcement.body,
      items: announcement.items,
      announcementUrl: announcement.url,
    },
  })
}

checkOnboarding()
void loadEulerConfig()
onMounted(checkAnnouncement)
watch(() => route.name, () => {
  nextTick(checkAnnouncement)
})

watch([chainId, showAllLabelEntries], () => {
  setShowAllLabelEntries(showAllLabelEntries.value)
  resetVaultsState()
  resetBalances()
  const targetChainId = chainId.value
  const targetShowAll = showAllLabelEntries.value
  const labelsPromise = loadLabels()
  void loadTokenList()
  void loadCountry()
  void labelsPromise.then(() => {
    if (chainId.value !== targetChainId) return
    if (showAllLabelEntries.value !== targetShowAll) return
    void loadVaults()
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
  <BatchDrawer />
  <ReviewedExecutionRecovery />
  <Transition name="page">
    <TheMenu v-show="isMenuVisible" />
  </Transition>
</template>
