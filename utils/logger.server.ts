import { pino } from 'pino'
import { summarizeViemError } from './viem-errors'

const isProd = process.env.NODE_ENV === 'production'
const level = process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug')

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

const baseOptions: Parameters<typeof pino>[0] = {
  level,
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
}

const buildLogger = () => {
  if (isProd) return pino(baseOptions)
  // In dev, route through pino-pretty so terminal output is readable. Wrapped
  // in a try/catch in case pino-pretty isn't installed (e.g. in CI tests
  // running with NODE_ENV unset) — fall back to plain JSON in that case.
  try {
    return pino({
      ...baseOptions,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname,app',
          singleLine: false,
        },
      },
    })
  }
  catch {
    return pino(baseOptions)
  }
}

export const logger = buildLogger()

export type Logger = ReturnType<typeof buildLogger>
