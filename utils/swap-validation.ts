export function assertSwapperAllowed(
  swapperAddress: string,
  knownSwapper: string | undefined,
): void {
  if (!knownSwapper) {
    throw new Error('Known swapper address not configured')
  }
  if (swapperAddress.toLowerCase() !== knownSwapper.toLowerCase()) {
    throw new Error(
      `Unknown swapper address: ${swapperAddress}. Expected: ${knownSwapper}`,
    )
  }
}
