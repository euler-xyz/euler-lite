export const getDisplayStepAmountLabel = (amount: string | number | undefined): string | undefined => {
  if (amount === undefined) return undefined
  if (amount === 'max' || amount === 'remaining') return amount
  if (typeof amount !== 'string' || amount.trim() === '' || Number.isFinite(Number(amount))) return undefined
  return amount
}
