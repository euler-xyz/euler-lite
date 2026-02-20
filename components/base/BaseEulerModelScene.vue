<script setup lang="ts">
import { useLoop } from '@tresjs/core'

const GRAPH_END = 1.0
const CONVERGE_END = 2.6

const easeOutCubic = (t: number) => 1 - Math.pow(1 - Math.min(1, t), 3)

const reveal = ref(0)
const graphProgress = reactive({ graphT: 0, convergeT: 0 })
const showGraph = ref(true)

const { onBeforeRender } = useLoop()
onBeforeRender(({ elapsed }) => {
  if (elapsed < GRAPH_END) {
    graphProgress.graphT = elapsed / GRAPH_END
    graphProgress.convergeT = 0
    reveal.value = 0
    showGraph.value = true
  }
  else if (elapsed < CONVERGE_END) {
    const t = (elapsed - GRAPH_END) / (CONVERGE_END - GRAPH_END)
    graphProgress.graphT = 1
    graphProgress.convergeT = t
    // Logo starts appearing at 60% convergence, overlapping with node fade
    reveal.value = t > 0.6 ? easeOutCubic((t - 0.6) / 0.4) : 0
    if (t >= 0.95) showGraph.value = false
  }
  else {
    reveal.value = 1
    showGraph.value = false
  }
})
</script>

<template>
  <BaseEulerModelGraph
    v-if="showGraph"
    :graph-t="graphProgress.graphT"
    :converge-t="graphProgress.convergeT"
  />
  <BaseEulerModelMesh :reveal="reveal" />
</template>
