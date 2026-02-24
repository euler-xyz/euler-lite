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

const isDev = process.env.DOPPLER_ENVIRONMENT === 'dev'

/** Origins only allowed in dev deployments. */
const CONNECT_SRC_DEV = [
  'https://swap-dev.euler.finance',
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

const CONNECT_SRC_BASE = [
  '\'self\'',
  'https://indexer.euler.finance',
  'https://swap.euler.finance',
  'https://api.merkl.xyz',
  'https://incentra-prd.brevis.network',
  'https://hermes.pyth.network',
  'https://raw.githubusercontent.com',
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
  'https://yields.llama.fi',
  'https://api-v2.pendle.finance',
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

function buildCsp(nonce: string, extraConnectSrc: string[]): string {
  const connectSrc = [
    ...CONNECT_SRC_BASE,
    ...(isDev ? CONNECT_SRC_DEV : []),
    ...extraConnectSrc,
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
    'img-src \'self\' data: blob: https://raw.githubusercontent.com https://storage.googleapis.com https://token-images.euler.finance',
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

  nitroApp.hooks.hook('render:html', (html, { event }) => {
    const nonce = randomBytes(16).toString('base64')

    // Remove CSP meta tag (belt-and-suspenders — should already be removed from nuxt.config)
    html.head = stripCspMeta(html.head)

    // Inject nonce into all <script> tags across all HTML sections
    html.head = injectNonce(html.head, nonce)
    html.body = injectNonce(html.body, nonce)
    html.bodyPrepend = injectNonce(html.bodyPrepend, nonce)
    html.bodyAppend = injectNonce(html.bodyAppend, nonce)

    setResponseHeader(event, 'Content-Security-Policy', buildCsp(nonce, extraConnectSrc))
  })
})
