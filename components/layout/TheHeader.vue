<script setup lang="ts">
import { onClickOutside, useWindowScroll } from '@vueuse/core'
import { offset, useFloating } from '@floating-ui/vue'
import { useAppKit } from '@reown/appkit/vue'
import { useAccount } from '@wagmi/vue'
import { WalletDisconnectModal, SelectChainModal, SettingsModal } from '#components'
import { useModal } from '~/components/ui/composables/useModal'
import { type MenuItem, getMenuItems } from '~/entities/menu'

// AppKit modal controls
const { open } = useAppKit()

// Wagmi account info
const { address, isConnected } = useAccount()
const { chainId } = useEulerAddresses()
const modal = useModal()
const route = useRoute()
const { docsUrl, tosUrl, xUrl, discordUrl, telegramUrl, githubUrl, appTitle, enableEarnPage, enableLendPage, enableExplorePage } = useDeployConfig()
const menuItems = getMenuItems(enableEarnPage, enableLendPage, enableExplorePage)

// Scroll-aware header background
const { y: scrollY } = useWindowScroll()
const isScrolled = computed(() => scrollY.value > 0)

const links = computed(() => [
  docsUrl ? { title: 'Docs', url: docsUrl } : null,
  tosUrl ? { title: 'Terms of Use', url: tosUrl } : null,
].filter(Boolean) as Array<{ title: string, url: string }>)

const socials = computed(() => [
  xUrl ? { name: 'x', url: xUrl } : null,
  discordUrl ? { name: 'discord', url: discordUrl } : null,
  telegramUrl ? { name: 'telegram', url: telegramUrl } : null,
  githubUrl ? { name: 'github', url: githubUrl } : null,
].filter(Boolean) as Array<{ name: string, url: string }>)

const reference = ref(null)
const floating = ref(null)
const isSocialsTooltipVisible = ref(false)

const { floatingStyles, update } = useFloating(reference, floating, {
  placement: 'bottom-start',
  middleware: [
    offset({ mainAxis: 10 }),
  ],
})

const onWalletButtonClick = () => {
  if (isConnected.value) {
    modal.open(WalletDisconnectModal)
  }
  else {
    open()
  }
}
const onChainButtonClick = () => {
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

onClickOutside(reference, () => {
  isSocialsTooltipVisible.value = false
})
</script>

<template>
  <header
    class="sticky top-0 right-0 left-0 z-[101] min-h-[72px] py-16 px-12 mobile:min-h-[56px] mobile:p-12 flex justify-between laptop:grid laptop:grid-cols-[1fr_auto_1fr] items-center transition-[background-color,border-color,backdrop-filter] duration-300"
    :class="[isScrolled ? 'bg-header backdrop-blur-[20px] border-b border-line-default' : 'border-b border-transparent']"
  >
    <!-- Left: Logo -->
    <button
      ref="reference"
      class="flex items-center gap-8 relative cursor-pointer outline-none laptop:flex-shrink-0 min-w-0"
      @click="onLogoClick"
    >
      <img
        class="!w-32 !h-32"
        src="/logo.png"
        alt="Euler"
      >
      <div class="flex flex-col items-start mr-4 mobile:hidden">
        <span class="text-[14px] font-semibold text-content-primary leading-tight">{{ appTitle }}</span>
        <span class="text-[10px] text-content-tertiary leading-tight">Powered by Euler</span>
      </div>
      <SvgIcon
        class="!w-14 !h-14 transition-transform duration-fast text-content-muted"
        :class="[isSocialsTooltipVisible ? 'rotate-180' : '']"
        name="arrow-down"
      />
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
            <div
              v-if="links.length"
              class="mb-24"
            >
              <p class="mb-8 text-content-tertiary text-h6 text-left">
                Explore
              </p>

              <a
                v-for="(link, index) in links"
                :key="`link-${index}`"
                :href="link.url"
                class="flex gap-4 mb-4 text-content-primary hover:text-accent-600 transition-colors"
                target="_blank"
              >
                <span class="text-h6">{{ link.title }}</span>
                <SvgIcon
                  class="!w-20 !h-20 text-accent-600"
                  name="arrow-top-right"
                />
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
    </button>

    <!-- Center: Navigation -->
    <div class="flex justify-center mobile:!hidden">
      <NuxtLink
        v-for="item in menuItems"
        :key="item.name"
        :to="'/' + item.name"
        class="flex gap-8 text-[13px] font-medium no-underline py-8 px-14 rounded-8 text-neutral-800 items-center justify-center border border-transparent transition-[color,background-color,border-color]"
        :class="[getIsMenuItemActive(item) ? 'bg-surface !border-line-default shadow-sm text-content-primary' : 'hover:bg-surface-secondary hover:text-content-primary']"
      >
        <UiIcon
          class="!w-18 !h-18"
          :class="[getIsMenuItemActive(item) ? 'text-accent-600' : 'text-content-muted']"
          :name="item.icon"
        />
        <span>{{ item.label }}</span>
      </NuxtLink>
    </div>

    <!-- Right: Wallet -->
    <div class="flex flex-nowrap gap-8 justify-end laptop:flex-shrink-0 min-w-0">
      <UiButton
        icon="arrow-down"
        variant="secondary"
        size="medium"
        icon-right
        @click="onChainButtonClick"
      >
        <BaseAvatar
          :src="`/chains/${chainId}.webp`"
          :label="String(chainId)"
        />
      </UiButton>
      <UiButton
        class="min-w-0 [&>span]:truncate font-semibold"
        :icon="isConnected ? 'arrow-down' : 'plus'"
        :variant="isConnected ? 'secondary' : 'primary'"
        size="medium"
        :icon-right="isConnected"
        @click="onWalletButtonClick"
      >
        {{ isConnected ? `${address?.slice(0, 6)}...${address?.slice(-4)}` : 'Connect Wallet' }}
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
