/**
 * Vitest setup: stub Nitro / Nuxt auto-imports that are injected by
 * unimport at build time but absent under plain Node/vitest.
 *
 * Keeping this surface minimal: add a stub only when a test imports a
 * server/ module that calls one of these globals at module top level.
 */

type AnyFn = (...args: unknown[]) => unknown

const g = globalThis as unknown as {
  defineEventHandler?: (fn: AnyFn) => AnyFn
  defineNitroPlugin?: (fn: AnyFn) => AnyFn
}

if (!g.defineEventHandler) {
  g.defineEventHandler = (fn: AnyFn) => fn
}
if (!g.defineNitroPlugin) {
  g.defineNitroPlugin = (fn: AnyFn) => fn
}
