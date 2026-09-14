<script setup lang="ts">
withDefaults(defineProps<{
  label?: string
  sourceUrl?: string
  separator?: ',' | '·'
}>(), {
  label: undefined,
  sourceUrl: undefined,
  separator: ',',
})
</script>

<template>
  <span v-if="label">
    <span aria-hidden="true">{{ separator }}&nbsp;</span><a
      v-if="sourceUrl"
      :href="sourceUrl"
      target="_blank"
      rel="noopener noreferrer"
      class="underline"
      @click.stop
    ><SvgIcon
      name="warning"
      class="!w-14 !h-14 inline-block align-middle mr-2 text-warning-500"
      aria-hidden="true"
    /><span>{{ label }}</span></a><span v-else><SvgIcon
      name="warning"
      class="!w-14 !h-14 inline-block align-middle mr-2 text-warning-500"
      aria-hidden="true"
    /><span>{{ label }}</span></span>
  </span>
</template>
