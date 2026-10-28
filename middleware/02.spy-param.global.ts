export default defineNuxtRouteMiddleware((to) => {
  if (import.meta.server) return

  const spyParam = to.query.spy

  // If spy mode is active (address in memory) but ?spy missing from target route — re-add it
  if (!spyParam) {
    const { spyQueryValue, isSpyMode } = getSpyModeState()
    if (isSpyMode.value) {
      return navigateTo({
        path: to.path,
        query: {
          ...to.query,
          spy: spyQueryValue.value,
        },
        hash: to.hash,
      })
    }
  }
})
