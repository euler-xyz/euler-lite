// https://nuxt.com/docs/api/configuration/nuxt-config

import { lstatSync } from 'node:fs'
import { resolve } from 'node:path'

const themeBootstrapScript = '(function(){var theme="dark";try{theme=localStorage.getItem("theme")==="light"?"light":"dark"}catch(e){}document.documentElement.setAttribute("data-theme",theme);document.documentElement.style.colorScheme=theme})()'
const eulerSdkPackage = '@eulerxyz/euler-v2-sdk'
const chartPackages = ['chart.js', 'chartjs-plugin-annotation']
const isLinkedEulerSdk = (() => {
  try {
    return lstatSync(resolve(process.cwd(), 'node_modules', ...eulerSdkPackage.split('/'))).isSymbolicLink()
  }
  catch {
    return false
  }
})()

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
          name: 'base:app_id',
          content: '6a032ec8f8601f8d21fe6b80',
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
      configLabelsBaseUrl: '',
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
      configEnableTurtle: '',
      // Announcement modal: populate any content field to show a one-time modal.
      configAnnouncementTitle: '',
      configAnnouncementBody: '',
      configAnnouncementItems: '',
      configAnnouncementUrl: '',
      // External token list URLs for swap token selector
      configUniswapTokenListUrl: '',
      configDefillamaTokenListUrl: '',
      // Env config fallbacks (Doppler: NUXT_PUBLIC_*)
      // Prefer window.__APP_CONFIG__ at runtime; these are build-time fallbacks.
      appKitProjectId: '',
      appUrl: '',
      pythHermesUrl: '',
      v3ApiUrl: '',
      enableV3Backend: '',
      // Adapter chain for the browser "fast" SDK. fallback (default) | onchain | v3.
      // Maps to NUXT_PUBLIC_BROWSER_VAULT_SOURCE.
      browserVaultSource: '',
      executionRecordSdkQueries: '',
      swapApiUrl: '',
      eulerInterfacesBranch: '',
    },
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

      // Static public assets. Safe to cache aggressively now that the
      // deployment pipeline retains old `_nuxt/*` chunks in S3 across
      // deploys — the chunk-404 risk that originally motivated the
      // blanket `no-store` no longer applies to non-HTML routes.
      // Fonts are pinned to specific content via the `?v=` query string
      // in assets/styles/fonts.scss, so 1y immutable is safe.
      '/fonts/**': {
        headers: {
          'Cache-Control': 'public, max-age=31536000, immutable',
          'CDN-Cache-Control': 'public, max-age=31536000, immutable',
          'Cloudflare-CDN-Cache-Control': 'public, max-age=31536000, immutable',
        },
      },
      // App metadata images are referenced by wallet/connect metadata and
      // are stable between releases.
      '/logo.svg': {
        headers: {
          'Cache-Control': 'public, max-age=86400',
          'CDN-Cache-Control': 'public, max-age=604800',
          'Cloudflare-CDN-Cache-Control': 'public, max-age=604800',
        },
      },
      '/logo.png': {
        headers: {
          'Cache-Control': 'public, max-age=86400',
          'CDN-Cache-Control': 'public, max-age=604800',
          'Cloudflare-CDN-Cache-Control': 'public, max-age=604800',
        },
      },
      '/manifest-img.png': {
        headers: {
          'Cache-Control': 'public, max-age=86400',
          'CDN-Cache-Control': 'public, max-age=604800',
          'Cloudflare-CDN-Cache-Control': 'public, max-age=604800',
        },
      },
      // Icon assets without content-hashing: shorter browser cache so a
      // forced reload re-fetches, longer edge cache because assets change
      // very rarely and per-byte egress dominates.
      '/entities/**': {
        headers: {
          'Cache-Control': 'public, max-age=86400',
          'CDN-Cache-Control': 'public, max-age=604800',
          'Cloudflare-CDN-Cache-Control': 'public, max-age=604800',
        },
      },
      '/favicons/**': {
        headers: {
          'Cache-Control': 'public, max-age=86400',
          'CDN-Cache-Control': 'public, max-age=604800',
          'Cloudflare-CDN-Cache-Control': 'public, max-age=604800',
        },
      },
      '/sounds/**': {
        headers: {
          'Cache-Control': 'public, max-age=86400',
          'CDN-Cache-Control': 'public, max-age=604800',
          'Cloudflare-CDN-Cache-Control': 'public, max-age=604800',
        },
      },

      // SWR-friendly API endpoints. Each handler already sets the browser
      // Cache-Control policy. The catch-all below would otherwise stamp
      // CDN-Cache-Control: no-store, so these explicit rules let Cloudflare
      // collapse the same public payload across users while handlers still
      // drive browser caching.
      '/api/internal/vaults': {
        headers: {
          'CDN-Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
          'Cloudflare-CDN-Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
        },
      },
      '/api/public/**': {
        headers: {
          'CDN-Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
          'Cloudflare-CDN-Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
        },
      },
      '/api/internal/labels/**': {
        headers: {
          'CDN-Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
          'Cloudflare-CDN-Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
        },
      },
      '/api/internal/euler-chains': {
        headers: {
          'CDN-Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
          'Cloudflare-CDN-Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
        },
      },
      '/api/internal/abis/**': {
        headers: {
          'CDN-Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
          'Cloudflare-CDN-Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
        },
      },
      '/api/internal/proxy/merkl/opportunities': {
        headers: {
          'CDN-Cache-Control': 'public, s-maxage=60, stale-while-revalidate=60',
          'Cloudflare-CDN-Cache-Control': 'public, s-maxage=60, stale-while-revalidate=60',
        },
      },
      '/api/internal/proxy/fuul/incentives': {
        headers: {
          'CDN-Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
          'Cloudflare-CDN-Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
        },
      },
      '/api/internal/proxy/incentra/sdk/v1/eulerCampaigns': {
        headers: {
          'CDN-Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
          'Cloudflare-CDN-Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
        },
      },
      '/api/internal/proxy/intrinsic-apy-overrides': {
        headers: {
          'CDN-Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
          'Cloudflare-CDN-Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
        },
      },
      // Token lists change infrequently — 5 min edge cache, 10 min SWR.
      '/api/internal/token-list': {
        headers: {
          'CDN-Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
          'Cloudflare-CDN-Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
        },
      },
      // TOS changes very rarely — cache aggressively. Browser gets a
      // 5 min window; edge can serve for an hour and SWR for a day.
      '/api/internal/tos': {
        headers: {
          'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
          'CDN-Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
          'Cloudflare-CDN-Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
        },
      },

      // HTML and everything else: must not be cached by browsers or CDNs.
      // S3 retention of old chunks mitigates the original stale-HTML
      // failure mode for non-HTML routes, but HTML itself must always
      // resolve to the latest build's chunk hashes. Sensitive/live APIs
      // such as /api/internal/pyth/updates,
      // /api/internal/proxy/subgraph/*, /api/internal/proxy/turtle/*,
      // user-specific reward/proof proxy paths, /api/internal/rpc/*,
      // /api/internal/tenderly/*, and /api/internal/screen-address also
      // stay on this strict fallback.
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
    server: {
      watch: {
        ignored: [
          '**/.parity/**',
          '**/artifacts/**',
          '**/.playwright-mcp/**',
          '**/.nuxt/**',
          '**/.output/**',
        ],
      },
    },
    optimizeDeps: {
      // Linked SDK builds should be loaded directly so Vite does not keep
      // serving stale optimized bundles after rebuilding the sibling package.
      include: isLinkedEulerSdk ? chartPackages : [eulerSdkPackage, ...chartPackages],
      exclude: isLinkedEulerSdk ? [eulerSdkPackage] : [],
      esbuildOptions: { target: 'esnext' },
    },
  },
  typescript: {
    strict: false,
    tsConfig: {
      compilerOptions: {
        noImplicitOverride: false,
        noUncheckedIndexedAccess: false,
      },
    },
  },

  telemetry: false,

  hooks: {
    // The /ui component playground is a dev-only UI kit; it must not ship as
    // a routable page in production builds. Drop the route (and its bundle)
    // outside dev so it is neither reachable nor included in the output.
    // (The /_icons svg-sprite gallery is disabled separately via svgSprite
    // .iconsPath below, because it is registered by the module's own
    // pages:extend hook which runs after this one — filtering here can't
    // remove it reliably.)
    // NODE_ENV, not import.meta.dev: nuxt.config runs under jiti, where
    // import.meta.dev is undefined — it would remove the route in dev too.
    'pages:extend': (pages) => {
      if (process.env.NODE_ENV === 'development') return
      const index = pages.findIndex(page => page.path === '/ui')
      if (index !== -1) pages.splice(index, 1)
    },
  },
  eslint: { config: { stylistic: true } },

  svgSprite: {
    elementClass: 'icon',
    // The module registers a dev-only /_icons sprite-gallery page from
    // iconsPath. It is not linked anywhere in the app, so disable the route
    // outside dev (empty iconsPath is falsy and skips the module's page
    // registration, matching the module's `if (options.iconsPath)` guard).
    ...(process.env.NODE_ENV === 'development' ? {} : { iconsPath: '' }),
  },
})
