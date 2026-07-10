import { isStablecoinSwapContext } from '~/composables/useSlippage'

export interface RefinanceSlippageLeg {
  fromSymbol?: string
  toSymbol?: string
}

const hasCompleteSlippageLeg = (
  leg: RefinanceSlippageLeg,
): leg is Required<RefinanceSlippageLeg> =>
  Boolean(leg.fromSymbol && leg.toSymbol)

export const getRefinanceSlippageContext = (
  legs: RefinanceSlippageLeg[],
): RefinanceSlippageLeg | null => {
  const completeLegs = legs.filter(hasCompleteSlippageLeg)
  if (!completeLegs.length) return null

  return completeLegs.find(leg => !isStablecoinSwapContext(leg)) ?? completeLegs[0]
}
