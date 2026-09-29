import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAddress } from 'viem'
import { buildVisiblePortfolioPositionFilter } from '~/utils/portfolioPositionFilter'

const state = vi.hoisted(() => ({
  source: 'v3',
  visibility: {} as Record<string, { status: string }>,
}))
vi.mock('~/composables/useEulerLabels', () => ({
  useEulerLabels: () => ({
    verifiedVaultAddresses: { value: [] },
    earnVaults: { value: [] },
    source: { get value() { return state.source } },
    visibility: { get value() { return state.visibility } },
  }),
}))
vi.mock('~/composables/useVaultRegistry', () => ({
  useVaultRegistry: () => ({ escrowAddresses: { value: [] }, getEscrowVaults: () => [] }),
}))

const owner = getAddress('0x1000000000000000000000000000000000000000')
const hidden = getAddress('0x2000000000000000000000000000000000000000')
const pending = getAddress('0x3000000000000000000000000000000000000000')
const unknown = getAddress('0x4000000000000000000000000000000000000000')
const position = (vaultAddress: string) => ({ account: owner, vaultAddress, borrowed: 0n })
const account = { getSubAccount: () => undefined }

describe('V3 portfolio position filter', () => {
  afterEach(() => {
    state.source = 'v3'
    state.visibility = {}
  })

  it('keeps own hidden and pending-review positions without showing unrelated vaults', () => {
    state.visibility = {
      [hidden.toLowerCase()]: { status: 'hidden' },
      [pending.toLowerCase()]: { status: 'pending_review' },
    }
    const filter = buildVisiblePortfolioPositionFilter()
    const context = { account } as unknown as Parameters<typeof filter>[1]
    expect(filter(position(hidden) as Parameters<typeof filter>[0], context)).toBe(true)
    expect(filter(position(pending) as Parameters<typeof filter>[0], context)).toBe(true)
    expect(filter(position(unknown) as Parameters<typeof filter>[0], context)).toBe(false)
  })

  it('does not import V3 visibility into static-label positions', () => {
    state.source = 'static'
    state.visibility = { [hidden.toLowerCase()]: { status: 'hidden' } }
    const filter = buildVisiblePortfolioPositionFilter()
    expect(filter(position(hidden) as Parameters<typeof filter>[0], { account } as unknown as Parameters<typeof filter>[1])).toBe(false)
  })
})
