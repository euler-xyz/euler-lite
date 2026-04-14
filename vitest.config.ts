import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '~': resolve(__dirname),
      '@': resolve(__dirname),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    globals: true,
    setupFiles: ['./tests/setup.ts'],
  },
})
