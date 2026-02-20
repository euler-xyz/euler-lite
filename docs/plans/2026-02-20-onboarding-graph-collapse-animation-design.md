# Onboarding — Graph Collapse Enter Animation

**Date:** 2026-02-20
**Branch:** malay/design-updates

## Concept

The Euler vault network from the Explore page is the logo's *origin*. A field of floating glowing nodes (matching the visual language of `DiscoveryMarketGraph`) drifts into the scene, collapses magnetically toward the origin, and crystallizes into the 3D Euler logo. Dispersed liquidity consolidating into a vault.

## Animation Sequence

| Phase | Duration | Description |
|---|---|---|
| **Graph field** | 0 – 0.8s | 12–16 node spheres drift in from outside the frustum with pulsing connection edges |
| **Convergence** | 0.8 – 1.4s | Nodes accelerate toward origin via exponential pull; edges contract with them |
| **Crystallization** | 1.4 – 1.6s | Nodes/edges dissolve out; GLB model dissolves in via GLSL noise-threshold reveal |
| **Idle** | 1.6s+ | Existing rotation + float animation takes over |

## Architecture

### Components

- **`BaseEulerModelGraph.vue`** — new component, sibling to `BaseEulerModelMesh` inside `BaseEulerModel.vue`. Renders the node spheres and edge lines. Unmounts or hides after crystallization phase ends.
- **`BaseEulerModelMesh.vue`** — gains a `uReveal` uniform (0→1) driving a noise-based GLSL dissolve-in on the model's materials.
- **`BaseEulerModel.vue`** — owns a shared `animPhase` computed from `elapsed`; passes it as props to both children.

### State

All animation state is local to `BaseEulerModel.vue`. No external store or `onboarding.vue` changes needed.

```
elapsed (from useLoop)
  └─ animPhase: 'graph' | 'converge' | 'crystallize' | 'idle'
       ├─ → BaseEulerModelGraph (node positions, edge opacity)
       └─ → BaseEulerModelMesh (uReveal uniform)
```

### Shader

`BaseEulerModelMesh` applies a custom `ShaderMaterial` (or overrides via `onBeforeCompile`) with:

```glsl
// fragment — dissolve reveal
float noise = /* 3D simplex or value noise at worldPos */;
float threshold = uReveal; // 0 → 1
if (noise > threshold) discard;
```

When `uReveal === 1.0` the full model is visible and the shader can be swapped back to the original material.

### Node Graph

- 12–16 `TresMesh` sphere instances (radius ~0.04) with emissive material
- Edge lines via `TresLine` / `LineSegments` connecting nearby node pairs
- Starting positions: random points on a sphere of radius ~2.5 (outside frustum)
- Target: origin `[0, 0, 0]`
- Position interpolation: `pos = mix(start, target, easeInExpo(t))` where `t` goes 0→1 over the convergence phase

## Files Changed

| File | Change |
|---|---|
| `components/base/BaseEulerModel.vue` | Add phase tracking, render `BaseEulerModelGraph`, pass props |
| `components/base/BaseEulerModelMesh.vue` | Add `uReveal` dissolve shader |
| `components/base/BaseEulerModelGraph.vue` | New — node spheres + edge lines |
