export function assertSwapperVerifierAllowed(
  swapVerifierAddress: string,
  knownSwapVerifier: string | undefined,
): void {
  if (!knownSwapVerifier) {
    throw new Error('Known swap verifier address not configured')
  }
  if (swapVerifierAddress.toLowerCase() !== knownSwapVerifier.toLowerCase()) {
    throw new Error(
      `Unknown swap verifier address: ${swapVerifierAddress}. Expected: ${knownSwapVerifier}`,
    )
  }
}
