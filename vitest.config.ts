import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '~': resolve(__dirname),
      '@': resolve(__dirname),
      '#app': resolve(__dirname, 'tests/stubs/nuxt-app.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/golden/**', 'node_modules/**'],
    globals: true,
    setupFiles: ['./tests/setup.ts'],
  },
})
