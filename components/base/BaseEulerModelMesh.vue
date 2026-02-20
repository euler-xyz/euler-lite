<script setup lang="ts">
import { useLoop } from '@tresjs/core'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import * as THREE from 'three'

const model = shallowRef<THREE.Group | null>(null)

// Load GLB with local Draco decoder (avoids CDN dependency)
const draco = new DRACOLoader()
draco.setDecoderPath('/draco/')
draco.preload()

const loader = new GLTFLoader()
loader.setDRACOLoader(draco)

loader.load(
  '/3d/euler.glb',
  (gltf) => {
    const m = gltf.scene

    // Compute bounds first, then scale, then re-center so scale doesn't shift it
    const box = new THREE.Box3().setFromObject(m)
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const scale = 2.2 / Math.max(size.x, size.y, size.z)

    m.scale.setScalar(scale)
    // After scaling, the bounding box center shifts by scale – compensate
    m.position.set(-center.x * scale, -center.y * scale, -center.z * scale)

    // Wrap in a group so animation doesn't fight the centering offset
    const group = new THREE.Group()
    group.add(m)
    model.value = group
  },
  undefined,
  err => console.error('[EulerModel] load error:', err),
)

const { onBeforeRender } = useLoop()
onBeforeRender(({ elapsed }) => {
  if (!model.value) return
  // Rotate and float the wrapper group — centering offset stays intact in child
  model.value.rotation.y = elapsed * 0.4
  model.value.position.y = Math.sin(elapsed * 0.6) * 0.06
})
</script>

<template>
  <primitive
    v-if="model"
    :object="model"
  />
</template>
