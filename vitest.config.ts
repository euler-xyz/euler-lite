import { resolve } from 'path'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '~': resolve(__dirname),
      '@': resolve(__dirname),
      '#app': resolve(__dirname, 'tests/stubs/nuxt-app.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**'],
    globals: true,
    setupFiles: ['./tests/setup.ts'],
  },
})
