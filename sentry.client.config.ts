import * as Sentry from '@sentry/nuxt'

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
