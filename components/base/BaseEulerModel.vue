<script setup lang="ts">
import { useLoop, TresCanvas } from '@tresjs/core'

const GRAPH_END = 0.8
const CONVERGE_END = 1.4
const CRYSTAL_END = 1.6

const reveal = ref(0)
const graphProgress = reactive({ graphT: 0, convergeT: 0, crystalT: 0 })
const showGraph = ref(true)

const { onBeforeRender } = useLoop()
onBeforeRender(({ elapsed }) => {
  if (elapsed < GRAPH_END) {
    graphProgress.graphT = elapsed / GRAPH_END
    graphProgress.convergeT = 0
    graphProgress.crystalT = 0
    reveal.value = 0
  }
  else if (elapsed < CONVERGE_END) {
    graphProgress.graphT = 1
    graphProgress.convergeT = (elapsed - GRAPH_END) / (CONVERGE_END - GRAPH_END)
    graphProgress.crystalT = 0
    reveal.value = 0
  }
  else if (elapsed < CRYSTAL_END) {
    const t = (elapsed - CONVERGE_END) / (CRYSTAL_END - CONVERGE_END)
    graphProgress.graphT = 1
    graphProgress.convergeT = 1
    graphProgress.crystalT = t
    reveal.value = t
    if (t >= 1) showGraph.value = false
  }
  else {
    reveal.value = 1
    showGraph.value = false
  }
})
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

    <BaseEulerModelGraph
      v-if="showGraph"
      :graph-t="graphProgress.graphT"
      :converge-t="graphProgress.convergeT"
      :crystal-t="graphProgress.crystalT"
    />
    <BaseEulerModelMesh :reveal="reveal" />
  </TresCanvas>
</template>
