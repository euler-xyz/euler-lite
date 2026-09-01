import { getAddress } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOperationIntent } from '~/features/reviewed-execution/domain/factory'
import { clearUnverifiedVaultAcknowledgements, recordUnverifiedVaultAcknowledgement } from '~/features/reviewed-execution/policy/acknowledgements'
import { resolveAppPolicy } from '~/features/reviewed-execution/policy/app-policy'
import { makeReviewedExecution, TEST_ACCOUNT, TEST_TOKEN, TEST_VAULT } from './fixtures'
import { makeSwapQuote } from './swap-quote.test-fixture'

const geo = vi.hoisted(() => ({
  country: { value: 'US' as string | null | undefined },
  blocked: vi.fn(),
  restricted: vi.fn(),
}))

vi.mock('~/composables/useGeoBlock', () => ({
  useGeoBlock: () => ({ country: geo.country }),
  isVaultBlockedByCountry: geo.blocked,
  isVaultRestrictedByCountry: geo.restricted,
}))

vi.mock('~/composables/useEulerLabels', () => ({
  getEulerLabelsVersion: () => 1,
}))

const TARGET_VAULT = getAddress('0x5000000000000000000000000000000000000000')
const TARGET_TOKEN = getAddress('0x6000000000000000000000000000000000000000')
const sourceVault = { address: TEST_VAULT, chainId: 1, type: 'evault', asset: { address: TEST_TOKEN } }
const targetVault = { address: TARGET_VAULT, chainId: 1, type: 'evault', asset: { address: TARGET_TOKEN } }
const entries = new Map([
  [TEST_VAULT.toLowerCase(), { type: 'evk' as const, vault: sourceVault }],
  [TARGET_VAULT.toLowerCase(), { type: 'evk' as const, vault: targetVault }],
])

const swapIntent = () => {
  const quote = makeSwapQuote()
  return createOperationIntent({
    kind: 'collateral',
    planner: 'swap-collateral',
    args: {
      swapQuote: {
        ...quote,
        tokenOut: { ...quote.tokenOut, address: TARGET_TOKEN },
        verify: { ...quote.verify, vault: TARGET_VAULT },
      },
      swapperMode: 0,
    },
    chainId: 1,
    account: TEST_ACCOUNT,
    subAccounts: [TEST_ACCOUNT],
    source: 'test',
    createdAt: 1,
    intentId: 'two-vault-swap',
  })
}

describe('final two-vault swap policy', () => {
  beforeEach(() => {
    clearUnverifiedVaultAcknowledgements()
    geo.country.value = 'US'
    geo.blocked.mockReset().mockReturnValue(false)
    geo.restricted.mockReset().mockReturnValue(false)
    vi.stubGlobal('useVaultRegistry', () => ({
      get: (address: string) => entries.get(address.toLowerCase()),
      getOrFetch: vi.fn(async () => undefined),
      getVault: (address: string) => entries.get(address.toLowerCase())?.vault,
      isVerifiedVault: () => true,
    }))
    vi.stubGlobal('useTokenList', () => ({
      getTokenByAddress: (address: string) => getAddress(address) === TEST_TOKEN
        ? { address: TEST_TOKEN, symbol: 'TEST', decimals: 18 }
        : undefined,
    }))
    vi.stubGlobal('useVaults', () => ({
      isVaultGovernorVerified: (vault: { address: string }) => getAddress(vault.address) === TEST_VAULT,
      isEarnVaultOwnerVerified: vi.fn(),
      isSecuritizeGovernorVerified: vi.fn(),
    }))
  })

  afterEach(() => {
    clearUnverifiedVaultAcknowledgements()
    vi.unstubAllGlobals()
  })

  it('applies the regional restriction to the quote target vault', async () => {
    geo.restricted.mockImplementation((address: string) => getAddress(address) === TARGET_VAULT)

    await expect(resolveAppPolicy(makeReviewedExecution().requestSet, 100, [swapIntent()]))
      .rejects.toThrow('restricted in your region')
    expect(geo.restricted).toHaveBeenCalledWith(TARGET_VAULT, { asset: targetVault.asset })
  })

  it('requires acknowledgement for an unverified quote target vault', async () => {
    const requestSet = makeReviewedExecution().requestSet
    const intent = swapIntent()

    await expect(resolveAppPolicy(requestSet, 100, [intent]))
      .rejects.toThrow('acknowledgement does not cover the execution')

    recordUnverifiedVaultAcknowledgement({
      chainId: 1,
      account: TEST_ACCOUNT,
      operation: 'lend-swap',
      vaults: [TARGET_VAULT],
    })
    await expect(resolveAppPolicy(requestSet, 100, [intent])).resolves.toBeDefined()
  })
})
