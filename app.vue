<script setup lang="ts">
import { POLL_INTERVAL_60S_MS, TOKEN_LIST_RETRY_DELAY_MS } from '~/entities/tuning-constants'
import { useModal } from '~/components/ui/composables/useModal'
import { MigrationAnnouncementModal } from '#components'

const route = useRoute()
const router = useRouter()
const { migrationAnnouncementUrl } = useDeployConfig()
const migrationAnnouncementSeen = useLocalStorage('migration-announcement-seen', false)
const modal = useModal()

const { loadEulerConfig, chainId } = useEulerAddresses()
const { loadVaults, isReady: isVaultsReady, resetVaultsState, refreshVaults } = useVaults()
const { loadTokenList, isLoaded: isTokenListLoaded } = useTokenList()
const { loadLabels } = useEulerLabels()
const { loadCountry } = useGeoBlock()
const { updateBalances, resetBalances } = useWallets()
const { isConnected, address } = useWagmi()

// Initialize price backend (configures endpoint when chainId changes)
usePriceBackend()

const { theme } = useTheme()

watch(theme, (newTheme) => {
  if (import.meta.client) {
    document.documentElement.setAttribute('data-theme', newTheme)
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
  ],
})

const isMenuVisible = ref(true)
const isHeaderVisible = ref(true)
let interval: NodeJS.Timeout | null = null
let tokenListRetryTimeout: NodeJS.Timeout | null = null

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
    },
  })
}

await loadEulerConfig()
checkOnboarding()
// onMounted (not synchronous like checkOnboarding) because the modal system requires the DOM
onMounted(checkMigrationAnnouncement)

watch(chainId, () => {
  resetVaultsState()
  resetBalances()
  if (tokenListRetryTimeout) {
    clearTimeout(tokenListRetryTimeout)
    tokenListRetryTimeout = null
  }
  const targetChainId = chainId.value
  const labelsPromise = loadLabels()
  void loadTokenList()
  void loadCountry()
  // One-shot retry after 15s to pick up supplemental token sources
  // (Uniswap/DefiLlama background fetches complete on the server by then)
  tokenListRetryTimeout = setTimeout(async () => {
    tokenListRetryTimeout = null
    if (chainId.value !== targetChainId) return
    await loadTokenList(true)
    updateBalances()
  }, TOKEN_LIST_RETRY_DELAY_MS)
  void labelsPromise.then(() => {
    if (chainId.value !== targetChainId) return
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
  if (tokenListRetryTimeout) {
    clearTimeout(tokenListRetryTimeout)
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
