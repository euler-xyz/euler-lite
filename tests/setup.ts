/**
 * Vitest setup: stub Nitro / Nuxt auto-imports that are injected by
 * unimport at build time but absent under plain Node/vitest.
 *
 * Keeping this surface minimal: add a stub only when a test imports a
 * server/ module that calls one of these globals at module top level.
 */

import { computed, reactive, readonly, ref, shallowReactive, shallowRef, watch, watchEffect, type Ref } from 'vue'

type AnyFn = (...args: unknown[]) => unknown

const g = globalThis as unknown as Record<string, unknown>

if (!g.defineEventHandler) {
  g.defineEventHandler = (fn: AnyFn) => fn
}
if (!g.defineNitroPlugin) {
  g.defineNitroPlugin = (fn: AnyFn) => fn
}

// Vue reactivity primitives Nuxt auto-imports. Required by any app/ module
// loaded from a test (composables, entities, utils, etc.)
const vueGlobals: Record<string, unknown> = {
  ref,
  shallowRef,
  reactive,
  shallowReactive,
  readonly,
  computed,
  watch,
  watchEffect,
}
for (const [key, value] of Object.entries(vueGlobals)) {
  if (g[key] === undefined) g[key] = value
}

if (!g.useState) {
  const state = new Map<string, Ref<unknown>>()
  g.useState = (key: string, init: () => unknown) => {
    let entry = state.get(key)
    if (!entry) {
      entry = ref(init())
      state.set(key, entry)
    }
    return entry
  }
}

// Pending-submission replay protection is durable-or-abort: without a working
// localStorage every wallet-boundary reservation would throw. Node exposes a
// `localStorage` accessor that can exist yet return undefined, so install a
// Map-backed polyfill via defineProperty when no usable storage is present.
const hasUsableLocalStorage = (() => {
  try {
    return typeof globalThis.localStorage?.setItem === 'function'
  }
  catch {
    return false
  }
})()
if (!hasUsableLocalStorage) {
  const backing = new Map<string, string>()
  const storagePolyfill: Storage = {
    get length() {
      return backing.size
    },
    clear: () => backing.clear(),
    getItem: (key: string) => backing.get(key) ?? null,
    key: (index: number) => [...backing.keys()][index] ?? null,
    removeItem: (key: string) => {
      backing.delete(key)
    },
    setItem: (key: string, value: string) => {
      backing.set(key, String(value))
    },
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: storagePolyfill,
    configurable: true,
    writable: true,
  })
}
