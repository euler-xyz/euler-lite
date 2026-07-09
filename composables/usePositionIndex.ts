/**
 * Validates the sub-account index from URL params and returns it verbatim as a
 * string. EVC sub-accounts are valid for integer indices 0–255; an out-of-range
 * or non-integer value redirects to the portfolio page and resolves to '0'.
 *
 * Exception: the literal 'external' is a valid sentinel on the /borrow/swap
 * refinance route (an inbound external-protocol migration has no EVC sub-account)
 * and is returned unchanged. It is NOT a numeric index — callers that coerce the
 * result via `+index` / `Number()` must be on a non-external route (every current
 * numeric consumer is), since `+'external'` is NaN. The only page that can observe
 * the sentinel (borrow/swap) branches on `isExternalSourceRoute` before coercing.
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
