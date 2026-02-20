# Graph Collapse Animation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Animate the Euler 3D logo on the onboarding page with a "graph collapse" entrance — vault network nodes converge into the origin and crystallize into the logo.

**Architecture:** `BaseEulerModel.vue` owns all animation phase state via `elapsed` from TresJS `useLoop`. It passes a `reveal` float (0→1) down to `BaseEulerModelMesh` (which uses it in a GLSL dissolve shader via `onBeforeCompile`) and a `phase`/`progress` object down to a new `BaseEulerModelGraph` component (which renders instanced node spheres and edge lines). No changes to `onboarding.vue` or any parent.

**Tech Stack:** TresJS (`@tresjs/core`), Three.js (`three`), Vue 3 `<script setup>`, GLSL via `onBeforeCompile`

---

## Phase Timing Reference

```
0.0s ──── 0.8s ──── 1.4s ──── 1.6s ──── ∞
 graph      converge   crystal   idle
```

```ts
const GRAPH_END      = 0.8
const CONVERGE_END   = 1.4
const CRYSTAL_END    = 1.6
```

---

## Task 1: Add phase state to BaseEulerModel.vue

**Files:**
- Modify: `components/base/BaseEulerModel.vue`

This task lifts animation phase tracking into the canvas root and provides `reveal` and `graphProgress` for children. No visual change yet.

**Step 1: Add script block with phase logic**

Replace the current minimal `<script setup>` with:

```vue
<script setup lang="ts">
import { useLoop } from '@tresjs/core'

const GRAPH_END    = 0.8
const CONVERGE_END = 1.4
const CRYSTAL_END  = 1.6

// reveal: 0 = fully dissolved, 1 = fully visible
const reveal = ref(0)

// graphProgress: { graphT: 0→1, convergeT: 0→1, crystalT: 0→1 }
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
```

**Step 2: Update template to pass props and conditionally render graph**

```vue
<template>
  <TresCanvas alpha clear-color="#00000000" :window-size="false">
    <TresOrthographicCamera :position="[0, 0, 5]" :args="[-1.4, 1.4, 1.4, -1.4, 0.1, 100]" />

    <TresAmbientLight :intensity="0.8" />
    <TresDirectionalLight :position="[4, 6, 5]" :intensity="2.5" />
    <TresDirectionalLight :position="[-5, 2, 3]" :intensity="0.8" />
    <TresDirectionalLight :position="[0, -4, -5]" :intensity="0.4" />

    <BaseEulerModelGraph
      v-if="showGraph"
      :graph-t="graphProgress.graphT"
      :converge-t="graphProgress.convergeT"
      :crystal-t="graphProgress.crystalT"
    />
    <BaseEulerModelMesh :reveal="reveal" />
  </TresCanvas>
</template>
```

**Step 3: Verify**

Open the onboarding page in the browser. The 3D model should disappear (reveal starts at 0). No errors in console. `BaseEulerModelGraph` will 404 briefly — that's fine, it's added in Task 2.

**Step 4: Commit**

```bash
git add components/base/BaseEulerModel.vue
git commit -m "feat: add animation phase state to BaseEulerModel"
```

---

## Task 2: Create BaseEulerModelGraph.vue

**Files:**
- Create: `components/base/BaseEulerModelGraph.vue`

Renders 14 glowing nodes on a sphere of radius 2.5 + connecting edges. During `graphT` phase nodes drift slowly inward. During `convergeT` they accelerate to origin with `easeInExpo`. During `crystalT` everything fades out.

**Step 1: Create the component**

