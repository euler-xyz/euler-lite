export interface AnnouncementConfig {
  enabled: boolean
  id: string
  token: string
  title: string
  body: string
  items: string[]
  url: string
}

export const EMPTY_ANNOUNCEMENT_CONFIG: AnnouncementConfig = {
  enabled: false,
  id: '',
  token: '',
  title: '',
  body: '',
  items: [],
  url: '',
}

export interface AnnouncementConfigInput {
  enabled?: unknown
  id?: unknown
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

export const isAnnouncementEnabled = (value: unknown): boolean => {
  const normalized = asString(value).toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes'
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

export const buildAnnouncementToken = (config: Omit<AnnouncementConfig, 'enabled' | 'token'>): string =>
  JSON.stringify({
    id: config.id,
    title: config.title,
    body: config.body,
    items: config.items,
    url: config.url,
  })

export const buildAnnouncementConfig = (input: AnnouncementConfigInput): AnnouncementConfig => {
  const id = asString(input.id)
  const enabled = isAnnouncementEnabled(input.enabled) && !!id

  if (!enabled) return { ...EMPTY_ANNOUNCEMENT_CONFIG, id }

  const config = {
    id,
    title: asString(input.title),
    body: asString(input.body),
    items: parseAnnouncementItems(input.items),
    url: asString(input.url),
  }

  return {
    enabled,
    token: buildAnnouncementToken(config),
    ...config,
  }
}
