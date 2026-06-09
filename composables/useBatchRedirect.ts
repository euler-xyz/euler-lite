/**
 * After adding an operation to the transaction batch, navigate to the same place
 * the form would land after a direct execute (e.g. `/portfolio`), preserving the
 * active network. Keeps the post-add flow identical to direct execution while the
 * queued op is simulated into the batch layers.
 */
export const useBatchRedirect = () => {
  const router = useRouter()
  const route = useRoute()

  const redirectAfterAdd = (path: string) => {
    router.replace({ path, query: { network: route.query.network } })
  }

  return { redirectAfterAdd }
}