```vue
<script setup lang="ts">
import * as THREE from 'three'

const props = defineProps<{
  graphT: number      // 0→1: initial drift phase
  convergeT: number   // 0→1: convergence phase
  crystalT: number    // 0→1: crystallize / fade-out phase
}>()

const NODE_COUNT = 14
const START_RADIUS = 2.5   // outside orthographic frustum (frustum half-width = 1.4)
const DRIFT_RADIUS = 1.6   // where nodes settle during graph phase
const NODE_RADIUS = 0.045

// --- Fibonacci sphere: evenly distributed starting positions ---
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

// --- Easing ---
function easeInExpo(t: number): number {
  return t === 0 ? 0 : Math.pow(2, 10 * t - 10)
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

// --- Reactive node positions ---
const nodePositions = ref<THREE.Vector3[]>(startPositions.map(p => p.clone()))

// --- Edge pairs: connect each node to its 2 nearest neighbours ---
function buildEdges(positions: THREE.Vector3[]): [number, number][] {
  const edges: [number, number][] = []
  for (let i = 0; i < positions.length; i++) {
    const distances = positions
      .map((p, j) => ({ j, d: j === i ? Infinity : positions[i].distanceTo(p) }))
      .sort((a, b) => a.d - b.d)
    for (let k = 0; k < 2; k++) {
      const j = distances[k].j
      if (!edges.some(([a, b]) => (a === i && b === j) || (a === j && b === i))) {
        edges.push([i, j])
      }
    }
  }
  return edges
}

const edgePairs = buildEdges(driftPositions)

// --- Line geometry (updated each frame via BufferAttribute) ---
const lineGeometry = new THREE.BufferGeometry()
const linePositionArray = new Float32Array(edgePairs.length * 2 * 3)
lineGeometry.setAttribute('position', new THREE.BufferAttribute(linePositionArray, 3))

const lineMaterial = new THREE.LineBasicMaterial({
  color: 0x60a5fa, // blue-400, close to Euler accent
  transparent: true,
  opacity: 0.5,
  depthWrite: false,
})

const lineSegments = new THREE.LineSegments(lineGeometry, lineMaterial)

// --- Node material ---
const nodeMaterial = new THREE.MeshBasicMaterial({
  color: 0x93c5fd, // blue-300
  transparent: true,
  opacity: 0.9,
})

// --- Update positions each frame via watch ---
watch(
  () => [props.graphT, props.convergeT, props.crystalT] as const,
  ([gT, cvT, crT]) => {
    const opacity = crT > 0 ? 1 - easeOutCubic(crT) : 1
    nodeMaterial.opacity = opacity * 0.9
    lineMaterial.opacity = opacity * 0.5

    for (let i = 0; i < NODE_COUNT; i++) {
      const start = startPositions[i]
      const drift = driftPositions[i]
      let pos: THREE.Vector3

      if (cvT > 0) {
        // Converge: drift → origin
        pos = drift.clone().lerp(origin, easeInExpo(cvT))
      }
      else {
        // Graph drift: start → drift
        pos = start.clone().lerp(drift, easeOutCubic(gT))
      }
      nodePositions.value[i].copy(pos)
    }

    // Update edge line geometry
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
  <!-- Edge lines -->
  <primitive :object="lineSegments" />

  <!-- Node spheres -->
  <TresMesh
    v-for="(pos, i) in nodePositions"
    :key="i"
    :position="[pos.x, pos.y, pos.z]"
  >
    <TresSphereGeometry :args="[NODE_RADIUS, 8, 8]" />
    <primitive :object="nodeMaterial" />
  </TresMesh>
</template>
```

**Step 2: Verify in browser**

Open onboarding. You should see ~14 small blue spheres connected by lines drifting into a sphere formation, then rushing toward the center. The 3D model is still invisible (reveal=0 from Task 1).

**Step 3: Commit**

```bash
git add components/base/BaseEulerModelGraph.vue
git commit -m "feat: add BaseEulerModelGraph node/edge animation"
```

---

## Task 3: Add dissolve shader to BaseEulerModelMesh.vue

**Files:**
- Modify: `components/base/BaseEulerModelMesh.vue`

Accept a `reveal` prop (0→1). When the model loads, walk every mesh in the scene and inject a GLSL dissolve via `onBeforeCompile`. The shader discards fragments where a hash-noise value exceeds `uReveal`. `uReveal` is updated reactively each frame.

**Step 1: Understand the existing code**

The current file loads a GLB, centers it, wraps in a group, and animates rotation + float in `onBeforeRender`. The `model` ref holds the wrapper `THREE.Group`.

**Step 2: Rewrite the component**

```vue
<script setup lang="ts">
import { useLoop } from '@tresjs/core'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import * as THREE from 'three'

const props = defineProps<{
  reveal: number // 0 = invisible, 1 = fully visible
}>()

const model = shallowRef<THREE.Group | null>(null)

// --- GLSL dissolve injection ---
// We track all uReveal uniforms so we can update them reactively
const revealUniforms: Array<{ uReveal: { value: number } }> = []

const VERT_INJECT = `
varying vec3 vWorldPos;
`
const VERT_MAIN_INJECT = `
vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
`
const FRAG_INJECT = `
varying vec3 vWorldPos;
uniform float uReveal;

