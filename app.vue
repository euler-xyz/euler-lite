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

// ---------------------------------------------------------------------------
// HelpScout Beacon
//
// Beacon renders its launcher and panel inside a cross-origin iframe, so our
// CSS cannot reach inside it — appearance is driven entirely through its own
// config API, which accepts repeated calls at runtime.
// ---------------------------------------------------------------------------

const BEACON_MOBILE_BREAKPOINT = 900
// The dark-mode iframe filter in main.scss converts this source colour to the
// app's #23c09b Beacon accent. Help Scout has no API for an iframe dark theme.
const BEACON_DARK_FILTER_ACCENT = '#008762'

/**
 * Read a theme token straight off the document so Beacon tracks the app's
 * palette instead of a hardcoded copy that can drift out of sync.
 * Beacon only accepts a hex string, so anything else falls back.
 */
const themeToken = (name: string, fallback: string) => {
  if (!import.meta.client) return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value) ? value : fallback
}

/**
 * --accent-600 is the app's primary-button green (#23c09b in both themes) and
 * the colour Beacon paints its launcher, panel header and send button with.
 * --accent-500 is deliberately not used here: it is the brighter text accent,
 * and it made the launcher louder than every button in the app.
 */
const beaconAccent = computed(() => {
  // Depend on theme so the token is re-read after a theme switch.
  void theme.value
  return themeToken('--accent-600', '#23c09b')
})

const applyBeaconDesign = () => {
  if (!import.meta.client || typeof window.Beacon !== 'function') return

  // On mobile the bottom nav occupies ~98px, so lift the launcher clear of it.
  const isMobile = window.innerWidth <= BEACON_MOBILE_BREAKPOINT
  const verticalOffset = isMobile && isMenuVisible.value ? 106 : 24

  window.Beacon('config', {
    // In dark mode Beacon's complete cross-origin frame is filtered to a dark
    // palette. Use its pre-filter source colour so the rendered accent still
    // matches the rest of the app.
    color: theme.value === 'dark' ? BEACON_DARK_FILTER_ACCENT : beaconAccent.value,
    display: {
      style: 'icon',
      iconImage: 'question',
      position: 'right',
      horizontalOffset: 24,
      verticalOffset,
      // Above page content, below UiModal (3000) so dialogs are never covered.
      zIndex: 2500,
    },
    labels: {
      // The wallet address and diagnostics below are attached automatically, so
      // say so where the user can see it but not edit it.
      responseTime: address.value
        ? `We usually reply within 4 hours. Your wallet ${shortenAddress(address.value)} and recent app diagnostics are attached.`
        : 'We usually reply within 4 hours. Recent app diagnostics are attached.',
    },
  })
}

/** Wallet + chain + console buffer, attached to the conversation for agents. */
const applyBeaconSessionData = () => {
  if (!import.meta.client || typeof window.Beacon !== 'function') return
  window.Beacon('session-data', {
    'Wallet address': address.value ?? 'Not connected',
    'Chain': String(chainId.value),
    'App state': JSON.stringify({
      url: window.location.href,
      route: route.name,
      theme: theme.value,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      userAgent: navigator.userAgent,
    }),
    'Recent console output': getRecentConsoleOutput() || 'none captured',
  })
}

watch([theme, address, isMenuVisible], applyBeaconDesign, { immediate: true })
watch([address, chainId], applyBeaconSessionData, { immediate: true })

// Keep the launcher off the onboarding (connect wallet) screen. Beacon injects
// its container after window load, so this toggles a root class that
// assets/styles/main.scss keys off, rather than the element itself.
watch(() => route.name, (name) => {
  if (!import.meta.client) return
  document.documentElement.classList.toggle('beacon-hidden', name === 'onboarding')
}, { immediate: true })

onMounted(() => {
  applyBeaconDesign()
  // Re-snapshot diagnostics when the panel is opened so the console buffer and
  // app state reflect the moment the user decided to ask for help.
  if (typeof window.Beacon === 'function') {
    window.Beacon('on', 'open', applyBeaconSessionData)
  }
  window.addEventListener('resize', applyBeaconDesign)
})
onUnmounted(() => {
  if (import.meta.client) window.removeEventListener('resize', applyBeaconDesign)
})

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
  <Transition name="page">
    <TheMenu v-show="isMenuVisible" />
  </Transition>
</template>
