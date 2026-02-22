<script setup lang="ts">
import type { Vault } from '~/entities/vault'

defineProps<{ items: Vault[], type: 'lend' | 'borrow' }>()

const { enableEntityBranding } = useDeployConfig()
</script>

<template>
  <div class="flex flex-col -mx-20 -mb-20">
    <!-- Column headers -->
    <div
      class="sticky top-[72px] z-10 grid items-center gap-x-16 pt-16 py-8 px-20 bg-surface border-b border-line-default text-content-tertiary text-p3 mobile:!hidden"
      :class="enableEntityBranding ? 'grid-cols-[2fr_repeat(4,1fr)]' : 'grid-cols-[2fr_repeat(3,1fr)]'"
    >
      <div>Asset</div>
      <div>Supply APY</div>
      <div>Total supply</div>
      <div>Available liquidity</div>
      <div
        v-if="enableEntityBranding"
        class="text-right"
      >
        Utilization
      </div>
    </div>

    <VaultItem
      v-for="(vault, index) in items"
      :key="vault.address"
      :vault="vault"
      :type="type"
      class="animate-fade-in-up"
      :style="{ animationDelay: `${Math.min(index * 0.03, 0.2)}s` }"
    />
  </div>
</template>
