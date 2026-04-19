/**
 * Abort-controller-backed helpers for bounding upstream time.
 *
 * `fetchWithTimeout` caps a single HTTP request. `withWallClock` caps an
 * arbitrary async task — useful for paginated loops where the per-page
 * timeout must cooperate with an overall budget.
 */
export async function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  }
  finally {
    clearTimeout(timeout)
  }
}

/**
 * Race an async task against a wall-clock deadline. If `budgetMs` elapses
 * before `task()` resolves, rejects with an Error tagged by `label`.
 */
export async function withWallClock<T>(
  task: () => Promise<T>,
  budgetMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: budget ${budgetMs}ms exhausted`)), budgetMs)
  })
  try {
    return await Promise.race([task(), deadline])
  }
  finally {
    if (timer) clearTimeout(timer)
  }
}
