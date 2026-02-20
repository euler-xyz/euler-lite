<script setup lang="ts">
import { useLoop } from '@tresjs/core'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import * as THREE from 'three'

const props = defineProps<{
  reveal: number // 0 = invisible, 1 = fully visible
}>()

const model = shallowRef<THREE.Group | null>(null)

// Track all injected uReveal uniforms to update reactively
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
if (uReveal < 0.9999 && hash3(vWorldPos * 4.0) > uReveal) discard;
`

function applyDissolveShader(mesh: THREE.Mesh) {
  const uniforms = { uReveal: { value: props.reveal } }
  revealUniforms.push(uniforms)

  const mat = mesh.material as THREE.MeshStandardMaterial
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uReveal = uniforms.uReveal
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_INJECT}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_MAIN_INJECT}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_INJECT}`)
      .replace('void main() {', `void main() {\n${FRAG_MAIN_INJECT}`)
  }
  mat.needsUpdate = true
}

// Load GLB with local Draco decoder
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

const { onBeforeRender } = useLoop()
onBeforeRender(({ elapsed }) => {
  // Sync dissolve uniforms every frame
  for (const u of revealUniforms)
    u.uReveal.value = props.reveal

  if (!model.value) return

  // Only animate idle rotation/float once fully revealed
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
