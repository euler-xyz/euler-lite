import * as Sentry from '@sentry/nuxt'

// useRuntimeConfig() at module top-level is intentional here.
// @sentry/nuxt processes this file as a client-entry hook before the Nuxt
// app boots, and guarantees it runs in a context where useRuntimeConfig() is available.
const { public: { sentryDsn } } = useRuntimeConfig()

if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    tunnel: '/api/sentry-tunnel',
    tracesSampleRate: 0.2,
    replaysOnErrorSampleRate: 1.0,
    replaysSessionSampleRate: 0.05,
    integrations: [Sentry.replayIntegration()],
  })
}
