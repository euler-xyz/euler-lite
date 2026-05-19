const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export type KnownSwapAddresses = Record<string, string | undefined> | null | undefined

const SWAPPER_ALLOWLIST_KEYS = [
  'swapper',
  'eulerSwapPeriphery',
  'eulerSwapV1Periphery',
  'eulerSwapV2Periphery',
] as const

const normalizeAddress = (address: string | undefined): string | undefined => {
  if (!address) return undefined

  const normalized = address.toLowerCase()
  return normalized === ZERO_ADDRESS ? undefined : normalized
}

export function getAllowedSwapperAddresses(knownAddresses: KnownSwapAddresses): string[] {
  const allowed = new Set<string>()

  for (const key of SWAPPER_ALLOWLIST_KEYS) {
    const normalized = normalizeAddress(knownAddresses?.[key])
    if (normalized) {
      allowed.add(normalized)
    }
  }

  return [...allowed]
}

export function assertSwapperAllowed(
  swapperAddress: string,
  knownAddresses: KnownSwapAddresses,
): void {
  const allowedSwappers = getAllowedSwapperAddresses(knownAddresses)

  if (!allowedSwappers.length) {
    throw new Error('Known swapper address not configured')
  }

  if (!allowedSwappers.includes(swapperAddress.toLowerCase())) {
    throw new Error(
      `Unknown swapper address: ${swapperAddress}. Expected one of: ${allowedSwappers.join(', ')}`,
    )
  }
}

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

export function assertSwapQuoteContractsAllowed(
  quoteContracts: { swapperAddress: string, verifierAddress: string },
  knownAddresses: KnownSwapAddresses,
): void {
  assertSwapperVerifierAllowed(quoteContracts.verifierAddress, knownAddresses?.swapVerifier)
  assertSwapperAllowed(quoteContracts.swapperAddress, knownAddresses)
}
