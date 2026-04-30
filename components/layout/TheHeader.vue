<script setup lang="ts">
import { onClickOutside } from '@vueuse/core'
import { offset, useFloating } from '@floating-ui/vue'
import { useAccount } from '@wagmi/vue'
import {
  WalletDisconnectModal,
  SelectChainModal,
  SettingsModal,
} from '#components'
import { useModal } from '~/components/ui/composables/useModal'
import { type MenuItem, getMenuItems } from '~/entities/menu'

// Wallet connect modal (lazy-initializes AppKit on first call)
const { connect } = useWagmi()

// Wagmi account info
const { address, isConnected } = useAccount()
const { chainId, allowedChainIds } = useEulerAddresses()
const { isSpyMode, spyShortAddress } = useSpyMode()
const modal = useModal()
const route = useRoute()
const {
  docsUrl,
  stargateUrl,
  tosUrl,
  privacyPolicyUrl,
  riskDisclosuresUrl,
  micaWhitepaperUrl,
  xUrl,
  discordUrl,
  telegramUrl,
  githubUrl,
  appTitle,
  enableEarnPage,
  enableLendPage,
  enableExplorePage,
  enablePoweredByEuler,
  enableAppTitle,
  migrationLegacyAppUrl,
} = useDeployConfig()
const menuItems = getMenuItems(
  enableEarnPage,
  enableLendPage,
  enableExplorePage,
)
const canSwitchChains = computed(() => allowedChainIds.value.length > 1)

const links = computed(
  () =>
    [
      docsUrl ? { title: 'Docs', url: docsUrl } : null,
      stargateUrl ? { title: 'Stargate', url: stargateUrl } : null,
      tosUrl ? { title: 'Terms of Use', url: tosUrl } : null,
      privacyPolicyUrl ? { title: 'Privacy Policy', url: privacyPolicyUrl } : null,
      riskDisclosuresUrl ? { title: 'Risk Disclosures', url: riskDisclosuresUrl } : null,
      micaWhitepaperUrl ? { title: 'MiCA Whitepaper', url: micaWhitepaperUrl } : null,
    ].filter(Boolean) as Array<{ title: string, url: string }>,
)

const socials = computed(
  () =>
    [
      xUrl ? { name: 'x', url: xUrl } : null,
      discordUrl ? { name: 'discord', url: discordUrl } : null,
      telegramUrl ? { name: 'telegram', url: telegramUrl } : null,
      githubUrl ? { name: 'github', url: githubUrl } : null,
    ].filter(Boolean) as Array<{ name: string, url: string }>,
)

const wrapperRef = ref(null)
const reference = ref(null)
const floating = ref(null)
const isSocialsTooltipVisible = ref(false)

const { floatingStyles, update } = useFloating(reference, floating, {
  placement: 'bottom-start',
  middleware: [offset({ mainAxis: 10 })],
})

const onWalletButtonClick = () => {
  if (isConnected.value) {
    modal.open(WalletDisconnectModal)
  }
  else {
    connect()
  }
}
const onChainButtonClick = () => {
  if (!canSwitchChains.value) return
  modal.open(SelectChainModal)
}
const onSettingsClick = () => {
  modal.open(SettingsModal)
}
const onLogoClick = () => {
  isSocialsTooltipVisible.value = !isSocialsTooltipVisible.value
}
const getIsMenuItemActive = (link: MenuItem) => {
  return route.name?.toString().startsWith(link.name)
}

onClickOutside(wrapperRef, () => {
  isSocialsTooltipVisible.value = false
})
</script>

