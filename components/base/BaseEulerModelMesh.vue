<script setup lang="ts">
import { useLoop } from '@tresjs/core'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import * as THREE from 'three'

const model = shallowRef<THREE.Group | null>(null)

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

    const group = new THREE.Group()
    group.add(m)
    model.value = group
  },
  undefined,
  err => console.error('[EulerModel] load error:', err),
)

const BASE_Y = (90 * Math.PI) / 180
const { x: mouseX, y: mouseY } = useMouseInElement(document.documentElement)

// Normalized -1 to 1
const nx = computed(() => (mouseX.value / window.innerWidth) * 2 - 1)
const ny = computed(() => (mouseY.value / window.innerHeight) * 2 - 1)

const currentRotY = ref(BASE_Y)
const currentRotX = ref(0)

const { onBeforeRender } = useLoop()
onBeforeRender(({ elapsed, delta }) => {
  if (!model.value) return

  const targetY = BASE_Y + nx.value * 0.35
  const targetX = -ny.value * 0.2

  const t = 1 - Math.pow(0.04, delta)
  currentRotY.value += (targetY - currentRotY.value) * t
  currentRotX.value += (targetX - currentRotX.value) * t

  model.value.rotation.y = currentRotY.value
  model.value.rotation.x = currentRotX.value
  model.value.position.y = Math.sin(elapsed * 0.6) * 0.06
})
</script>

<template>
  <primitive
    v-if="model"
    :object="model"
  />
</template>
