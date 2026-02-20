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

// Declarations: 2D Voronoi helpers (used for organic shard crack patterns)
const FRAG_DECL = `
varying vec3 vWorldPos;
uniform float uReveal;

// 2D hash utilities
vec2 _h22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}
float _h21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// 2D Voronoi — returns (dist_to_nearest_seed, dist_to_edge, cell_id 0-1)
// dist_to_edge is 0 exactly on crack lines, grows into each shard interior
vec3 _vor(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float d1 = 1e5, d2 = 1e5;
  vec2 bi;
  for (int x = -2; x <= 2; x++) {
    for (int y = -2; y <= 2; y++) {
      vec2 n  = vec2(float(x), float(y));
      vec2 pt = _h22(i + n) * 0.8 + 0.1;
      float d = length(n + pt - f);
      if (d < d1) { d2 = d1; d1 = d; bi = i + n; }
      else if (d < d2) { d2 = d; }
    }
  }
  return vec3(d1, d2 - d1, _h21(bi));
}
`

// Early discard: each Voronoi cell assembles at its own time.
// 40% radial bias (center-first, loosely) + 60% per-cell random = organic feel.
const FRAG_EARLY_DISCARD = `
if (uReveal < 0.9999) {
  vec3 _v = _vor(vWorldPos.xy * 2.5);
  float _rad  = length(vWorldPos.xy) / 1.4;
  float _when = mix(_rad, _v.z, 0.6);
  if (_when > uReveal * 1.05) discard;
}
`

// Kintsugi gold seams injected after fog_fragment:
//   Wave glow  — bright gold floods the crack as the shard assembles
//   Residual   — permanent faint gold seam (the repaired crack stays visible)
const FRAG_EDGE_GLOW = `
{
  vec3 _v   = _vor(vWorldPos.xy * 2.5);
  float _rad  = length(vWorldPos.xy) / 1.4;
  float _when = mix(_rad, _v.z, 0.6);

  // Crack mask: 1 on the seam line, 0 in shard interior
  // Thicker seam (0.13) = real lacquer width, not a hairline
  float _seam = 1.0 - smoothstep(0.0, 0.13, _v.y);

  // Wave front: brightest right as the crack fills with gold
  float _wave = smoothstep(0.32, 0.0, abs(_when - uReveal))
              * smoothstep(0.0, 0.05, uReveal);

  // Residual: strong while assembling → settles to subtle permanent seam
  float _residual = _seam * mix(0.28, 0.07, smoothstep(0.55, 1.0, uReveal));

  // Gold palette — deep amber to bright hot gold at the wave peak
  vec3 _goldDeep   = vec3(0.82, 0.48, 0.02);
  vec3 _goldBright = vec3(1.0,  0.88, 0.38);
  vec3 _goldColor  = mix(_goldDeep, _goldBright, _wave);

  gl_FragColor.rgb += _goldColor * (_seam * _wave * 6.0 + _residual);
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

// Track the exact moment reveal completes so idle rotation starts from 0 (no snap)
let revealCompletedAt = -1

// --- Render loop ---
const { onBeforeRender } = useLoop()
onBeforeRender(({ elapsed }) => {
  for (const u of revealUniforms)
    u.uReveal.value = props.reveal

  if (!model.value) return

  if (props.reveal >= 1) {
    // Record the first frame where reveal is complete
    if (revealCompletedAt < 0) revealCompletedAt = elapsed
    const t = elapsed - revealCompletedAt
    model.value.rotation.y = t * 0.4
    model.value.position.y = Math.sin(t * 0.6) * 0.06
  }
  // No rotation during dissolve — world positions stay stable for the crack shader
})
</script>

<template>
  <primitive
    v-if="model"
    :object="model"
  />
</template>