float hash3(vec3 p) {
  p = fract(p * vec3(443.8975, 397.2973, 491.1871));
  p += dot(p.zxy, p.yxz + 19.19);
  return fract(p.x * p.y * p.z);
}
`
const FRAG_MAIN_INJECT = `
if (uReveal < 0.9999 && hash3(vWorldPos * 6.0) > uReveal) discard;
`

function applyDissolveShader(mesh: THREE.Mesh) {
  const uniforms = { uReveal: { value: props.reveal } }
  revealUniforms.push(uniforms)

  const mat = mesh.material as THREE.MeshStandardMaterial
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uReveal = uniforms.uReveal
    // Vertex: inject varying declaration + world position
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_INJECT}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_MAIN_INJECT}`)
    // Fragment: inject hash function + discard logic
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_INJECT}`)
      .replace('void main() {', `void main() {\n${FRAG_MAIN_INJECT}`)
  }
  mat.needsUpdate = true
}

// --- Load GLB ---
const draco = new DRACOLoader()
draco.setDecoderPath('/draco/')
draco.preload()

const loader = new GLTFLoader()
loader.setDRACOLoader(draco)

loader.load(
  '/3d/euler.glb',
  (gltf) => {
    const m = gltf.scene

    const box = new THREE.Box3().setFromObject(m)
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const scale = 2.2 / Math.max(size.x, size.y, size.z)

    m.scale.setScalar(scale)
    m.position.set(-center.x * scale, -center.y * scale, -center.z * scale)

    // Apply dissolve shader to every mesh
    m.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        applyDissolveShader(child as THREE.Mesh)
      }
    })

    const group = new THREE.Group()
    group.add(m)
    model.value = group
  },
  undefined,
  err => console.error('[EulerModel] load error:', err),
)

// --- Animation loop: idle rotation + float + sync uReveal ---
const { onBeforeRender } = useLoop()
onBeforeRender(({ elapsed }) => {
  // Sync dissolve uniforms
  for (const u of revealUniforms) {
    u.uReveal.value = props.reveal
  }

  if (!model.value) return

  // Only rotate/float once fully revealed
  if (props.reveal >= 1) {
    model.value.rotation.y = elapsed * 0.4
    model.value.position.y = Math.sin(elapsed * 0.6) * 0.06
  }
})
</script>

<template>
  <primitive v-if="model" :object="model" />
</template>
```

**Step 3: Verify in browser**

Full animation should now play:
1. Blue node spheres + edges drift in and form a sphere (~0.8s)
2. Nodes rush to center (~0.6s)
3. Nodes fade out, logo dissolves in with noise (~0.2s)
4. Logo rotates and floats as before

**Step 4: Tweak if needed**

- If dissolve looks too grainy, lower the `6.0` multiplier in `hash3(vWorldPos * 6.0)` (try `3.0`–`4.0`)
- If nodes feel too slow/fast, adjust `GRAPH_END` / `CONVERGE_END` constants in `BaseEulerModel.vue`
- Accent color for nodes: change `0x60a5fa` / `0x93c5fd` to match `--accent-400` / `--accent-300` CSS vars if the project uses a non-blue accent

**Step 5: Commit**

```bash
git add components/base/BaseEulerModelMesh.vue
git commit -m "feat: add dissolve reveal shader to BaseEulerModelMesh"
```

---

## Task 4: Polish — node pulse + edge shimmer

**Files:**
- Modify: `components/base/BaseEulerModelGraph.vue`

Add a slow sine-wave pulse to node opacity during the graph phase so the field feels alive.

**Step 1: Add pulse to node opacity in the watch**

Inside the watch, replace the opacity line:

```ts
// Before:
const opacity = crT > 0 ? 1 - easeOutCubic(crT) : 1

// After:
const pulse = 0.7 + 0.3 * Math.sin(Date.now() * 0.003 + 1.5)
const baseOpacity = crT > 0 ? 1 - easeOutCubic(crT) : (gT < 1 ? pulse : 1)
nodeMaterial.opacity = baseOpacity * 0.9
lineMaterial.opacity = baseOpacity * 0.4
```

**Step 2: Verify**

Nodes should gently pulse in brightness while drifting in. During convergence they snap to full opacity before fading out.

**Step 3: Commit**

```bash
git add components/base/BaseEulerModelGraph.vue
git commit -m "feat: add node pulse to graph field animation"
```

---

## Notes for the implementer

- TresJS auto-imports: `TresMesh`, `TresSphereGeometry`, `TresCanvas`, etc. are all auto-imported — no explicit imports needed in `<script setup>` for Tres* components. `ref`, `reactive`, `watch`, `onUnmounted` are also auto-imported by Nuxt.
- The `onBeforeCompile` approach modifies the compiled shader string — if Three.js updates its built-in shader chunks the string replacements may need adjusting. The strings `#include <common>`, `#include <begin_vertex>`, and `void main() {` are stable across r150+.
- `nodeMaterial` is shared across all node mesh instances. That's intentional — changing `.opacity` on it affects all nodes at once.
- The `<primitive :object="lineMaterial" />` pattern is NOT used here — `lineMaterial` is passed directly to the `THREE.LineSegments` constructor, not as a TresJS component.
