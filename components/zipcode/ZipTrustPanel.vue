<script setup lang="ts">
// Trust panel (spec §10.1).
const points = [
  'HELOC originators are permissioned',
  'Real-world agreements and lien collateral are verified',
  'Critical credit actions are oracle-gated',
  'Protocol health is monitored continuously',
]
</script>

<template>
  <div class="zip-card-muted p-24">
    <h3 class="zip-display text-[20px] mb-16">
      Verified credit infrastructure
    </h3>
    <ul class="flex flex-col gap-12">
      <li
        v-for="point in points"
        :key="point"
        class="flex items-start gap-10 text-[15px]"
        style="color: var(--zip-text)"
      >
        <SvgIcon
          name="check"
          class="w-18 h-18 shrink-0 mt-1"
          style="color: var(--zip-brand-strong)"
        />
        {{ point }}
      </li>
    </ul>
  </div>
</template>
