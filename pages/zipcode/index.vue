<script setup lang="ts">
// "Choose your path" landing — Lender vs Originator (adapted from the worktree).
// Standalone centered screen (no nav chrome), so it opts out of the layout.
definePageMeta({ layout: false })
useHead({ title: 'Zip Code Finance' })

const { reset } = useZipDemo()

// Start every demo run from a clean state.
onMounted(() => reset())

const paths = [
  {
    to: '/zipcode/kyb',
    icon: 'wallet',
    title: 'Lender',
    description: 'Deposit USDC, receive zipUSD, view your portfolio and protocol health, request redemption, and claim USDC.',
    cta: 'Start as Lender',
    available: true,
  },
  {
    to: '/zipcode/originator',
    icon: 'bank',
    title: 'Originator',
    description: 'Review the originator workspace for warehouse credit lines and loan activity.',
    cta: 'Start as Originator',
    available: true,
  },
]
</script>

<template>
  <div class="zipcode-theme min-h-screen w-full flex items-center justify-center p-24">
    <section class="w-full max-w-[760px] text-center">
      <div class="flex items-center justify-center gap-10 mb-24">
        <span
          class="grid place-items-center w-32 h-32 rounded-10 text-[15px] font-semibold"
          style="background: var(--zip-brand-strong); color: #fff"
        >Z</span>
        <span class="zip-display text-[20px] leading-none">Zip Code</span>
      </div>

      <p class="zip-eyebrow mb-10">
        ZIP CODE FINANCE
      </p>
      <h1 class="zip-display text-[44px] mobile:text-[32px]">
        Choose your path
      </h1>
      <p
        class="mt-12 text-[17px] max-w-[480px] mx-auto"
        style="color: var(--zip-text-muted)"
      >
        Start with the lender demo or open the originator workspace.
      </p>

      <div class="grid grid-cols-2 gap-20 mt-36 mobile:grid-cols-1 text-left">
        <NuxtLink
          v-for="path in paths"
          :key="path.to"
          :to="path.to"
          class="zip-card p-24 flex flex-col transition-transform hover:-translate-y-0.5"
        >
          <span
            class="grid place-items-center w-48 h-48 rounded-14"
            style="background: var(--zip-brand-soft); color: #1f7a45"
          >
            <SvgIcon
              :name="path.icon"
              class="w-24 h-24"
            />
          </span>
          <h2 class="zip-display text-[22px] mt-16">
            {{ path.title }}
          </h2>
          <p
            class="mt-8 text-[14px] flex-1"
            style="color: var(--zip-text-muted)"
          >
            {{ path.description }}
          </p>
          <UiButton class="mt-20 w-full">
            {{ path.cta }}
          </UiButton>
        </NuxtLink>
      </div>
    </section>
  </div>
</template>
