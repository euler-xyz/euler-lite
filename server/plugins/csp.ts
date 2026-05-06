/**
 * Nitro plugin that implements nonce-based Content Security Policy.
 *
 * Runs AFTER app-config and chain-config plugins (alphabetical order)
 * so all injected <script> tags are already present in the HTML.
 *
 * 1. Generates a cryptographic nonce per request
 * 2. Injects the nonce into every <script> tag in the HTML
 * 3. Sets the CSP as an HTTP response header (not a meta tag)
 */
import { randomBytes } from 'node:crypto'
import { setResponseHeader } from 'h3'
import * as allChains from '@reown/appkit/networks'
import type { AppKitNetwork } from '@reown/appkit/networks'

const isDev = process.env.DOPPLER_ENVIRONMENT === 'dev'

/** Map of chainId → AppKit/viem chain definition, used to look up each
 *  enabled chain's default public RPC URL(s) for the CSP connect-src list. */
const chainById = new Map<number, AppKitNetwork>(
  (Object.values(allChains) as unknown[])
    .filter((v): v is AppKitNetwork => v != null && typeof v === 'object' && 'id' in v)
    .map((chain): [number, AppKitNetwork] => [Number((chain as AppKitNetwork).id), chain as AppKitNetwork]),
)

/** Origins only allowed in dev deployments. */
const CONNECT_SRC_DEV = [
  'https://golang-proxy-development.up.railway.app',
]

/**
 * Extra connect-src origins (comma-separated).
 * Use CSP_EXTRA_CONNECT_SRC to allow additional origins per deployment
 * on top of the built-in and dev-only lists.
 */
function parseExtraConnectSrc(): string[] {
  const raw = process.env.CSP_EXTRA_CONNECT_SRC?.trim()
  if (!raw) return []
  return raw.split(',').map(s => s.trim()).filter(Boolean)
}

/** Extract the origin (scheme + host + port) from a URL string. */
function safeOrigin(raw: string | undefined): string | null {
  const trimmed = raw?.trim()
  if (!trimmed) return null
  try {
    return new URL(trimmed).origin
  }
  catch {
    return null
  }
}

/** Read an env var with fallback names (mirrors app-config.ts resolution order). */
function env(...keys: string[]): string | undefined {
  for (const k of keys) {
    if (process.env[k]) return process.env[k]
  }
  return undefined
}

/** Scan process.env for dynamic RPC / subgraph URL env vars. */
function scanDynamicEnvUrls(): string[] {
  const urls: string[] = []
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue
    // RPC_URL_<chainId> — wagmi uses these directly on the client
    // NUXT_PUBLIC_SUBGRAPH_URI_<chainId> — client-side GraphQL queries
    if (/^RPC_URL_\d+$/.test(key) || /^NUXT_PUBLIC_SUBGRAPH_URI_\d+$/.test(key)) {
      urls.push(value)
    }
  }
  return urls
}

/**
 * Derive connect-src origins for each enabled chain's default public RPC URL.
 * Wagmi uses these as a fallback when /api/rpc/{chainId} is unavailable
 * (configured explicitly in plugins/00.wagmi.ts). Auto-deriving from the chain
 * definition means new chains "just work" without a CSP update.
 */
function parseChainPublicRpcOrigins(): string[] {
  const origins = new Set<string>()
  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(/^RPC_URL_(\d+)$/)
    // Require a non-empty value so empty placeholder env vars don't widen
    // connect-src for chains that chain-config.ts correctly treats as disabled.
    if (!match || !value) continue
    const chain = chainById.get(Number(match[1]))
    const urls = chain?.rpcUrls?.default?.http ?? []
    for (const url of urls) {
      const origin = safeOrigin(url)
      if (origin) origins.add(origin)
    }
  }
  return [...origins]
}

/** Derive CSP origins from URL env vars so deployers don't need to duplicate them. */
function parseEnvOrigins(): { connect: string[] } {
  // Labels, oracle checks, and token lists are proxied through server /api/*
  // endpoints, so their origins are not needed in connect-src.
  const connectVars = [
    env('EULER_API_URL', 'NUXT_PUBLIC_EULER_API_URL'),
    env('SWAP_API_URL', 'NUXT_PUBLIC_SWAP_API_URL'),
    // Pyth Hermes is proxied through /api/pyth/updates — no external origin needed
    // Dynamic per-chain URLs (RPC for wagmi, subgraph for GraphQL)
    ...scanDynamicEnvUrls(),
  ]

  const connect = [...new Set(connectVars.map(safeOrigin).filter(Boolean))] as string[]
  return { connect }
}

