export default defineNuxtRouteMiddleware((to) => {
  if (import.meta.server) return

  // Zip Code demo routes are exempt from Euler spy-mode handling.
  if (to.path.startsWith('/zipcode')) return

  const spyParam = to.query.spy

  // If spy mode is active (address in memory) but ?spy missing from target route — re-add it
  if (!spyParam) {
    const { spyAddress, isSpyMode } = getSpyModeState()
    if (isSpyMode.value) {
      return navigateTo({
        path: to.path,
        query: {
          ...to.query,
          spy: spyAddress.value,
        },
        hash: to.hash,
      })
    }
  }
})
