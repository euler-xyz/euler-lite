<script setup lang="ts">
import { getChainLogoUrl } from '~/utils/chain-logo'

const props = defineProps<{
  chainId: number
  name: string
  selected?: boolean
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
    <span
      class="mr-10 flex h-18 w-18 items-center justify-center rounded-4 border transition-colors"
      :class="props.selected ? 'border-accent-600 bg-accent-600 text-content-inverse' : 'border-line-emphasis text-transparent'"
      aria-hidden="true"
    >
      <SvgIcon
        name="check"
        class="!h-12 !w-12"
      />
    </span>
    <BaseAvatar
      class="mr-8 w-32 h-32 shadow-[inset_0_0_0_1px_var(--border-subtle)] rounded-full"
      :class="props.deprecated ? 'opacity-40' : ''"
      :src="logoSrc"
      :label="props.name"
    />
    {{ props.name }}
  </button>
</template>
