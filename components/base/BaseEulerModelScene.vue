<script setup lang="ts">
import { useLoop } from '@tresjs/core'

const REVEAL_DURATION = 3.5

// Slow start, then accelerates — gives the feeling of gold slowly warming then flowing
const easeInOutSine = (t: number) => -(Math.cos(Math.PI * Math.min(1, t)) - 1) / 2

const reveal = ref(0)

const { onBeforeRender } = useLoop()
onBeforeRender(({ elapsed }) => {
  reveal.value = elapsed < REVEAL_DURATION ? easeInOutSine(elapsed / REVEAL_DURATION) : 1
})
</script>

<template>
  <BaseEulerModelMesh :reveal="reveal" />
</template>
