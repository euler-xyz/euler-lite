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

/**
 * Repaint any light surface Beacon draws that the rules above do not name.
 *
 * Beacon has screens we cannot enumerate by class — the channel chooser, the
 * previous-conversations list, article cards — and each ships its own white
 * card component. Rather than chase every styled-components name, find
 * anything still rendering a light background inside the panel and give it the
 * app's card colour. This keeps working when HelpScout adds or renames a
 * screen, which the prefix selectors above do not.
 *
 * The accent fills (header, primary button) sit around luminance 127, well
 * under the threshold, so they are left alone.
 */
const LIGHT_LUMINANCE = 150
const SURFACE_FLAG = 'eulerBeaconSurface'
const TEXT_FLAG = 'eulerBeaconText'

const DARK_TEXT_LUMINANCE = 110
const GREYSCALE_SPREAD = 40

const channelsOf = (colour: string) => {
  const match = colour.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/)
  if (!match) return null
  if (match[4] !== undefined && Number(match[4]) === 0) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

const luminanceOf = (colour: string) => {
  const rgb = channelsOf(colour)
  return rgb ? (rgb[0] + rgb[1] + rgb[2]) / 3 : null
}

/** Spread between channels — near zero for greys, wide for a brand colour. */
const saturationOf = (colour: string) => {
  const rgb = channelsOf(colour)
  return rgb ? Math.max(...rgb) - Math.min(...rgb) : null
}

const repaintLightSurfaces = (doc: Document, card: string, border: string, text: string) => {
  const view = doc.defaultView
  if (!view) return

  // Clear previous repaints first so a theme switch re-evaluates from Beacon's
  // own colours instead of measuring what we already painted.
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>('[data-euler-beacon-surface]'))) {
    el.style.removeProperty('background-color')
    el.style.removeProperty('border-color')
    el.removeAttribute('data-euler-beacon-surface')
  }
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>('[data-euler-beacon-text]'))) {
    el.style.removeProperty('color')
    el.removeAttribute('data-euler-beacon-text')
  }

  const repainted: HTMLElement[] = []

  for (const el of Array.from(doc.querySelectorAll<HTMLElement>('*'))) {
    // Skip icons, avatars and other decoration — only real surfaces.
    if (el.clientHeight < 12 || el.clientWidth < 40) continue

    const luminance = luminanceOf(view.getComputedStyle(el).backgroundColor)
    if (luminance === null || luminance <= LIGHT_LUMINANCE) continue

    el.style.setProperty('background-color', card, 'important')
    el.style.setProperty('border-color', border, 'important')
    el.dataset[SURFACE_FLAG] = '1'
    repainted.push(el)
  }

  // Text Beacon coloured for a white card would now sit on a dark one. Only
  // near-greyscale dark text is lifted, so brand-coloured labels (the green
  // "Received" marker, links) keep the colour Beacon intended.
  for (const surface of repainted) {
    for (const el of Array.from(surface.querySelectorAll<HTMLElement>('*'))) {
      const colour = view.getComputedStyle(el).color
      const luminance = luminanceOf(colour)
      const saturation = saturationOf(colour)
      if (luminance === null || luminance >= DARK_TEXT_LUMINANCE) continue
      if (saturation !== null && saturation > GREYSCALE_SPREAD) continue
      el.style.setProperty('color', text, 'important')
      el.dataset[TEXT_FLAG] = '1'
    }
  }
}

/**
 * Style one Beacon frame: stylesheet for what we can name, repaint for the rest.
 *
 * Must stay idempotent. The frame observer below watches the whole document, so
 * creating or replacing a node here would retrigger it — the stylesheet is
 * created once and its text only written when it actually differs, which lets
 * repeated passes settle instead of looping.
 */
const themeFrame = (doc: Document, css: string) => {
  let style = doc.getElementById(STYLE_ID)
  if (!style) {
    style = doc.createElement('style')
    style.id = STYLE_ID
    doc.head.appendChild(style)
  }
  if (style.textContent !== css) style.textContent = css
  repaintLightSurfaces(
    doc,
    token('--bg-card', '#0c1d2f'),
    token('--border-default', '#14304e'),
    token('--text-secondary', '#ddfbf4'),
  )
}

export const useBeaconTheme = (theme: Ref<string>) => {
  if (!import.meta.client) return

  // Frames whose internals we already watch, so each is observed once.
  const watched = new WeakSet<Document>()
  const observers: MutationObserver[] = []

  const apply = () => {
    const css = buildCss()
    for (const frame of Array.from(document.querySelectorAll('iframe'))) {
      try {
        const doc = frame.contentDocument
        if (!doc?.head) continue
        // Only touch Beacon's own frames, never an unrelated embed.
        if (!frame.closest('#beacon-container') && !doc.querySelector('.hsds-beacon')) continue

        themeFrame(doc, css)

        // Beacon is a React app inside the frame: moving between the channel
        // chooser, the contact form and the conversation list swaps the whole
        // subtree without touching the parent document, so each frame needs its
        // own observer. Only childList is watched — the repaint writes inline
        // styles, which are attribute mutations and cannot re-trigger this.
        if (!watched.has(doc)) {
          // Belt and braces on top of themeFrame's idempotence: never re-enter
          // while a pass is in flight.
          let inPass = false
          const inner = new MutationObserver(() => {
            if (inPass) return
            inPass = true
            try {
              themeFrame(doc, buildCss())
            }
            finally {
              inPass = false
            }
          })
          // Observe the document, not body: on the first pass the frame often
          // has a head but no body yet, and observing a null body throws — which
          // would otherwise mark the frame watched without ever attaching.
          inner.observe(doc, { childList: true, subtree: true })
          // Only mark it watched once observe() has actually succeeded.
          watched.add(doc)
          observers.push(inner)
        }
      }
      catch {
        // Cross-origin or torn-down frame — nothing to do.
      }
    }
  }

  onMounted(() => {
    apply()

    // Beacon mounts its frames after window load and can recreate them, so
    // watch the host page for the frames themselves appearing.
    const outer = new MutationObserver(() => apply())
    outer.observe(document.body, { childList: true, subtree: true })
    observers.push(outer)

    if (typeof window.Beacon === 'function') {
      window.Beacon('on', 'open', apply)
      window.Beacon('on', 'ready', apply)
    }

    onUnmounted(() => observers.forEach(observer => observer.disconnect()))
  })

  // Re-resolve tokens after a theme switch.
  watch(theme, () => nextTick(apply))
}
