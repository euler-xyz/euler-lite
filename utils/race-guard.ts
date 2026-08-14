export type RaceGuard = {
  next: () => number
  current: () => number
  isStale: (captured: number) => boolean
}

export function createRaceGuard(): RaceGuard {
  let generation = 0
  return {
    next: () => ++generation,
    current: () => generation,
    isStale: (captured: number) => captured !== generation,
  }
}

/**
 * Awaits `task` and commits its result only when no newer run started meanwhile.
 *
 * Guards the common effect shape where a display value is recomputed on every
 * dependency change: without this, a slow early call can resolve last and
 * overwrite a fresher result that already landed.
 */
export async function runGuarded<T>(
  guard: RaceGuard,
  task: () => Promise<T>,
  commit: (value: T) => void,
): Promise<void> {
  const generation = guard.next()
  const result = await task()
  if (guard.isStale(generation)) return
  commit(result)
}
