/**
 * Vitest setup for golden tests.
 *
 * The legacy plan builder files (in ../euler-lite-sdk-exec-legacy) rely on
 * Vue composition API and a few Nuxt auto-imports; both worktrees share the
 * same package-lock so the same Vitest config + Vue runtime work for both.
 *
 * We add no logger stubs here — legacy `logWarn` is real, harmless output.
 */

import { computed, reactive, ref, shallowReactive, shallowRef, watch, watchEffect } from 'vue'

type AnyFn = (...args: unknown[]) => unknown

const g = globalThis as unknown as Record<string, unknown>

if (!g.defineEventHandler) {
  g.defineEventHandler = (fn: AnyFn) => fn
}
if (!g.defineNitroPlugin) {
  g.defineNitroPlugin = (fn: AnyFn) => fn
}

const vueGlobals: Record<string, unknown> = {
  ref,
  shallowRef,
  reactive,
  shallowReactive,
  computed,
  watch,
  watchEffect,
}
for (const [key, value] of Object.entries(vueGlobals)) {
  if (g[key] === undefined) g[key] = value
}
