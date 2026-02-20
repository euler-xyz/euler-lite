<script setup lang="ts">
import { useLoop } from '@tresjs/core'
import * as THREE from 'three'

const props = defineProps<{
  graphT: number
  convergeT: number
}>()

const NODE_COUNT = 14
const START_RADIUS = 2.5
const DRIFT_RADIUS = 1.4
const NODE_RADIUS = 0.048

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

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)
const easeInOutQuart = (t: number) => t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2

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

// --- Node material: soft glow sphere via view-space normals + additive blending ---
const nodeUniforms = { uOpacity: { value: 0.0 } }
const nodeMaterial = new THREE.ShaderMaterial({
  uniforms: nodeUniforms,
  vertexShader: `
    varying vec3 vNormal;
    void main() {
      vNormal = normalMatrix * normal;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform float uOpacity;
    varying vec3 vNormal;
    void main() {
      vec3 n = normalize(vNormal);
      float facing = max(0.0, n.z);
      float core = pow(facing, 0.35);
      float rim = pow(1.0 - facing, 2.8);
      vec3 coreColor = vec3(0.78, 0.93, 1.0);
      vec3 rimColor  = vec3(0.18, 0.48, 1.0);
      vec3 color = coreColor * core + rimColor * rim;
      float alpha = (core * 0.9 + rim * 0.55) * uOpacity;
      gl_FragColor = vec4(color, alpha);
    }
  `,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
})

// --- Edge material: animated flow particles along each segment ---
const edgeUniforms = { uTime: { value: 0.0 }, uOpacity: { value: 0.0 } }
const lineMaterial = new THREE.ShaderMaterial({
  uniforms: edgeUniforms,
  vertexShader: `
    attribute float aLineProgress;
    varying float vProgress;
    void main() {
      vProgress = aLineProgress;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform float uTime;
    uniform float uOpacity;
    varying float vProgress;
    void main() {
      // Two offset flow particles per edge
      float flow1 = fract(vProgress - uTime * 0.35);
      float flow2 = fract(vProgress - uTime * 0.35 + 0.55);
      float p1 = smoothstep(0.0, 0.12, flow1) * smoothstep(0.28, 0.12, flow1);
      float p2 = smoothstep(0.0, 0.10, flow2) * smoothstep(0.22, 0.10, flow2) * 0.55;
      float base = 0.06;
      float brightness = base + p1 + p2;
      vec3 color = mix(vec3(0.22, 0.48, 0.92), vec3(0.82, 0.94, 1.0), (p1 + p2));
      gl_FragColor = vec4(color, brightness * uOpacity);
    }
  `,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
})

// --- Build Three.js objects imperatively ---
const group = new THREE.Group()

const nodeGeometry = new THREE.SphereGeometry(NODE_RADIUS, 12, 12)
const nodeMeshes: THREE.Mesh[] = startPositions.map((pos) => {
  const mesh = new THREE.Mesh(nodeGeometry, nodeMaterial)
  mesh.position.copy(pos)
  group.add(mesh)
  return mesh
})

// Edge geometry with static aLineProgress attribute (0 at line start, 1 at line end)
const linePositionArray = new Float32Array(edgePairs.length * 2 * 3)
const lineGeometry = new THREE.BufferGeometry()
lineGeometry.setAttribute('position', new THREE.BufferAttribute(linePositionArray, 3))

const progressArray = new Float32Array(edgePairs.length * 2)
edgePairs.forEach((_, idx) => {
  progressArray[idx * 2] = 0.0
  progressArray[idx * 2 + 1] = 1.0
})
lineGeometry.setAttribute('aLineProgress', new THREE.BufferAttribute(progressArray, 1))

const lineSegments = new THREE.LineSegments(lineGeometry, lineMaterial)
group.add(lineSegments)

// --- Render loop: all mutations happen synchronously with render ---
const { onBeforeRender } = useLoop()
onBeforeRender(({ elapsed }) => {
  const { graphT, convergeT } = props

  // Opacity: pulse during graph drift, hold during early convergence, fade during late convergence
  let opacity: number
  if (convergeT > 0.5) {
    opacity = 1 - easeOutCubic(Math.min(1, (convergeT - 0.5) / 0.45))
  }
  else if (convergeT > 0) {
    opacity = 1
  }
  else {
    opacity = 0.5 + 0.5 * Math.sin(elapsed * 2.2)
  }

  nodeUniforms.uOpacity.value = opacity
  edgeUniforms.uOpacity.value = opacity * 0.65
  edgeUniforms.uTime.value = elapsed

  // Node positions: drift → converge
  for (let i = 0; i < NODE_COUNT; i++) {
    if (convergeT > 0) {
      nodeMeshes[i].position.lerpVectors(driftPositions[i], origin, easeInOutQuart(convergeT))
    }
    else {
      nodeMeshes[i].position.lerpVectors(startPositions[i], driftPositions[i], easeOutCubic(graphT))
    }
  }

  // Sync edge line positions to current node positions
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
