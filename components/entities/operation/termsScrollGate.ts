// Default pixel tolerance for treating a scroll position as "at the bottom".
// Absorbs sub-pixel rounding and momentum scrolling so the Accept button in the
// Acknowledge terms modal reliably unlocks once the end of the text is reached.
export const TERMS_SCROLL_END_THRESHOLD = 8

interface ScrollMetrics {
  scrollTop: number
  clientHeight: number
  scrollHeight: number
}

// Returns true when the scroll position has reached (within `threshold` px) the
// bottom of the content, or when the content does not overflow at all (in which
// case there is nothing to scroll and the end is already visible).
export const isScrolledToEnd = (
  { scrollTop, clientHeight, scrollHeight }: ScrollMetrics,
  threshold: number = TERMS_SCROLL_END_THRESHOLD,
): boolean => {
  return scrollTop + clientHeight >= scrollHeight - threshold
}
