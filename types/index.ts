export {}

declare global {
  interface Window {
    pw: unknown
    gtag: (...args: unknown[]) => void
    // HelpScout Beacon JS API. The shim in nuxt.config.ts defines this before
    // the app mounts and queues calls until the real Beacon script loads.
    Beacon: (method: string, options?: unknown, data?: unknown) => void
  }
}
