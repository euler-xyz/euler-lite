import { getAddress } from 'viem'

export const BATCH_SCROLL_SUB_ACCOUNT_QUERY = 'batchSubAccount'

interface BatchRedirectOptions {
  subAccount?: string | undefined
}

/**
 * After adding an operation to the transaction batch, navigate to the same place
 * the form would land after a direct execute (e.g. `/portfolio`), preserving the
 * active network. Keeps the post-add flow identical to direct execution while the
 * queued op is simulated into the batch layers.
 */
export const useBatchRedirect = () => {
  const router = useRouter()
  const route = useRoute()

  const redirectAfterAdd = (path: string, options: BatchRedirectOptions = {}) => {
    const query: Record<string, string> = {}
    const network = route.query.network
    if (typeof network === 'string') query.network = network
    else if (Array.isArray(network) && network[0]) query.network = network[0]

    if (options.subAccount) {
      query[BATCH_SCROLL_SUB_ACCOUNT_QUERY] = getAddress(options.subAccount).toLowerCase()
    }

    router.replace({ path, query })
  }

  return { redirectAfterAdd }
}
