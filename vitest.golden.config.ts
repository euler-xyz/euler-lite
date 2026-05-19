import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// Golden test config: `~` resolves to the legacy worktree (created via
// `git worktree add ../euler-lite-sdk-exec-legacy HEAD`) so legacy plan
// builder files import their deleted siblings (useEulerOperations,
// evc-converter, saHooksSDK, etc.) from a working tree, not from this
// branch where they've been removed.
//
// Run with:  npx vitest --config vitest.golden.config.ts run
const LEGACY_ROOT = resolve(__dirname, '../euler-lite-sdk-exec-legacy')

export default defineConfig({
  resolve: {
    alias: {
      '~': LEGACY_ROOT,
      '@': LEGACY_ROOT,
      // Local-only alias for the few main-worktree modules the golden
      // tests need (SDK harness, normalizer). Avoids collision with `~`.
      '@golden': resolve(__dirname, 'tests/golden'),
    },
  },
  test: {
    include: ['tests/golden/**/*.test.ts'],
    globals: true,
    setupFiles: ['./tests/golden/setup.ts'],
  },
})
