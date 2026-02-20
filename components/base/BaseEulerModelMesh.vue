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

// Declarations: hash, cell helpers
const FRAG_DECL = `
varying vec3 vWorldPos;
uniform float uReveal;

float _h1(vec3 p) {
  p = fract(p * vec3(443.8975, 397.2973, 491.1871));
  p += dot(p.zxy, p.yxz + 19.19);
  return fract(p.x * p.y * p.z);
}

// Warp world-space coords so cells are irregular, not grid-aligned
vec3 _warp(vec3 p) {
  return p + vec3(
    sin(p.y * 4.1 + p.z * 2.3) * 0.09,
    sin(p.z * 3.7 + p.x * 2.8) * 0.09,
    sin(p.x * 4.5 + p.y * 1.9) * 0.09
  );
}
`

// Early discard: cell-based shard reveal.
// Each cell (quantised warped-space position) gets a unique reveal time
// that blends radial distance (center-first) with per-cell randomness.
const FRAG_EARLY_DISCARD = `
if (uReveal < 0.9999) {
  const float _S = 4.5;
  vec3 _wp = _warp(vWorldPos);
  vec3 _cell = floor(_wp * _S);
  float _cid  = _h1(_cell);
  float _rad  = length(vWorldPos) / 1.75;
  // 65% radial (center first) + 35% per-cell randomness
  float _when = mix(_rad, _cid, 0.35);
  if (_when > uReveal * 1.06) discard;
}
`

// Kintsugi gold seams: injected after fog_fragment (gl_FragColor is set).
// Two layers:
//   1. Wave glow  — bright gold burns along seams as the wavefront sweeps past
//   2. Residual   — faint permanent gold seam once the shard has settled
const FRAG_EDGE_GLOW = `
{
  const float _S = 4.5;
  vec3 _wp = _warp(vWorldPos);
  vec3 _cf = fract(_wp * _S);

  // How close to any cell face (0 = on edge, 0.5 = cell centre)
  float _ex = min(_cf.x, 1.0 - _cf.x);
  float _ey = min(_cf.y, 1.0 - _cf.y);
  float _ez = min(_cf.z, 1.0 - _cf.z);
  float _edgeness = min(_ex, min(_ey, _ez));
  float _onEdge = 1.0 - smoothstep(0.0, 0.055, _edgeness);

  // This cell's reveal time (same formula as discard)
  vec3 _cell = floor(_wp * _S);
  float _cid  = _h1(_cell);
  float _rad  = length(vWorldPos) / 1.75;
  float _when = mix(_rad, _cid, 0.35);

  // Wave proximity: brightest right as the wavefront crosses this cell
  float _waveDist = abs(_when - uReveal);
  float _wave = smoothstep(0.28, 0.0, _waveDist) * smoothstep(0.0, 0.04, uReveal);

  // Residual seam: fades from strong → subtle as reveal completes
  float _residual = _onEdge * mix(0.22, 0.055, smoothstep(0.6, 1.0, uReveal));

  // Gold palette: deep amber core → bright yellow-white at peak
  vec3 _goldDeep   = vec3(0.9,  0.55, 0.02);
  vec3 _goldBright = vec3(1.0,  0.92, 0.45);
  vec3 _goldColor  = mix(_goldDeep, _goldBright, _wave);

  float _intensity = _onEdge * _wave * 5.5 + _residual;
  gl_FragColor.rgb += _goldColor * _intensity;
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

  // Always rotate so dissolve → idle transition is seamless
  model.value.rotation.y = elapsed * 0.4
  // Only float once fully revealed
  if (props.reveal >= 1) {
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
