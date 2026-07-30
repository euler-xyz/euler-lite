export interface AnnouncementConfig {
  enabled: boolean
  token: string
  title: string
  body: string
  items: string[]
  url: string
}

export const EMPTY_ANNOUNCEMENT_CONFIG: AnnouncementConfig = {
  enabled: false,
  token: '',
  title: '',
  body: '',
  items: [],
  url: '',
}

export interface AnnouncementConfigInput {
  title?: unknown
  body?: unknown
  items?: unknown
  url?: unknown
}

const asString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : ''

const parseItemArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []

  return value
    .map(item => asString(item))
    .filter(Boolean)
}

export const parseAnnouncementItems = (value: unknown): string[] => {
  if (Array.isArray(value)) return parseItemArray(value)

  const raw = asString(value)
  if (!raw) return []

  if (raw.startsWith('[')) {
    try {
      return parseItemArray(JSON.parse(raw))
    }
    catch {
      return []
    }
  }

  return raw
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(Boolean)
}

export const parseAnnouncementUrl = (value: unknown): string => {
  const raw = asString(value)
  if (!raw) return ''

  if (raw.startsWith('/')) {
    return /^\/[\\/]/.test(raw) ? '' : raw
  }

  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:' ? raw : ''
  }
  catch {
    return ''
  }
}

export const buildAnnouncementToken = (config: Omit<AnnouncementConfig, 'enabled' | 'token'>): string =>
  JSON.stringify({
    title: config.title,
    body: config.body,
    items: config.items,
    url: config.url,
  })

export const buildAnnouncementConfig = (input: AnnouncementConfigInput): AnnouncementConfig => {
  const config = {
    title: asString(input.title),
    body: asString(input.body),
    items: parseAnnouncementItems(input.items),
    url: parseAnnouncementUrl(input.url),
  }
  const enabled = !!(config.title || config.body || config.items.length || config.url)

  if (!enabled) return EMPTY_ANNOUNCEMENT_CONFIG

  return {
    enabled,
    token: buildAnnouncementToken(config),
    ...config,
  }
}
