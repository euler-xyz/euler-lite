<template>
  <svg
    :class="icon.class"
  >
    <title v-if="title">{{ title }}</title>
    <desc v-if="desc">{{ desc }}</desc>
    <use :href="icon.url" />
  </svg>
</template>

<script setup lang="ts">
const props = defineProps({
  name: {
    type: String,
    required: true,
  },
  title: {
    type: String,
    default: null,
  },
  desc: {
    type: String,
    default: null,
  },
})

const icon = ref({
  url: '',
  class: '',
})

let spriteRequestId = 0
watch(() => props.name, async (name) => {
  const requestId = ++spriteRequestId
  const nextIcon = await useSprite(name)
  if (requestId === spriteRequestId) {
    icon.value = nextIcon
  }
}, { immediate: true })
</script>
