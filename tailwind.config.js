/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.vue',
    './components/layout/**/*.vue',
    './components/base/**/*.vue',
    './components/entities/**/*.vue',
    './app.vue',
    './error.vue',
    '!./components/ui/**/*.vue',
  ],

  theme: {
    extend: {
      spacing: {
        ...Object.fromEntries(
          Array.from({ length: 101 }, (_, i) => [i, `${i}px`]),
        ),
      },

      colors: {
        // ============================================
        // SEMANTIC THEME-AWARE COLORS
        // These reference CSS variables that change with theme
        // ============================================

        // Backgrounds
        'surface': 'var(--bg-surface)',
        'surface-secondary': 'var(--bg-surface-secondary)',
        'surface-elevated': 'var(--bg-surface-elevated)',
        'body': 'var(--bg-body)',
        'card': 'var(--bg-card)',
        'card-hover': 'var(--bg-card-hover)',
        'header': 'var(--bg-header)',

        // Text (use as text-primary, text-secondary, etc.)
        'content': {
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          tertiary: 'var(--text-tertiary)',
          muted: 'var(--text-muted)',
          inverse: 'var(--text-inverse)',
          accent: 'var(--text-accent)',
        },

        // Borders (use as border-default, border-subtle, etc.)
        'line': {
          default: 'var(--border-default)',
          subtle: 'var(--border-subtle)',
          emphasis: 'var(--border-emphasis)',
        },

        // ============================================
        // RAW PALETTE COLORS (for specific use cases)
        // ============================================

        // Brand palette
        'primary': {
          50: 'var(--primary-50)',
          100: 'var(--primary-100)',
          200: 'var(--primary-200)',
          300: 'var(--primary-300)',
          400: 'var(--primary-400)',
          500: 'var(--primary-500)',
          600: 'var(--primary-600)',
          700: 'var(--primary-700)',
          800: 'var(--primary-800)',
          900: 'var(--primary-900)',
        },
        'accent': {
          100: 'var(--accent-100)',
          300: 'var(--accent-300)',
          400: 'var(--accent-400)',
          500: 'var(--accent-500)',
          600: 'var(--accent-600)',
          700: 'var(--accent-700)',
        },
        'neutral': {
          50: 'var(--neutral-50)',
          100: 'var(--neutral-100)',
          200: 'var(--neutral-200)',
          300: 'var(--neutral-300)',
          400: 'var(--neutral-400)',
          500: 'var(--neutral-500)',
          600: 'var(--neutral-600)',
          700: 'var(--neutral-700)',
          800: 'var(--neutral-800)',
          900: 'var(--neutral-900)',
        },
        'success': {
          100: 'var(--success-100)',
          500: 'var(--success-500)',
          600: 'var(--success-600)',
        },
        'warning': {
          100: 'var(--warning-100)',
          500: 'var(--warning-500)',
        },
        'error': {
          100: 'var(--error-100)',
          500: 'var(--error-500)',
        },
      },

      screens: {
        mobile: { max: '900px' },
        laptop: { min: '901px' },
        tablet: { min: '1300px' },
      },

      borderRadius: {
        8: '8px',
        12: '12px',
        16: '16px',
      },

      fontSize: {
        h1: ['32px', { lineHeight: '40px', fontWeight: '600' }],
        h2: ['24px', { lineHeight: '32px', fontWeight: '600' }],
        h3: ['20px', { lineHeight: '26px', fontWeight: '600' }],
        h4: ['18px', { lineHeight: '24px', fontWeight: '600' }],
        h5: ['16px', { lineHeight: '20px', fontWeight: '600' }],
        h6: ['14px', { lineHeight: '20px', fontWeight: '600' }],
        p1: ['24px', { lineHeight: '32px', fontWeight: '400' }],
        p2: ['16px', { lineHeight: '20px', fontWeight: '400' }],
        p3: ['14px', { lineHeight: '20px', fontWeight: '400' }],
      },

      maxWidth: {
        'container': '1200px',
        'container-narrow': '800px',
      },

      zIndex: {
        100: '100',
      },

      transitionDuration: {
        default: '250ms',
        slow: '350ms',
        fast: '150ms',
      },

      boxShadow: {
        'xs': 'var(--shadow-xs)',
        'sm': 'var(--shadow-sm)',
        'md': 'var(--shadow-md)',
        'lg': 'var(--shadow-lg)',
        'xl': 'var(--shadow-xl)',
        '2xl': 'var(--shadow-2xl)',
        'button': 'var(--shadow-button)',
        'button-hover': 'var(--shadow-button-hover)',
        'card': 'var(--shadow-card)',
        'card-hover': 'var(--shadow-card-hover)',
        'input': 'var(--ui-input-shadow)',
        'input-focus': 'var(--ui-input-focus-shadow)',
        'form-field': 'var(--ui-form-field-shadow)',
        'form-field-focus': 'var(--ui-form-field-focus-shadow)',
        'accent-glow': 'var(--accent-glow)',
        'accent-sm': 'var(--accent-shadow-sm)',
        'accent-md': 'var(--accent-shadow-md)',
        'accent-lg': 'var(--accent-shadow-lg)',
      },

      backdropBlur: {
        header: '20px',
      },
    },
  },

  plugins: [],
}
