/**
 * Server-side HelpScout access for the in-app support panel.
 *
 * Docs API v1  — article search / read (Basic auth, API key as username).
 * Mailbox API v2 — creating the support conversation (OAuth2 client credentials).
 *
 * Both hosts are only ever called from the server, so the browser never talks to
 * HelpScout and no CSP entries are needed for them.
 */
import { fetchWithTimeout, UPSTREAM_FETCH_TIMEOUT_MS } from '~/server/utils/fetchWithTimeout'
import { logger } from '~/server/utils/logger'

const DOCS_BASE = 'https://docsapi.helpscout.net/v1'
const MAILBOX_BASE = 'https://api.helpscout.net/v2'
const TOKEN_URL = 'https://api.helpscout.net/v2/oauth2/token'

interface CachedToken {
  value: string
  expiresAt: number
}

let token: CachedToken | undefined
let inFlight: Promise<string> | undefined

export const helpScoutConfig = () => ({
  docsKey: process.env.HELPSCOUT_DOCS_API_KEY ?? '',
  collectionId: process.env.HELPSCOUT_DOCS_COLLECTION_ID ?? '',
  appId: process.env.HELPSCOUT_APP_ID ?? '',
  appSecret: process.env.HELPSCOUT_APP_SECRET ?? '',
  mailboxId: Number(process.env.HELPSCOUT_MAILBOX_ID ?? 0),
})

/** True when the Mailbox API credentials needed to open a ticket are present. */
export const isSupportConfigured = () => {
  const { appId, appSecret, mailboxId } = helpScoutConfig()
  return !!appId && !!appSecret && !!mailboxId
}

const buildUrl = (base: string, path: string, query: Record<string, string> = {}) => {
  const url = new URL(base + path)
  for (const [key, value] of Object.entries(query)) {
    if (value) url.searchParams.set(key, value)
  }
  return url.toString()
}

/** Docs API v1 uses Basic auth with the API key as the username. */
export const docsFetch = async <T>(path: string, query: Record<string, string> = {}): Promise<T> => {
  const { docsKey } = helpScoutConfig()
  if (!docsKey) throw new Error('HELPSCOUT_DOCS_API_KEY is not configured')

  const auth = Buffer.from(docsKey + ':X').toString('base64')
  const response = await fetchWithTimeout(
    buildUrl(DOCS_BASE, path, query),
    UPSTREAM_FETCH_TIMEOUT_MS,
    { headers: { Authorization: 'Basic ' + auth, Accept: 'application/json' } },
  )

  if (!response.ok) {
    logger.warn({ ctx: 'helpscout-docs', path, status: response.status }, 'docs api error')
    throw new Error('Docs API ' + response.status)
  }
  return await response.json() as T
}

/**
 * Mailbox API v2 OAuth2 client-credentials token, cached in-process with a
 * 60s safety margin. The in-flight guard means a burst of sends issues a
 * single token request (same pattern as server/utils/in-flight.ts).
 */
const getMailboxToken = async (): Promise<string> => {
  if (token && token.expiresAt > Date.now()) return token.value
  if (inFlight) return inFlight

  const { appId, appSecret } = helpScoutConfig()
  if (!appId || !appSecret) {
    throw new Error('HELPSCOUT_APP_ID / HELPSCOUT_APP_SECRET are not configured')
  }

  inFlight = (async () => {
    const response = await fetchWithTimeout(TOKEN_URL, UPSTREAM_FETCH_TIMEOUT_MS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: appId,
        client_secret: appSecret,
      }),
    })
    if (!response.ok) throw new Error('HelpScout token ' + response.status)
    const data = await response.json() as { access_token: string, expires_in: number }
    token = {
      value: data.access_token,
      expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    }
    return token.value
  })().finally(() => {
    inFlight = undefined
  })

  return inFlight
}

const mailboxRequest = async (
  path: string,
  init: { method?: string, body?: unknown, query?: Record<string, string> } = {},
): Promise<Response> => {
  const accessToken = await getMailboxToken()

  const response = await fetchWithTimeout(
    buildUrl(MAILBOX_BASE, path, init.query),
    UPSTREAM_FETCH_TIMEOUT_MS,
    {
      method: init.method ?? 'GET',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    },
  )

  if (!response.ok) {
    logger.warn({ ctx: 'helpscout-mailbox', path, status: response.status }, 'mailbox api error')
    throw new Error('Mailbox API ' + response.status)
  }
  return response
}

export const mailboxFetch = async <T>(
  path: string,
  init: { method?: string, body?: unknown, query?: Record<string, string> } = {},
): Promise<T | undefined> => {
  const response = await mailboxRequest(path, init)
  if (response.status === 201 || response.status === 204) return undefined
  return await response.json() as T
}

/**
 * POST that returns the id of the created resource.
 *
 * HelpScout answers a create with 201 and no body; the id is in the
 * `Resource-ID` header. Reading it is race-free, unlike re-listing the
 * customer's conversations and taking the newest.
 */
export const mailboxCreate = async (path: string, body: unknown): Promise<string> => {
  const response = await mailboxRequest(path, { method: 'POST', body })
  return response.headers.get('Resource-ID') ?? ''
}

export const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
