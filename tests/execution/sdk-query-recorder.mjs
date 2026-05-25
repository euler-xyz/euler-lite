export function installSdkQueryRecorder() {
  const MAX_DEPTH = 5
  const MAX_ARRAY_ITEMS = 40
  const MAX_OBJECT_KEYS = 60
  const MAX_STRING_LENGTH = 4_000

  window.__EULER_SDK_QUERY_RECORDER__ = (record) => {
    const recorder = window.__EULER_EXECUTION_RECORDER__
    if (typeof recorder !== 'function') return

    try {
      void Promise.resolve(recorder(sanitizeRecord(record))).catch(() => undefined)
    }
    catch {
      // Recording is diagnostics-only and must never affect the app query path.
    }
  }

  const sanitizeRecord = record => ({
    queryName: record.queryName,
    serializedArgs: record.serializedArgs,
    args: sanitize(record.args),
    status: record.status,
    durationMs: record.durationMs,
    ...(record.status === 'success'
      ? { result: sanitize(record.result) }
      : { error: sanitize(record.error) }),
  })

  const sanitize = (value, seen = new WeakSet(), depth = 0) => {
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
    if (typeof value === 'string') return truncate(value)
    if (typeof value === 'bigint') return { type: 'bigint', value: value.toString() }
    if (typeof value === 'undefined') return { type: 'undefined' }
    if (typeof value === 'function') return { type: 'function', name: value.name || null }
    if (typeof value === 'symbol') return { type: 'symbol', value: String(value) }
    if (depth >= MAX_DEPTH) return summarize(value)

    if (seen.has(value)) return { type: 'circular' }
    seen.add(value)

    if (value instanceof Error) {
      return {
        type: 'error',
        name: value.name,
        message: truncate(value.message),
        stack: value.stack ? truncate(value.stack) : null,
      }
    }

    if (value instanceof URL) return value.toString()

    if (value instanceof Map) {
      return {
        type: 'map',
        size: value.size,
        entries: [...value.entries()]
          .slice(0, MAX_ARRAY_ITEMS)
          .map(([entryKey, entryValue]) => [sanitize(entryKey, seen, depth + 1), sanitize(entryValue, seen, depth + 1)]),
      }
    }

    if (value instanceof Set) {
      return {
        type: 'set',
        size: value.size,
        values: [...value.values()].slice(0, MAX_ARRAY_ITEMS).map(item => sanitize(item, seen, depth + 1)),
      }
    }

    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY_ITEMS).map(item => sanitize(item, seen, depth + 1))
      if (value.length > MAX_ARRAY_ITEMS) {
        items.push({ type: 'truncated', omitted: value.length - MAX_ARRAY_ITEMS })
      }
      return items
    }

    return sanitizeObject(value, seen, depth)
  }

  const sanitizeObject = (value, seen, depth) => {
    const out = {}
    const entries = safeEntries(value).slice(0, MAX_OBJECT_KEYS)

    for (const [key, item] of entries) {
      out[key] = sanitize(item, seen, depth + 1)
    }

    const omitted = safeKeys(value).length - entries.length
    if (omitted > 0) {
      out.__truncated = { omitted }
    }

    return out
  }

  const safeEntries = (value) => {
    try {
      return Object.entries(value)
    }
    catch {
      return []
    }
  }

  const safeKeys = (value) => {
    try {
      return Object.keys(value)
    }
    catch {
      return []
    }
  }

  const summarize = (value) => {
    if (Array.isArray(value)) return { type: 'array', length: value.length }
    if (value && typeof value === 'object') return { type: value.constructor?.name ?? 'object' }
    return { type: typeof value }
  }

  const truncate = value => (
    value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}...`
      : value
  )
}