<template>
  <header
    class="relative sticky top-0 right-0 left-0 z-[101] min-h-[72px] border-b border-line-default py-16 px-24 mobile:min-h-[56px] mobile:border-b-0 mobile:p-16 flex items-center justify-between bg-header backdrop-blur-[20px]"
  >
    <!-- Left: Logo -->
    <div
      ref="wrapperRef"
      class="relative flex-shrink-0"
    >
      <button
        ref="reference"
        class="flex items-center gap-8 cursor-pointer outline-none"
        @click="onLogoClick"
      >
        <LogoBrand class="text-accent-600" />
        <div
          v-if="enableAppTitle || enablePoweredByEuler"
          class="flex flex-col items-start mr-4 mobile:hidden"
        >
          <span
            v-if="enableAppTitle"
            class="text-[14px] font-semibold text-content-primary leading-tight"
          >{{ appTitle }}</span>
          <span
            v-if="enablePoweredByEuler"
            class="text-[10px] text-content-tertiary leading-tight"
          >Powered by Euler</span>
        </div>
        <SvgIcon
          class="!w-18 !h-18 transition-transform duration-fast text-content-tertiary"
          :class="[isSocialsTooltipVisible ? 'rotate-180' : '']"
          name="arrow-down"
        />
      </button>
      <Transition
        name="tooltip"
        @enter="update"
        @after-enter="update"
      >
        <div
          v-show="isSocialsTooltipVisible"
          ref="floating"
          :style="floatingStyles"
          class="relative max-w-[400px] w-max p-16 rounded-12 bg-surface border border-line-default cursor-default shadow-lg"
          @click.stop
        >
          <div class="flex flex-col gap-4 w-full">
            <a
              v-if="migrationLegacyAppUrl"
              :href="migrationLegacyAppUrl"
              class="block pb-12 border-b border-line-default text-content-primary hover:text-accent-600 transition-colors"
              target="_blank"
              rel="noopener noreferrer"
            >
              <span class="text-h6">Go to the legacy app</span>
            </a>
            <div
              v-if="links.length"
              class="mb-12 pt-5"
            >
              <p class="mb-8 text-content-tertiary text-h6 text-left">
                Resources
              </p>

              <a
                v-for="(link, index) in links"
                :key="`link-${index}`"
                :href="link.url"
                class="flex gap-4 mb-4 text-content-primary hover:text-accent-600 transition-colors"
                target="_blank"
                rel="noopener noreferrer"
              >
                <span class="text-h6">{{ link.title }}</span>
              </a>
            </div>
            <div
              v-if="socials.length"
              class="flex gap-12"
            >
              <a
                v-for="item in socials"
                :key="item.name"
                :href="item.url"
                class="flex justify-center items-center p-8 text-content-secondary bg-surface-secondary w-36 h-36 rounded-[32px] border border-line-default hover:bg-card-hover transition-colors"
                target="_blank"
                rel="noopener noreferrer"
              >
                <SvgIcon
                  class="!w-20 !h-20"
                  :name="item.name"
                />
              </a>
            </div>
          </div>
        </div>
      </Transition>
    </div>

    <!-- Center: Navigation -->
    <div class="absolute left-1/2 -translate-x-1/2 pointer-events-none mobile:!hidden">
      <div class="flex pointer-events-auto">
        <NuxtLink
          v-for="item in menuItems"
          :key="item.name"
          :to="'/' + item.name"
          class="flex gap-8 text-[13px] font-medium no-underline py-10 px-16 rounded-8 text-content-secondary items-center justify-center hover:text-content-primary hover:bg-surface-secondary transition-all"
          :class="[
            getIsMenuItemActive(item)
              ? 'bg-surface-secondary text-content-primary'
              : '',
          ]"
        >
          <UiIcon
            class="!w-18 !h-18"
            :class="[
              getIsMenuItemActive(item)
                ? 'text-accent-600'
                : 'text-content-muted',
            ]"
            :name="item.icon"
          />
          <span>{{ item.label }}</span>
        </NuxtLink>
      </div>
    </div>

    <!-- Right: Wallet -->
    <div class="flex flex-nowrap gap-8 min-w-0">
      <UiButton
        class="py-6 px-12"
        :icon="canSwitchChains ? 'arrow-down' : undefined"
        variant="secondary"
        size="medium"
        :icon-right="canSwitchChains"
        :disabled="!canSwitchChains"
        @click="onChainButtonClick"
      >
        <BaseAvatar
          :src="`/chains/${chainId}.webp`"
          :label="String(chainId)"
        />
      </UiButton>
      <UiButton
        class="min-w-0 [&>span]:truncate"
        :icon="(isConnected || isSpyMode) ? 'arrow-down' : 'plus'"
        :variant="(isConnected || isSpyMode) ? 'secondary' : 'primary'"
        size="medium"
        :icon-right="isConnected || isSpyMode"
        @click="onWalletButtonClick"
      >
        {{
          isSpyMode
            ? spyShortAddress
            : isConnected
              ? `${address?.slice(0, 6)}...${address?.slice(-4)}`
              : "Connect wallet"
        }}
      </UiButton>
      <UiButton
        class="flex-shrink-0"
        variant="secondary"
        size="medium"
        icon="gear"
        icon-only
        @click="onSettingsClick"
      />
    </div>
  </header>
</template>
