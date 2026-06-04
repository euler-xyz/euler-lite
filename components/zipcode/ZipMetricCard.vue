<script setup lang="ts">
// Quiet metric card (spec §17.1): small uppercase label, prominent sans value,
// optional sub line. Numerals stay in Inter (never serif) per design notes.
withDefaults(defineProps<{
  label: string
  value: string
  sub?: string
  emphasis?: boolean
}>(), { emphasis: false })
</script>

<template>
  <div :class="emphasis ? 'zip-card p-20' : 'zip-card-flat p-18'">
    <p
      class="text-[12px] font-medium tracking-wide"
      style="color: var(--zip-text-muted)"
    >
      {{ label }}
    </p>
    <p
      class="mt-6 font-semibold tabular-nums"
      :class="emphasis ? 'text-[28px]' : 'text-[22px]'"
      style="color: var(--zip-text)"
    >
      {{ value }}
    </p>
    <p
      v-if="sub"
      class="mt-2 text-[13px]"
      style="color: var(--zip-text-muted)"
    >
      {{ sub }}
    </p>
  </div>
</template>
