<script setup lang="ts">
import { useLoop } from '@tresjs/core'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import * as THREE from 'three'

const props = defineProps<{
  reveal: number // 0 = invisible, 1 = fully visible
}>()

const model = shallowRef<THREE.Group | null>(null)
const revealUniforms: Array<{ uReveal: { value: number } }> = []

// --- Shader snippets injected via onBeforeCompile ---

const VERT_DECL = `
varying vec3 vWorldPos;
`
const VERT_WORLD_POS = `
vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
`

// Declarations + noise function in fragment common block
const FRAG_DECL = `
varying vec3 vWorldPos;
uniform float uReveal;

float _hash3(vec3 p) {
  p = fract(p * vec3(443.8975, 397.2973, 491.1871));
  p += dot(p.zxy, p.yxz + 19.19);
  return fract(p.x * p.y * p.z);
}
`

// Early discard at start of main() — radial reveal: center appears first, then outward.
// Small noise on the threshold creates an organic, slightly fuzzy crystallization edge.
const FRAG_EARLY_DISCARD = `
if (uReveal < 0.9999) {
  float _r = length(vWorldPos);
  float _noise = _hash3(vWorldPos * 9.0) * 0.16;
  if (_r + _noise > uReveal * 1.75) discard;
}
`

// Edge glow: injected just before main() closes (after fog_fragment).
// Creates a blue crystallization boundary that tracks the reveal wavefront.
const FRAG_EDGE_GLOW = `
if (uReveal > 0.01 && uReveal < 0.985) {
  float _r2 = length(vWorldPos);
  float _wave = uReveal * 1.75;
  float _dist = _wave - _r2;
  if (_dist > 0.0 && _dist < 0.18) {
    float _glow = pow(1.0 - _dist / 0.18, 1.8) * (1.0 - uReveal * 0.4);
    gl_FragColor.rgb += vec3(0.15, 0.45, 1.0) * _glow * 3.0;
  }
}
`

function applyDissolveShader(mesh: THREE.Mesh) {
  const uniforms = { uReveal: { value: props.reveal } }
  revealUniforms.push(uniforms)

  const mat = mesh.material as THREE.MeshStandardMaterial
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uReveal = uniforms.uReveal

    // Vertex: world position varying
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_DECL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_WORLD_POS}`)

    // Fragment: declarations, early discard, edge glow
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_DECL}`)
      .replace('void main() {', `void main() {\n${FRAG_EARLY_DISCARD}`)
      .replace('#include <fog_fragment>', `#include <fog_fragment>\n${FRAG_EDGE_GLOW}`)
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

    m.traverse((child) => {
      if ((child as THREE.Mesh).isMesh)
        applyDissolveShader(child as THREE.Mesh)
    })

    const group = new THREE.Group()
    group.add(m)
    model.value = group
  },
  undefined,
  err => console.error('[EulerModel] load error:', err),
)

// --- Render loop ---
const { onBeforeRender } = useLoop()
onBeforeRender(({ elapsed }) => {
  for (const u of revealUniforms)
    u.uReveal.value = props.reveal

  if (!model.value) return

  if (props.reveal >= 1) {
    model.value.rotation.y = elapsed * 0.4
    model.value.position.y = Math.sin(elapsed * 0.6) * 0.06
  }
})
</script>

<template>
  <primitive
    v-if="model"
    :object="model"
  />
</template>
