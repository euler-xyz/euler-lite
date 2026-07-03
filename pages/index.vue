<script setup lang="ts">
import { getDefaultPageRoute } from '~/entities/menu'

const { enableEarnPage, enableLendPage, enableExplorePage } = useDeployConfig()
const defaultPageRoute = getDefaultPageRoute(enableEarnPage, enableLendPage, enableExplorePage)

const route = useRoute()
const isOnboardingCompleted = useLocalStorage('is-onboarding-completed', false)
// Non-blocking to avoid Suspense + pageTransition crash on direct navigation
navigateTo(
  {
    name: isOnboardingCompleted.value ? defaultPageRoute : 'onboarding',
    query: route.query,
    hash: route.hash,
  },
  { replace: true },
)
</script>

<template>
  <div />
</template>
