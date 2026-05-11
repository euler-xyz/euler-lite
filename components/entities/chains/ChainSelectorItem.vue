<script setup lang="ts">
import { getChainLogoUrl } from '~/utils/chain-logo'

const props = defineProps<{
  chainId: number
  name: string
  deprecated?: boolean
}>()

const logoSrc = computed(() => getChainLogoUrl(props.chainId))
</script>

<template>
  <button
    type="button"
    class="flex items-center w-full py-12 font-semibold leading-20 text-[16px] cursor-pointer"
    :class="props.deprecated ? 'text-content-tertiary' : ''"
  >
    <BaseAvatar
      class="mr-8 w-32 h-32 shadow-[inset_0_0_0_1px_var(--border-subtle)] rounded-full"
      :class="props.deprecated ? 'opacity-40' : ''"
      :src="logoSrc"
      :label="props.name"
    />
    {{ props.name }}
  </button>
</template>
