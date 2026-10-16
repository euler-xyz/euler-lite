export type LiquidationBotApiConfig
  = | { status: 'off' }
    | { status: 'invalid', reason: string }
    | { status: 'on', template: string }

const CHAIN_PLACEHOLDER = '{chainId}'
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

const templateIssue = (template: string): string | null => {
  if (!template.includes(CHAIN_PLACEHOLDER)) return `must contain ${CHAIN_PLACEHOLDER}`
  let url: URL
  try {
    url = new URL(liquidationBotBaseUrl(template, 1))
  }
  catch {
    return 'must be a URL'
  }
  const local = url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)
  if (url.protocol !== 'https:' && !local) return 'must use HTTPS'
  if (url.username || url.password || url.search || url.hash) return 'must not carry credentials, a query or a fragment'
  return null
}

/** `LIQUIDATION_BOT_API_URL`: the default liquidation bot's API, with `{chainId}` where the chain goes. */
export const readLiquidationBotApiConfig = (): LiquidationBotApiConfig => {
  const template = process.env.LIQUIDATION_BOT_API_URL?.trim().replace(/\/+$/, '')
  if (!template) return { status: 'off' }
  const issue = templateIssue(template)
  return issue ? { status: 'invalid', reason: `LIQUIDATION_BOT_API_URL ${issue}` } : { status: 'on', template }
}

export const liquidationBotBaseUrl = (template: string, chainId: number): string =>
  template.replaceAll(CHAIN_PLACEHOLDER, String(chainId))
