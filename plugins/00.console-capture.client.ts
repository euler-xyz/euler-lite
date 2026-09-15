/**
 * Installs the console ring buffer as early as possible (00. prefix sorts
 * before the wagmi plugin) so boot-time warnings/errors are captured for
 * the HelpScout support diagnostics. See utils/console-capture.ts.
 */
export default defineNuxtPlugin(() => {
  installConsoleCapture()
})
