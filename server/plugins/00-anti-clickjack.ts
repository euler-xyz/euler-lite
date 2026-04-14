/**
 * Defense-in-depth frame-busting script.
 *
 * Primary clickjacking protection is delivered via HTTP response headers:
 *   - X-Frame-Options: DENY             (server/middleware/security-headers.ts)
 *   - CSP frame-ancestors 'none'        (server/plugins/csp.ts)
 *   - Cross-Origin-Opener-Policy        (server/middleware/security-headers.ts)
 *
 * All modern browsers honor those headers and refuse to render the page
 * inside a frame, so this script is the last line of defense: if a CDN,
 * edge worker, or proxy ever strips or rewrites those headers, the inline
 * script below detects the frame, hides the UI, and tries to break out.
 *
 * The script is prepended (unshift) to html.head so it is the very first
 * <script> in <head> — it runs before wagmi / Reown AppKit / __APP_CONFIG__.
 * The `00-` filename prefix puts this Nitro plugin first in alphabetical
 * load order so its <script> lands in html.head before any other plugin
 * pushes its own tags.
 *
 * csp.ts runs last and rewrites every `<script` to `<script nonce="...">`,
 * so this tag automatically picks up the per-request nonce and is allowed
 * to execute under the strict script-src policy.
 *
 * IMPORTANT: do not weaken this without review. This is paired with
 * server/plugins/csp.ts and server/middleware/security-headers.ts to
 * prevent clickjacking attacks on a wallet-bearing DeFi app. See
 * tests/server/security.test.ts for regression coverage.
 */

export const ANTI_CLICKJACK_SCRIPT
  = '<script>(function(){if(window.self===window.top)return;document.documentElement.style.display=\'none\';try{window.top.location=window.self.location}catch(e){}throw new Error(\'[anti-clickjack] Blocked: page loaded inside a frame\')})()</script>'

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('render:html', (html) => {
    // Prepend so this runs before any other <script> in <head>.
    html.head.unshift(ANTI_CLICKJACK_SCRIPT)
  })
})
