<script setup lang="ts">
const { name, isUnverified = false } = defineProps<{
  name: string
  isUnverified?: boolean
}>()
</script>

<template>
  <span
    v-if="isUnverified"
    class="flex text-red-700 items-center gap-4"
  >
    <SvgIcon
      name="warning"
      class="!w-20 !h-20"
    />
    Unknown
  </span>
  <span
    v-else
    class="truncate min-w-0"
  >{{ name }}</span>
</template>
