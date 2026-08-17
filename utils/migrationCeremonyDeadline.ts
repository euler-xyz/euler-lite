/**
 * Deadline pinning for migration ceremonies.
 *
 * SDK migration connectors mint a fresh wall-clock verifier deadline on every
 * plan build unless one is supplied. Every flow that builds a plan twice and
 * requires the two builds to describe the same ceremony — review preview vs
 * confirm-time execution, placeholder-signed preview vs signature-resolved
 * rebuild — must therefore pin one deadline across both builds: the deadline
 * is embedded in verifier calldata and in the EIP-712 authorization payload,
 * so a re-minted value fails the plan-parity and payload-equality gates.
 */

const MIGRATION_CEREMONY_DEADLINE_TTL_SECONDS = 60 * 60

/** A fresh wall-clock deadline for a ceremony no swap quote constrains. */
export const mintMigrationCeremonyDeadline = (): bigint =>
  BigInt(Math.floor(Date.now() / 1000) + MIGRATION_CEREMONY_DEADLINE_TTL_SECONDS)

/** True once a pinned deadline can no longer be executed on-chain. */
export const isMigrationCeremonyDeadlineExpired = (deadline: bigint): boolean =>
  deadline <= BigInt(Math.floor(Date.now() / 1000))

type SwapQuoteVerifyLike = {
  verify: {
    deadline?: number
  }
}

export type InboundMigrationCeremonyQuotes = {
  collateralSwapQuote?: SwapQuoteVerifyLike
  debtSwapQuote?: SwapQuoteVerifyLike
}

/**
 * The deadline an inbound (external-to-Euler) ceremony must pin.
 *
 * When a collateral swap quote is present, the SDK validates the supplied
 * deadline for exact equality against the deadline embedded in the quote's
 * immutable verifier data — any other value (earlier ones included) throws
 * "SwapVerifier data mismatch" at planning. So the pin must BE that quote's
 * deadline, mirroring the connectors' own `deadline ?? quote.verify.deadline`
 * fallback. The debt swap quote keeps its own embedded expiry and never
 * constrains the supplied deadline. Only when no collateral quote governs the
 * verifier is a minted deadline valid.
 */
export const pinInboundMigrationCeremonyDeadline = (quotes: InboundMigrationCeremonyQuotes): bigint =>
  quotes.collateralSwapQuote
    ? BigInt(quotes.collateralSwapQuote.verify.deadline ?? 0)
    : mintMigrationCeremonyDeadline()