const CONNECT_SRC_BASE = [
  '\'self\'',
  'https://api.merkl.xyz',
  'https://incentra-prd.brevis.network',
  // WalletConnect / Reown
  'https://rpc.walletconnect.com',
  'https://rpc.walletconnect.org',
  'https://relay.walletconnect.com',
  'https://relay.walletconnect.org',
  'https://api.web3modal.com',
  'https://api.web3modal.org',
  'https://keys.walletconnect.com',
  'https://keys.walletconnect.org',
  'https://notify.walletconnect.com',
  'https://notify.walletconnect.org',
  'https://echo.walletconnect.com',
  'https://echo.walletconnect.org',
  'https://push.walletconnect.com',
  'https://push.walletconnect.org',
  'https://pulse.walletconnect.com',
  'https://pulse.walletconnect.org',
  'https://verify.walletconnect.com',
  'https://verify.walletconnect.org',
  'https://explorer-api.walletconnect.com',
  // Coinbase Wallet SDK
  'https://chain-proxy.wallet.coinbase.com',
  'https://cca-lite.coinbase.com',
  // External data APIs
  'https://api.fuul.xyz',
  'https://v3.eul.dev',
  // SDK default deployments source
  'https://raw.githubusercontent.com',
  // Reown AppKit SDK version check
  'https://registry.npmjs.org',
  // RPC providers (wildcard — operators configure per chain)
  'https://*.quiknode.pro',
  'https://*.alchemy.com',
  'https://*.ankr.com',
  'https://*.goldsky.com',
  // WebSocket connections
  'wss://www.walletlink.org',
  'wss://relay.walletconnect.com',
  'wss://relay.walletconnect.org',
]

export function buildCsp(
  nonce: string,
  extraConnectSrc: string[],
  envOrigins: { connect: string[] },
  chainPublicOrigins: string[],
): string {
  const connectSrc = [
    ...CONNECT_SRC_BASE,
    ...(isDev ? CONNECT_SRC_DEV : []),
    ...extraConnectSrc,
    ...envOrigins.connect,
    ...chainPublicOrigins,
  ]

  const directives = [
    'default-src \'self\'',
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval' https://static.cloudflareinsights.com`,
    'style-src \'unsafe-inline\' \'self\'',
    'object-src \'none\'',
    'base-uri \'self\'',
    `connect-src ${connectSrc.join(' ')}`,
    'font-src \'self\' https://fonts.reown.com',
    'frame-src \'self\' https://verify.walletconnect.org https://verify.walletconnect.com',
    'frame-ancestors \'none\'',
    // Token logos come from arbitrary CDNs (CoinGecko, DefiLlama, Uniswap, etc.)
    // that cannot be whitelisted upfront. Images are passive content — no script execution risk.
    'img-src \'self\' data: blob: https:',
    'manifest-src \'self\'',
    'media-src \'self\'',
    'worker-src \'self\' blob:',
    'form-action \'self\'',
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ]

  return directives.join('; ')
}

function injectNonce(chunks: string[], nonce: string): string[] {
  return chunks.map(chunk =>
    chunk.replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`),
  )
}

function stripCspMeta(chunks: string[]): string[] {
  return chunks.map(chunk =>
    chunk.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/, ''),
  )
}

export default defineNitroPlugin((nitroApp) => {
  const extraConnectSrc = parseExtraConnectSrc()
  const envOrigins = parseEnvOrigins()
  const chainPublicOrigins = parseChainPublicRpcOrigins()

  nitroApp.hooks.hook('render:html', (html, { event }) => {
    const nonce = randomBytes(16).toString('base64')

    // Remove CSP meta tag (belt-and-suspenders — should already be removed from nuxt.config)
    html.head = stripCspMeta(html.head)

    // Inject nonce into all <script> tags across all HTML sections
    html.head = injectNonce(html.head, nonce)
    html.body = injectNonce(html.body, nonce)
    html.bodyPrepend = injectNonce(html.bodyPrepend, nonce)
    html.bodyAppend = injectNonce(html.bodyAppend, nonce)

    setResponseHeader(event, 'Content-Security-Policy', buildCsp(nonce, extraConnectSrc, envOrigins, chainPublicOrigins))
  })
})
