/**
 * Ring buffer of recent console output, attached to HelpScout support
 * conversations as diagnostics (see the Beacon wiring in app.vue).
 *
 * Capture starts when plugins/00.console-capture.client.ts installs the
 * wrapper at app boot. Entries are truncated and query-string values are
 * redacted so RPC API keys or other URL-borne secrets never reach the
 * support ticket.
 */

interface CapturedEntry {
  time: string
  level: string
  text: string
}

const MAX_ENTRIES = 100
const MAX_ENTRY_LENGTH = 400

const buffer: CapturedEntry[] = []
let installed = false

/** Mask query-string values, e.g. "?apiKey=abc123" → "?apiKey=[redacted]". */
const QUERY_VALUE_RE = /([?&][\w-]+=)[^&\s"']+/g

const stringifyArg = (arg: unknown): string => {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`
  try {
    return JSON.stringify(arg) ?? String(arg)
  }
  catch {
    return String(arg)
  }
}

const push = (level: string, args: unknown[]) => {
  const text = args
    .map(stringifyArg)
    .join(' ')
    .replace(QUERY_VALUE_RE, '$1[redacted]')
    .slice(0, MAX_ENTRY_LENGTH)
  buffer.push({ time: new Date().toISOString(), level, text })
  if (buffer.length > MAX_ENTRIES) buffer.shift()
}

const CAPTURED_LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const

export const installConsoleCapture = () => {
  if (installed) return
  installed = true

  for (const level of CAPTURED_LEVELS) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      push(level, args)
      original(...args)
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('error', (event) => {
      push('uncaught', [event.message])
    })
    window.addEventListener('unhandledrejection', (event) => {
      push('unhandledrejection', [event.reason])
    })
  }
}

/**
 * Most recent console output as newline-separated lines, oldest first,
 * capped to fit a HelpScout session-data value (10k char limit per entry).
 */
export const getRecentConsoleOutput = (maxChars = 9000): string => {
  const lines: string[] = []
  let total = 0
  for (let i = buffer.length - 1; i >= 0; i--) {
    const entry = buffer[i]
    const line = `${entry.time} [${entry.level}] ${entry.text}`
    if (total + line.length + 1 > maxChars) break
    lines.unshift(line)
    total += line.length + 1
  }
  return lines.join('\n')
}
