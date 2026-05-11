// https://nuxt.com/docs/api/configuration/nuxt-config

const themeBootstrapScript = '(function(){var theme="dark";try{theme=localStorage.getItem("theme")==="light"?"light":"dark"}catch(e){}document.documentElement.setAttribute("data-theme",theme);document.documentElement.style.colorScheme=theme})()'

export default defineNuxtConfig({
  modules: ['@nuxtjs/tailwindcss', '@nuxt/eslint', '@gvade/nuxt3-svg-sprite', '@vueuse/nuxt', '@sentry/nuxt/module'],
  ssr: false,

  components: [
    {
      path: '~/components',
      pathPrefix: false,
    },
  ],

  imports: {
    dirs: [
      'composables/*/index.{ts,js,mjs,mts}',
    ],
  },
  devtools: {
    enabled: true,

    timeline: {
      enabled: true,
    },
  },

  app: {
    pageTransition: { name: 'page', mode: 'out-in' },
    head: {
      title: 'Euler Lite',
      htmlAttrs: {
        'lang': 'en',
        'data-theme': 'dark',
      },
      script: [
        {
          id: 'theme-bootstrap',
          innerHTML: themeBootstrapScript,
          tagPosition: 'head',
          tagPriority: 'critical',
        },
      ],
      meta: [
        {
          name: 'description',
          content: 'Lightweight interface for Euler Finance lending and borrowing.',
        },
        { charset: 'utf-8' },
        {
          name: 'viewport',
          content: 'width=device-width, initial-scale=1, user-scalable=no',
        },
        {
          property: 'og:title',
          content: 'Euler Lite',
        },
        {
          property: 'og:description',
          content: 'Lightweight interface for Euler Finance lending and borrowing.',
        },
        {
          property: 'og:type',
          content: 'website',
        },
        // og:image / twitter:image are injected at SSR by
        // server/plugins/app-config.ts from NUXT_PUBLIC_CONFIG_SOCIAL_IMAGE_URL.
        // Not declared here so forks without that env var get no (broken) tag.
        // twitter:card is set to summary_large_image because our share image
        // is landscape (1200x630+); forks without an image will see a basic
        // link preview — configure NUXT_PUBLIC_CONFIG_SOCIAL_IMAGE_URL to enable.
        {
          name: 'twitter:card',
          content: 'summary_large_image',
        },
        {
          name: 'twitter:title',
          content: 'Euler Lite',
        },
        {
          name: 'twitter:description',
          content: 'Lightweight interface for Euler Finance lending and borrowing.',
        },
        {
          name: 'theme-color',
          content: '#efeef4',
        },
      ],
      link: [
        {
          rel: 'preconnect',
          href: 'https://fonts.reown.com',
          crossorigin: 'anonymous',
        },
        {
          rel: 'icon',
          href: '/favicons/favicon.ico',
        },
        {
          rel: 'shortcut icon',
          href: '/favicons/favicon.ico',
        },
      ],
    },
  },

  css: ['~/assets/styles/main.scss'],

  runtimeConfig: {
    public: {
      // CONFIG_ vars (Doppler: NUXT_PUBLIC_CONFIG_*)
      configDocsUrl: '',
      configStargateUrl: '',
      configTosUrl: '',
      configTosMdUrl: '',
      configPrivacyPolicyUrl: '',
      configRiskDisclosuresUrl: '',
      configMicaWhitepaperUrl: '',
      configXUrl: '',
      configDiscordUrl: '',
      configTelegramUrl: '',
      configGithubUrl: '',
      configAppTitle: 'Euler Lite',
      configAppDescription: 'Lightweight interface for Euler Finance lending and borrowing.',
      // Absolute URL to an image used for social share previews (og:image /
      // twitter:image). Empty default so forks don't inherit our branding.
      configSocialImageUrl: '',
      configLabelsRepo: 'euler-xyz/euler-labels',
      configLabelsRepoBranch: 'master',
      configOracleChecksRepo: 'euler-xyz/oracle-checks',
      configLabelsBaseUrl: '',
      configOracleChecksBaseUrl: '',
      configEulerChainsUrl: '',
      // Feature flags: enabled by default. Set to 'false' to disable.
      configEnableEntityBranding: '',
      configEnableVaultType: '',
      configEnableEarnPage: '',
      configEnableLendPage: '',
      configEnableExplorePage: '',
      configEnablePoweredByEuler: '',
      configEnableAppTitle: '',
      // Incentives provider flags: enabled by default. Set to 'false' to disable.
      configEnableMerkl: '',
      configEnableIncentra: '',
      configEnableFuul: '',
      // Migration announcement: set to a tweet/announcement URL to show a
      // one-time modal explaining the app upgrade. Empty = disabled (default).
      configMigrationAnnouncementUrl: '',
      // Migration: link to the legacy app shown in the header dropdown.
      // Empty = no link rendered (default).
      configMigrationLegacyAppUrl: '',
      // External token list URLs for swap token selector
      configUniswapTokenListUrl: '',
      configDefillamaTokenListUrl: '',
      // Env config fallbacks (Doppler: NUXT_PUBLIC_*)
      // Prefer window.__APP_CONFIG__ at runtime; these are build-time fallbacks.
      appKitProjectId: '',
      appUrl: '',
      pythHermesUrl: '',
      eulerApiUrl: '',
      swapApiUrl: '',
      sentryDsn: '', // set via NUXT_PUBLIC_SENTRY_DSN
    },
  },

  sourcemap: {
    server: false,
    client: process.env.SENTRY_AUTH_TOKEN ? 'hidden' : false,
  },

  devServer: {
    // Only enable HTTPS if both key and cert are provided
    ...(process.env.HTTPS_KEY && process.env.HTTPS_CERT
      ? {
          https: {
            key: process.env.HTTPS_KEY,
            cert: process.env.HTTPS_CERT,
          },
        }
      : {}),
  },

  experimental: {
    // Reload the app immediately when any chunk fails to load (including
    // lazy components outside route navigation). 'automatic-immediate'
    // enables Nuxt's built-in chunk-reload-immediate.client plugin which
    // calls reloadNuxtApp({ persistState: true }) on app:chunkError, with
    // a 10s TTL guard to prevent reload loops. Primary recovery path for
    // "Failed to fetch dynamically imported module" errors after deploys.
    emitRouteChunkError: 'automatic-immediate',
  },

  compatibilityDate: '2024-08-29',

  nitro: {
    compressPublicAssets: true,
    esbuild: { options: { target: 'esnext' } },
    routeRules: {
      // Hashed build assets are content-addressed and safe to cache forever
      // at both the browser and the CDN. CDN-Cache-Control must be set here
      // explicitly — Nitro merges route rules with defu, so the catch-all
      // 'no-store' below would otherwise leak onto /_nuxt/* and disable
      // edge caching for every chunk.
      '/_nuxt/**': {
        headers: {
          'Cache-Control': 'public, max-age=31536000, immutable',
          'CDN-Cache-Control': 'public, max-age=31536000, immutable',
          'Cloudflare-CDN-Cache-Control': 'public, max-age=31536000, immutable',
        },
      },
      // HTML and API responses must not be cached by browsers or CDNs — stale
      // HTML referencing previous-build chunk hashes is the primary cause of
      // "Failed to fetch dynamically imported module" errors after deploys.
      // CDN-Cache-Control is honoured by compliant CDNs and overrides any
      // edge-side cache rules that may ignore the origin Cache-Control.
      '/**': {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'CDN-Cache-Control': 'no-store',
          'Cloudflare-CDN-Cache-Control': 'no-store',
        },
      },
    },
  },

  vite: {
    build: { target: 'esnext' },
    optimizeDeps: { esbuildOptions: { target: 'esnext' } },
  },

  telemetry: false,
  eslint: { config: { stylistic: true } },

  ...(process.env.SENTRY_AUTH_TOKEN
    ? {
        sentry: {
          sourceMapsUploadOptions: {
            org: 'euler',
            project: 'euler-lite',
            authToken: process.env.SENTRY_AUTH_TOKEN,
            sourcemaps: {
              filesToDeleteAfterUpload: ['**/*.map'],
            },
          },
        },
      }
    : {}),

  svgSprite: {
    elementClass: 'icon',
  },
})
