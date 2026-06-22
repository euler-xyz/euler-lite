/**
 * Validates the sub-account index from URL params.
 * EVC sub-accounts are valid for integer indices 0–255.
 * Redirects to the portfolio page if the index is invalid.
 */
export function usePositionIndex(): string {
  const route = useRoute()
  const router = useRouter()
  const raw = route.params.number as string
  if (raw === 'external' && route.path.endsWith('/borrow/swap')) {
    return raw
  }

  const parsed = Number(raw)

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) {
    router.replace('/')
    return '0'
  }

  return raw
}
