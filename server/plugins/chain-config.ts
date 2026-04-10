/**
 * Nitro plugin that scans process.env for chain-related env vars
 * and injects the computed config into the HTML via render:html hook.
 *
 * This runs at server startup, so Doppler-injected env vars are available.
 * The config is embedded as a <script> tag in the HTML head, making it
 * accessible to the client synchronously via window.__CHAIN_CONFIG__.
 */
export default defineNitroPlugin((nitroApp) => {
  const enabledChainIds: number[] = []

  for (const [key, value] of Object.entries(process.env)) {
    const rpcMatch = key.match(/^RPC_URL_HTTP_(\d+)$/)
    if (rpcMatch && value) {
      enabledChainIds.push(Number(rpcMatch[1]))
    }
  }

  const subgraphUris: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(/^NUXT_PUBLIC_SUBGRAPH_URI_(\d+)$/)
    if (match && value) {
      subgraphUris[match[1]] = value
    }
  }

  enabledChainIds.sort((a, b) => a - b)

  const scriptTag = `<script>window.__CHAIN_CONFIG__=${JSON.stringify({ enabledChainIds, subgraphUris })}</script>`

  nitroApp.hooks.hook('render:html', (html) => {
    html.head.push(scriptTag)
  })
})
