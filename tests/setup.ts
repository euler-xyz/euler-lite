/**
 * Vitest setup: stub Nitro / Nuxt auto-imports that are injected by
 * unimport at build time but absent under plain Node/vitest.
 *
 * Keeping this surface minimal: add a stub only when a test imports a
 * server/ module that calls one of these globals at module top level.
 */

import { computed, reactive, readonly, ref, shallowReactive, shallowRef, watch, watchEffect, type Ref } from 'vue'
import { beforeEach } from 'vitest'

type AnyFn = (...args: unknown[]) => unknown

const g = globalThis as unknown as Record<string, unknown>
const baseNavigator = globalThis.navigator

beforeEach(() => {
  let held = false
  const locks = {
    request: async (
      name: string,
      _options: LockOptions,
      callback: (lock: Lock | null) => unknown,
    ) => {
      if (held) return callback(null)
      held = true
      try {
        return await callback({ name, mode: 'exclusive' } as Lock)
      }
      finally {
        held = false
      }
    },
  }
  const navigatorWithLocks = Object.create(baseNavigator ?? null)
  Object.defineProperty(navigatorWithLocks, 'locks', {
    configurable: true,
    value: locks,
  })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: navigatorWithLocks,
  })
})

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
