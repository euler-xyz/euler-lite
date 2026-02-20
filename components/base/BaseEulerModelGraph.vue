<script setup lang="ts">
import * as THREE from 'three'

const props = defineProps<{
  graphT: number
  convergeT: number
  crystalT: number
}>()

const NODE_COUNT = 14
const START_RADIUS = 2.5
const DRIFT_RADIUS = 1.6
const NODE_RADIUS = 0.045

function fibonacciSphere(n: number, r: number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = []
  const phi = Math.PI * (Math.sqrt(5) - 1)
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2
    const radius = Math.sqrt(1 - y * y)
    const theta = phi * i
    pts.push(new THREE.Vector3(Math.cos(theta) * radius * r, y * r, Math.sin(theta) * radius * r))
  }
  return pts
}

const startPositions = fibonacciSphere(NODE_COUNT, START_RADIUS)
const driftPositions = fibonacciSphere(NODE_COUNT, DRIFT_RADIUS)
const origin = new THREE.Vector3(0, 0, 0)

const easeInExpo = (t: number) => t === 0 ? 0 : Math.pow(2, 10 * t - 10)
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)

function buildEdges(positions: THREE.Vector3[]): [number, number][] {
  const edges: [number, number][] = []
  for (let i = 0; i < positions.length; i++) {
    const distances = positions
      .map((p, j) => ({ j, d: j === i ? Infinity : positions[i].distanceTo(p) }))
      .sort((a, b) => a.d - b.d)
    for (let k = 0; k < 2; k++) {
      const j = distances[k].j
      if (!edges.some(([a, b]) => (a === i && b === j) || (a === j && b === i)))
        edges.push([i, j])
    }
  }
  return edges
}

const edgePairs = buildEdges(driftPositions)
const linePositionArray = new Float32Array(edgePairs.length * 2 * 3)
const lineGeometry = new THREE.BufferGeometry()
lineGeometry.setAttribute('position', new THREE.BufferAttribute(linePositionArray, 3))

const lineMaterial = new THREE.LineBasicMaterial({
  color: 0x60a5fa,
  transparent: true,
  opacity: 0.5,
  depthWrite: false,
})

const lineSegments = new THREE.LineSegments(lineGeometry, lineMaterial)

const nodeMaterial = new THREE.MeshBasicMaterial({
  color: 0x93c5fd,
  transparent: true,
  opacity: 0.9,
})

const nodePositions = ref<THREE.Vector3[]>(startPositions.map(p => p.clone()))

watch(
  () => [props.graphT, props.convergeT, props.crystalT] as const,
  ([gT, cvT, crT]) => {
    const pulse = 0.7 + 0.3 * Math.sin(Date.now() * 0.003 + 1.5)
    const baseOpacity = crT > 0 ? 1 - easeOutCubic(crT) : (gT < 1 ? pulse : 1)
    nodeMaterial.opacity = baseOpacity * 0.9
    lineMaterial.opacity = baseOpacity * 0.4

    for (let i = 0; i < NODE_COUNT; i++) {
      let pos: THREE.Vector3
      if (cvT > 0) {
        pos = driftPositions[i].clone().lerp(origin, easeInExpo(cvT))
      }
      else {
        pos = startPositions[i].clone().lerp(driftPositions[i], easeOutCubic(gT))
      }
      nodePositions.value[i].copy(pos)
    }

    edgePairs.forEach(([a, b], idx) => {
      const pa = nodePositions.value[a]
      const pb = nodePositions.value[b]
      linePositionArray.set([pa.x, pa.y, pa.z, pb.x, pb.y, pb.z], idx * 6)
    })
    lineGeometry.attributes.position.needsUpdate = true
  },
  { immediate: true },
)

onUnmounted(() => {
  lineGeometry.dispose()
  lineMaterial.dispose()
  nodeMaterial.dispose()
})
</script>

<template>
  <primitive :object="lineSegments" />

  <TresMesh
    v-for="(pos, i) in nodePositions"
    :key="i"
    :position="[pos.x, pos.y, pos.z]"
  >
    <TresSphereGeometry :args="[NODE_RADIUS, 8, 8]" />
    <primitive :object="nodeMaterial" />
  </TresMesh>
</template>
