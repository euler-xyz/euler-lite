export const clampRangeValue = (value: number, min: number, max: number): number => {
  if (min > max) return clampRangeValue(value, max, min)
  return Math.min(Math.max(value, min), max)
}

export const snapRangeValue = (value: number, min: number, max: number, step: number): number => {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) return min
  if (!Number.isFinite(step) || step <= 0) return clampRangeValue(value, min, max)

  const invStep = 1 / step
  const snapped = min + Math.round((value - min) * invStep) / invStep
  return clampRangeValue(snapped, min, max)
}
