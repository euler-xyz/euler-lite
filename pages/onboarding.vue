<script setup lang="ts">
import { useAccount } from '@wagmi/vue'
import { useAppKit } from '@reown/appkit/vue'
import { getDefaultPageRoute } from '~/entities/menu'

const { isConnected } = useAccount()

const { open } = useAppKit()
const { appTitle, appDescription, enableEarnPage, enableLendPage, enableExplorePage } = useDeployConfig()
const defaultPageRoute = getDefaultPageRoute(enableEarnPage, enableLendPage, enableExplorePage)

const isOnboardingCompleted = useLocalStorage('is-onboarding-completed', false)

const onConnectWalletClick = () => {
  open()
}

const onConnectLaterClick = () => {
  isOnboardingCompleted.value = true
  navigateTo({ name: defaultPageRoute })
}

watch(isConnected, (value) => {
  if (value) {
    isOnboardingCompleted.value = true
    navigateTo({ name: defaultPageRoute })
  }
}, { immediate: true })
</script>

<template>
  <section class="w-full h-dvh -mt-16 -mb-[98px] flex items-center justify-center overflow-hidden">
    <div
      class="absolute inset-0 -z-10"
      style="background: radial-gradient(ellipse 80% 60% at 50% 100%, var(--accent-400) 0%, transparent 70%); opacity: 0.15;"
    />
    <div class="flex flex-col items-center gap-24 w-full max-w-[360px] px-24">
      <img
        src="/logo.png"
        alt="Logo"
        class="w-64 h-64"
      >

      <div class="flex flex-col items-center gap-8">
        <h1 class="text-h1 text-content-primary text-center text-balance">
          {{ appTitle }}
        </h1>
        <p class="text-p3 text-content-secondary text-center text-pretty">
          {{ appDescription }}
        </p>
      </div>

      <div class="flex flex-col gap-8 w-full">
        <UiButton
          size="large"
          @click="onConnectWalletClick"
        >
          Connect wallet
        </UiButton>
        <UiButton
          size="large"
          variant="secondary"
          @click="onConnectLaterClick"
        >
          Explore without wallet
        </UiButton>
      </div>
    </div>
  </section>
</template>
