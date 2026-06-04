<script setup lang="ts">
// "How it works" steps (spec §10.1).
const steps = [
  'Deposit USDC',
  'Receive zipUSD at 1:1',
  'Capital supports verified HELOC originators',
  'Request redemption when you want to exit',
  'Claim USDC after queue settlement',
]
</script>

<template>
  <div class="zip-card-flat p-24">
    <h3 class="zip-display text-[20px] mb-16">
      How it works
    </h3>
    <ol class="flex flex-col gap-12">
      <li
        v-for="(step, i) in steps"
        :key="i"
        class="flex items-start gap-12"
      >
        <span
          class="grid place-items-center w-24 h-24 rounded-full text-[12px] font-semibold shrink-0 mt-1"
          style="background: var(--zip-brand-soft); color: #1f7a45"
        >{{ i + 1 }}</span>
        <span
          class="text-[15px]"
          style="color: var(--zip-text)"
        >{{ step }}</span>
      </li>
    </ol>
  </div>
</template>
