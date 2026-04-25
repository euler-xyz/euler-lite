import { pino } from 'pino'
import { summarizeViemError } from '~/utils/viem-errors'

/**
 * Server-side pino instance. Lives in `server/utils/` so Nitro auto-imports
 * it on the server only and Nuxt's app-side `utils/` scanner never sees it.
 *
 * Always emits JSON to stdout. If a developer wants pretty output locally,
 * pipe through `pino-pretty` from the CLI (`npm run dev | pino-pretty`).
 * Keeping the runtime configuration single-mode avoids the worker-thread
 * complexity that comes with pino's transport machinery.
 */

const errSerializer = (err: unknown): unknown => {
  if (err == null) return err
  // Always go through summarizeViemError so we never leak `abi`, `metaMessages`
  // (which carry the raw hex request body for failed `eth_call`s), or `args`.
  // Pino's default `pino-std-serializers/lib/err.js` would otherwise walk the
  // entire object graph.
  const summary = summarizeViemError(err)
  return {
    name: summary.name,
    kind: summary.kind,
    shortMessage: summary.shortMessage,
    ...(summary.url != null ? { url: summary.url } : {}),
    ...(summary.status != null ? { status: summary.status } : {}),
    ...(summary.code != null ? { code: summary.code } : {}),
    ...(summary.functionName != null ? { functionName: summary.functionName } : {}),
    ...(summary.contractAddress != null ? { contractAddress: summary.contractAddress } : {}),
    ...(summary.causeName != null ? { causeName: summary.causeName } : {}),
    ...(summary.causeMessage != null ? { causeMessage: summary.causeMessage } : {}),
  }
}

export const logger = pino({
  base: { app: 'euler-lite' },
  formatters: {
    // Emit level as a string ('warn', 'error', …) — easier to filter in
    // BetterStack than the numeric level codes pino uses by default.
    level: (label: string) => ({ level: label }),
  },
  serializers: {
    err: errSerializer,
    error: errSerializer,
  },
})

export type Logger = typeof logger
