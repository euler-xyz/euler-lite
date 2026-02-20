<script setup lang="ts">
import { useLoop } from '@tresjs/core'
import * as THREE from 'three'

const props = defineProps<{
  graphT: number
  convergeT: number
  crystalT: number
}>()

const NODE_COUNT = 14
const START_RADIUS = 2.5
const DRIFT_RADIUS = 1.4
const NODE_RADIUS = 0.045

// --- Fibonacci sphere: evenly distributed positions ---
function fibonacciSphere(n: number, r: number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = []
  const phi = Math.PI * (Math.sqrt(5) - 1)
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2
    const sinTheta = Math.sqrt(1 - y * y)
    const theta = phi * i
    pts.push(new THREE.Vector3(Math.cos(theta) * sinTheta * r, y * r, Math.sin(theta) * sinTheta * r))
  }
  return pts
}

const startPositions = fibonacciSphere(NODE_COUNT, START_RADIUS)
const driftPositions = fibonacciSphere(NODE_COUNT, DRIFT_RADIUS)
const origin = new THREE.Vector3(0, 0, 0)

// --- Easing ---
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)
const easeInOutQuart = (t: number) => t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2

// --- Build edge pairs from drift positions ---
function buildEdges(positions: THREE.Vector3[]): [number, number][] {
  const edges: [number, number][] = []
  for (let i = 0; i < positions.length; i++) {
    const sorted = positions
      .map((p, j) => ({ j, d: j === i ? Infinity : positions[i].distanceTo(p) }))
      .sort((a, b) => a.d - b.d)
    for (let k = 0; k < 2; k++) {
      const j = sorted[k].j
      if (!edges.some(([a, b]) => (a === i && b === j) || (a === j && b === i)))
        edges.push([i, j])
    }
  }
  return edges
}

const edgePairs = buildEdges(driftPositions)

// --- Three.js objects: built imperatively, never touched by Vue reactivity ---
const nodeMaterial = new THREE.MeshBasicMaterial({ color: 0x93c5fd, transparent: true, opacity: 0.9 })
const lineMaterial = new THREE.LineBasicMaterial({ color: 0x60a5fa, transparent: true, opacity: 0.4, depthWrite: false })

const group = new THREE.Group()

// Node meshes — one per node
const nodeGeometry = new THREE.SphereGeometry(NODE_RADIUS, 8, 8)
const nodeMeshes: THREE.Mesh[] = startPositions.map((pos) => {
  const mesh = new THREE.Mesh(nodeGeometry, nodeMaterial)
  mesh.position.copy(pos)
  group.add(mesh)
  return mesh
})

// Edge line segments
const linePositionArray = new Float32Array(edgePairs.length * 2 * 3)
const lineGeometry = new THREE.BufferGeometry()
lineGeometry.setAttribute('position', new THREE.BufferAttribute(linePositionArray, 3))
const lineSegments = new THREE.LineSegments(lineGeometry, lineMaterial)
group.add(lineSegments)

// --- Update every frame in sync with the render loop ---
const { onBeforeRender } = useLoop()
onBeforeRender(({ elapsed }) => {
  const { graphT, convergeT, crystalT } = props

  // Opacity: pulse during graph phase, solid during converge, fade out during crystal
  let opacity: number
  if (crystalT > 0) {
    opacity = 1 - easeOutCubic(crystalT)
  }
  else if (convergeT > 0) {
    opacity = 1
  }
  else {
    opacity = 0.6 + 0.4 * Math.sin(elapsed * 2.5)
  }
  nodeMaterial.opacity = opacity * 0.9
  lineMaterial.opacity = opacity * 0.4

  // Node positions
  for (let i = 0; i < NODE_COUNT; i++) {
    const mesh = nodeMeshes[i]
    if (convergeT > 0) {
      mesh.position.lerpVectors(driftPositions[i], origin, easeInOutQuart(convergeT))
    }
    else {
      mesh.position.lerpVectors(startPositions[i], driftPositions[i], easeOutCubic(graphT))
    }
  }

  // Edge geometry
  edgePairs.forEach(([a, b], idx) => {
    const pa = nodeMeshes[a].position
    const pb = nodeMeshes[b].position
    linePositionArray.set([pa.x, pa.y, pa.z, pb.x, pb.y, pb.z], idx * 6)
  })
  lineGeometry.attributes.position.needsUpdate = true
})

onUnmounted(() => {
  nodeGeometry.dispose()
  lineGeometry.dispose()
  nodeMaterial.dispose()
  lineMaterial.dispose()
})
</script>

<template>
  <primitive :object="group" />
</template>
