<script setup lang="ts">
// Optional institutional LP teaser (spec §11), feature-flagged in the page.
</script>

<template>
  <div class="zip-card-flat p-24 flex flex-col">
    <p class="zip-eyebrow mb-8">
      Institutional capital
    </p>
    <h3 class="zip-display text-[20px]">
      Providing $1M or more?
    </h3>
    <p
      class="mt-8 text-[14px]"
      style="color: var(--zip-text-muted)"
    >
      Explore private terms for committed liquidity.
    </p>
    <div
      class="flex items-center gap-8 mt-12 text-[13px]"
      style="color: var(--zip-text-muted)"
    >
      <span
        class="font-medium"
        style="color: var(--zip-text)"
      >Indicative term</span>
      <span>· 90-day commitment</span>
    </div>
    <UiButton
      variant="primary-stroke"
      class="mt-16 self-start"
      disabled
    >
      Contact team
    </UiButton>
  </div>
</template>
