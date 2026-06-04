<script setup lang="ts">
const route = useRoute()
const { flags } = useZipFeatureFlags()

const links = computed(() =>
  [
    { label: 'Earn', to: '/zipcode/earn', icon: 'earn-outline' },
    { label: 'Portfolio', to: '/zipcode/portfolio', icon: 'portfolio-outline' },
    flags.value.showProtocolHealthPage ? { label: 'Protocol', to: '/zipcode/protocol', icon: 'health' } : null,
    { label: 'Activity', to: '/zipcode/activity', icon: 'clock' },
  ].filter((l): l is { label: string, to: string, icon: string } => l !== null),
)

const isActive = (to: string) => route.path === to || route.path.startsWith(`${to}/`)
</script>

<template>
  <header
    class="sticky top-0 z-50 w-full border-b border-[color:var(--zip-border)] backdrop-blur-md"
    style="background: color-mix(in oklab, var(--zip-bg) 82%, transparent)"
  >
    <div class="max-w-[1100px] mx-auto px-24 mobile:px-16 h-64 flex items-center justify-between gap-16">
      <NuxtLink
        to="/zipcode"
        class="flex items-center gap-10 shrink-0"
      >
        <span
          class="grid place-items-center w-32 h-32 rounded-10 text-[15px] font-semibold"
          style="background: var(--zip-brand-strong); color: #fff"
        >Z</span>
        <span class="zip-display text-[19px] leading-none">Zip Code</span>
      </NuxtLink>

      <nav class="flex items-center gap-2 mobile:hidden">
        <NuxtLink
          v-for="link in links"
          :key="link.to"
          :to="link.to"
          class="flex items-center gap-8 px-14 py-8 rounded-10 text-[14px] font-medium transition-colors"
          :style="isActive(link.to)
            ? 'background: var(--zip-surface); color: var(--zip-text); box-shadow: 0 1px 2px rgba(16,32,24,.06)'
            : 'color: var(--zip-text-muted)'"
        >
          <SvgIcon
            :name="link.icon"
            class="w-18 h-18"
          />
          {{ link.label }}
        </NuxtLink>
      </nav>

      <ZipWallet />
    </div>

    <!-- Mobile nav row -->
    <nav class="hidden mobile:flex items-center gap-4 overflow-x-auto px-16 pb-8">
      <NuxtLink
        v-for="link in links"
        :key="link.to"
        :to="link.to"
        class="flex items-center gap-6 px-12 py-6 rounded-8 text-[13px] font-medium whitespace-nowrap"
        :style="isActive(link.to)
          ? 'background: var(--zip-surface); color: var(--zip-text)'
          : 'color: var(--zip-text-muted)'"
      >
        <SvgIcon
          :name="link.icon"
          class="w-16 h-16"
        />
        {{ link.label }}
      </NuxtLink>
    </nav>
  </header>
</template>
