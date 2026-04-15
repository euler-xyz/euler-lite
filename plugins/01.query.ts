import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'

// Disable TanStack Query's default 3× retry. Wagmi hooks (useBalance, useEnsName,
// useWriteContract) layer this on top of viem's own retry, which amplifies a
// single 429 by up to 16×. Fail fast instead.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 0,
    },
  },
})

export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.vueApp.use(VueQueryPlugin, { queryClient })
})
