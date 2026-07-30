/**
 * Themes the HelpScout Beacon dialog with the app's own tokens.
 *
 * Beacon renders into iframes that carry no `src` — they are same-origin, so we
 * can append a stylesheet to their documents. CSS custom properties do not
 * cross the iframe boundary, so the tokens are resolved to concrete colours in
 * the parent document first and re-resolved whenever the theme changes.
 *
 * Fragility, deliberately accepted: the selectors below match HelpScout's
 * styled-components class names by prefix (the `-sc-<hash>-<n>` suffix changes
 * between their builds, the prefix is stable across them). If HelpScout renames
 * a component the matching rule stops applying and that part of the dialog
 * falls back to their default styling — the panel degrades to its stock look
 * rather than breaking. Everything is wrapped in try/catch so a future
 * cross-origin iframe would silently no-op instead of throwing.
 */

const STYLE_ID = 'euler-beacon-theme'

const token = (name: string, fallback: string) => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

const buildCss = () => {
  const card = token('--bg-card', '#0c1d2f')
  const surface = token('--bg-surface', '#08131f')
  const textPrimary = token('--text-primary', '#f7f7f8')
  const textSecondary = token('--text-secondary', '#ddfbf4')
  const textMuted = token('--text-muted', '#728395')
  const border = token('--border-default', '#14304e')
  const accent = token('--accent-600', '#23c09b')
  const accentRgb = token('--accent-rgb', '35, 192, 155')
  // Beacon paints the header with the configured brand colour and puts white
  // text on it, so the header keeps its own foreground.
  const onAccent = token('--text-inverse', '#020508')

  return [
    // Panel surface
    `[class*="BeaconContainerUI"]{background:${card} !important;}`,
    '[class*="BodyUI"],[class*="BodyContentWrapper"],[class*="BodyChildWrapper"],'
    + '[class*="FooterUI"],[class*="LayoutUI"]{background:transparent !important;}',

    // Type
    `[class*="TextUI"],label,p{color:${textSecondary} !important;}`,
    `h1,h2,h3,[class*="HeadingUI"]{color:${textPrimary} !important;}`,
    // The header sits on the accent fill — keep its text legible there.
    '[class*="HeaderNavUI"] *,[class*="Headercss__"] *{color:#ffffff !important;}',

    // Form fields: Beacon draws the field fill on a backdrop element behind a
    // transparent input, so both need styling.
    `[class*="InputBackdrop"]{background:${surface} !important;border-color:${border} !important;}`,
    `[class*="InputBackdropV2styles__FocusUI"]{box-shadow:0 0 0 1px ${accent},`
    + `0 0 0 3px rgba(${accentRgb},0.25) !important;}`,
    `input,textarea{background:transparent !important;color:${textPrimary} !important;`
    + `border-color:${border} !important;}`,
    `input::placeholder,textarea::placeholder{color:${textMuted} !important;}`,

    // Primary action — matches the app's own primary button (dark on accent).
    `[class*="ButtonUI"]:not([class*="Fab"]){color:${onAccent} !important;}`,
  ].join('\n')
}

/** Append (or refresh) the stylesheet inside every Beacon iframe. */
const injectInto = (css: string) => {
  let injected = 0
  for (const frame of Array.from(document.querySelectorAll('iframe'))) {
    try {
      const doc = frame.contentDocument
      if (!doc?.head) continue
      // Only touch Beacon's own frames, never an unrelated embed.
      if (!frame.closest('#beacon-container') && !doc.querySelector('.hsds-beacon')) continue
      doc.getElementById(STYLE_ID)?.remove()
      const style = doc.createElement('style')
      style.id = STYLE_ID
      style.textContent = css
      doc.head.appendChild(style)
      injected++
    }
    catch {
      // Cross-origin or torn-down frame — nothing to do.
    }
  }
  return injected
}

export const useBeaconTheme = (theme: Ref<string>) => {
  if (!import.meta.client) return

  const apply = () => injectInto(buildCss())

  onMounted(() => {
    apply()

    // Beacon mounts its iframes after window load and recreates the panel frame
    // each time it opens, so re-apply on both DOM changes and its open event.
    const observer = new MutationObserver(() => apply())
    observer.observe(document.body, { childList: true, subtree: true })

    if (typeof window.Beacon === 'function') {
      window.Beacon('on', 'open', apply)
      window.Beacon('on', 'ready', apply)
    }

    onUnmounted(() => observer.disconnect())
  })

  // Re-resolve tokens after a theme switch.
  watch(theme, () => nextTick(apply))
}
