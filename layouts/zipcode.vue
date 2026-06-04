<script setup lang="ts">
// Full-bleed shell for the Zip Code Finance lender demo. The `.zipcode-theme`
// wrapper scopes the brand palette (assets/styles/zipcode.scss); the Euler
// header/menu are skipped for /zipcode/* routes in app.vue.
const isDev = import.meta.dev
</script>

<template>
  <div class="zipcode-theme min-h-screen w-full flex flex-col">
    <ZipNav />
    <main class="flex-1 w-full max-w-[1100px] mx-auto px-24 py-40 mobile:px-16 mobile:py-24">
      <slot />
    </main>
    <footer class="w-full border-t border-[color:var(--zip-border)] py-24 mt-24">
      <div
        class="max-w-[1100px] mx-auto px-24 mobile:px-16 flex flex-wrap items-center justify-between gap-12 text-[13px]"
        style="color: var(--zip-text-muted)"
      >
        <span>Zip Code Finance — demo environment. Mocked data, no live transactions.</span>
        <span>Target $1.00 reference · Redemptions settle via a 30-day epoch queue</span>
      </div>
    </footer>
    <ClientOnly>
      <ZipDemoStateToolbar v-if="isDev" />
    </ClientOnly>
  </div>
</template>
