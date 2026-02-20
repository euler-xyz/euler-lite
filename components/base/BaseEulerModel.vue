<script setup lang="ts">
import { TresCanvas } from '@tresjs/core'
</script>

<template>
  <TresCanvas
    alpha
    clear-color="#00000000"
    :window-size="false"
  >
    <TresOrthographicCamera
      :position="[0, 0, 5]"
      :args="[-1.4, 1.4, 1.4, -1.4, 0.1, 100]"
    />

    <TresAmbientLight :intensity="0.8" />
    <TresDirectionalLight
      :position="[4, 6, 5]"
      :intensity="2.5"
    />
    <TresDirectionalLight
      :position="[-5, 2, 3]"
      :intensity="0.8"
    />
    <TresDirectionalLight
      :position="[0, -4, -5]"
      :intensity="0.4"
    />

    <BaseEulerModelScene />
  </TresCanvas>
</template>

<style scoped>
:deep(canvas) {
  background: transparent !important;
}
</style>
