import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MigrationAuthorizationRequest } from '@eulerxyz/euler-v2-sdk'
import {
  isMigrationCeremonyDeadlineExpired,
  mintMigrationCeremonyDeadline,
  pinInboundMigrationCeremonyDeadline,
} from '~/utils/migrationCeremonyDeadline'
import { migrationAuthorizationPayloadKey } from '~/utils/migrationAuthorizationTxs'

const NOW_SECONDS = 1_800_000_000

describe('migrationCeremonyDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW_SECONDS * 1000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('mints a wall-clock deadline one hour out', () => {
    expect(mintMigrationCeremonyDeadline()).toBe(BigInt(NOW_SECONDS + 3600))
  })

  it('pins exactly the collateral quote deadline, ignoring an earlier debt quote expiry', () => {
    // Regression: clamping to the earliest quote deadline fails the SDK's
    // exact-equality check against the collateral quote's immutable embedded
    // verifier data ("SwapVerifier data mismatch").
    const deadline = pinInboundMigrationCeremonyDeadline({
      collateralSwapQuote: { verify: { deadline: 2000 } },
      debtSwapQuote: { verify: { deadline: 1000 } },
    })
    expect(deadline).toBe(2000n)
  })

  it('pins the collateral quote deadline even when later builds would mint fresher ones', () => {
    const quotes = { collateralSwapQuote: { verify: { deadline: NOW_SECONDS + 120 } } }
    const first = pinInboundMigrationCeremonyDeadline(quotes)
    vi.setSystemTime((NOW_SECONDS + 90) * 1000)
    const second = pinInboundMigrationCeremonyDeadline(quotes)
    expect(first).toBe(BigInt(NOW_SECONDS + 120))
    expect(second).toBe(first)
  })

  it('mints only when no collateral quote governs the verifier', () => {
    expect(pinInboundMigrationCeremonyDeadline({
      debtSwapQuote: { verify: { deadline: 1000 } },
    })).toBe(BigInt(NOW_SECONDS + 3600))
    expect(pinInboundMigrationCeremonyDeadline({})).toBe(BigInt(NOW_SECONDS + 3600))
  })

  it('falls back to the SDK sentinel when the collateral quote carries no deadline', () => {
    expect(pinInboundMigrationCeremonyDeadline({
      collateralSwapQuote: { verify: {} },
    })).toBe(0n)
  })

  it('reports expiry once the deadline is no longer executable', () => {
    const deadline = mintMigrationCeremonyDeadline()
    expect(isMigrationCeremonyDeadlineExpired(deadline)).toBe(false)
    vi.setSystemTime((NOW_SECONDS + 3599) * 1000)
    expect(isMigrationCeremonyDeadlineExpired(deadline)).toBe(false)
    vi.setSystemTime((NOW_SECONDS + 3600) * 1000)
    expect(isMigrationCeremonyDeadlineExpired(deadline)).toBe(true)
  })

  it('keeps the authorization payload key stable across builds only under a pinned deadline', () => {
    // Signature-form requests embed the deadline in the typed-data message, so
    // the review/confirm payload-equality gate can only pass when both builds
    // received the same pinned deadline. A re-minted deadline changes the key
    // and would reject every confirmation once the clock advances.
    const requestWithDeadline = (deadline: bigint): MigrationAuthorizationRequest => ({
      kind: 'typedData',
      name: 'morphoAuthorization',
      owner: '0x1000000000000000000000000000000000000000',
      chainId: 1,
      typedData: {
        domain: { name: 'Morpho', chainId: 1 },
        types: { Authorization: [{ name: 'deadline', type: 'uint256' }] },
        primaryType: 'Authorization',
        message: { deadline },
      },
    } as unknown as MigrationAuthorizationRequest)

    const pinned = mintMigrationCeremonyDeadline()
    const reviewKey = migrationAuthorizationPayloadKey(requestWithDeadline(pinned))

    vi.setSystemTime((NOW_SECONDS + 30) * 1000)
    expect(migrationAuthorizationPayloadKey(requestWithDeadline(pinned))).toBe(reviewKey)
    expect(migrationAuthorizationPayloadKey(requestWithDeadline(mintMigrationCeremonyDeadline()))).not.toBe(reviewKey)
  })
})
