import { QueryClient } from '@tanstack/vue-query'

// Disable TanStack Query's default 3x retry. Wagmi hooks layer this on top of
// viem's own retry, which amplifies a single 429 by up to 16x. Fail fast instead.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 0,
    },
  },
})
