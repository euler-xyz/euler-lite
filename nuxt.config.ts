// https://nuxt.com/docs/api/configuration/nuxt-config

export default defineNuxtConfig({
  modules: ['@nuxtjs/tailwindcss', '@nuxt/eslint', '@gvade/nuxt3-svg-sprite', '@vueuse/nuxt'],
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
        lang: 'en',
      },
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
        {
          name: 'twitter:card',
          content: 'summary',
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
    },
  },

  sourcemap: {
    server: false,
    client: false,
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

  compatibilityDate: '2024-08-29',

  nitro: {
    compressPublicAssets: true,
    esbuild: { options: { target: 'esnext' } },
  },

  vite: {
    build: { target: 'esnext' },
    optimizeDeps: { esbuildOptions: { target: 'esnext' } },
  },

  telemetry: false,
  eslint: { config: { stylistic: true } },

  svgSprite: {
    elementClass: 'icon',
  },
})
