<script setup lang="ts">
import { useLoop } from '@tresjs/core'

const REVEAL_DURATION = 1.6

const easeOutCubic = (t: number) => 1 - Math.pow(1 - Math.min(1, t), 3)

const reveal = ref(0)

const { onBeforeRender } = useLoop()
onBeforeRender(({ elapsed }) => {
  reveal.value = elapsed < REVEAL_DURATION ? easeOutCubic(elapsed / REVEAL_DURATION) : 1
})
</script>

<template>
  <BaseEulerModelMesh :reveal="reveal" />
</template>
