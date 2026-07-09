import { getAddress } from 'viem'

export const BATCH_SCROLL_SUB_ACCOUNT_QUERY = 'batchSubAccount'
export const BATCH_SCROLL_VAULT_QUERY = 'batchVault'
export const BATCH_SCROLL_COLLATERAL_QUERY = 'batchCollateral'
export const BATCH_SCROLL_REMOVED_QUERY = 'batchRemoved'

interface BatchRedirectOptions {
  subAccount?: string | undefined
  /** Vault address of the affected position — disambiguates the scroll target
   *  when several positions live on the same sub-account (savings/earn lists). */
  vault?: string | undefined
  /** Collateral vault for borrow positions, used with `vault` to target the
   *  exact removed/modified borrow row when a sub-account has several loans. */
  collateral?: string | undefined
  /** Wait for a simulated removed row instead of scrolling to the active source row. */
  removed?: boolean | undefined
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
      try {
        query[BATCH_SCROLL_SUB_ACCOUNT_QUERY] = getAddress(options.subAccount).toLowerCase()
        if (options.vault) {
          query[BATCH_SCROLL_VAULT_QUERY] = getAddress(options.vault).toLowerCase()
        }
        if (options.collateral) {
          query[BATCH_SCROLL_COLLATERAL_QUERY] = getAddress(options.collateral).toLowerCase()
        }
        if (options.removed) {
          query[BATCH_SCROLL_REMOVED_QUERY] = 'true'
        }
      }
      catch {
        // Ignore malformed scroll targets; the redirect itself should still happen.
      }
    }

    router.replace({ path, query })
  }

  return { redirectAfterAdd }
}
