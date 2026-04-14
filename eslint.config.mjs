// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(
  {
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      'eqeqeq': ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
      'no-param-reassign': ['error', { props: false }],
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'vue/require-explicit-emits': 'error',
      'vue/no-unused-refs': 'warn',
      'vue/no-template-target-blank': 'error',
    },
  },
  {
    files: ['server/**', 'scripts/**'],
    rules: {
      'no-console': 'off',
    },
  },
)
