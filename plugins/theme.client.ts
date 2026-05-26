// Base hue for the app theme in degrees (0-360). Change to shift the brand palette.
const themeHue = 150
const defaultHue = 211
const normalizeHue = (hue: number) => ((hue % 360) + 360) % 360

export default defineNuxtPlugin(() => {
  const normalizedHue = Number.isFinite(themeHue) ? normalizeHue(themeHue) : defaultHue

  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--brand-hue', `${normalizedHue}deg`)
  }
})
