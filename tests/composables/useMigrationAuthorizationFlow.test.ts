import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAddress, type Hex } from 'viem'
import { useMigrationAuthorizationFlow } from '~/composables/useMigrationAuthorizationFlow'
import type { MigrationAuthorizationRevoke } from '~/utils/migrationAuthorizationTxs'

const mocks = vi.hoisted(() => ({
  sendMigrationAuthorizationRevokes: vi.fn(),
  showWarning: vi.fn(),
}))

vi.mock('~/components/ui/composables/useToast', () => ({
  useToast: () => ({ warning: mocks.showWarning }),
}))

const OWNER = getAddress('0x1000000000000000000000000000000000000000')
const TOKEN = getAddress('0x2000000000000000000000000000000000000000')
const revoke: MigrationAuthorizationRevoke = {
  transaction: { to: TOKEN, data: '0x1234' as Hex },
  walletContext: { account: OWNER, chainId: 1 },
}

describe('useMigrationAuthorizationFlow pending cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('useEulerTx', () => ({
      sendMigrationAuthorizationRevokes: mocks.sendMigrationAuthorizationRevokes,
    }))
    useMigrationAuthorizationFlow().pendingRevokes.value = []
  })

  it('retains a failed direct cleanup and restores it before the next retry', async () => {
    mocks.sendMigrationAuthorizationRevokes
      .mockResolvedValueOnce({ restored: [], failed: [revoke] })
      .mockResolvedValueOnce({ restored: [revoke], failed: [] })
    const firstAttempt = useMigrationAuthorizationFlow()

    await firstAttempt.revokeAfterAbort([revoke])

    expect(firstAttempt.pendingRevokes.value).toEqual([revoke])
    const retry = useMigrationAuthorizationFlow()
    await expect(retry.restorePendingBeforeRetry()).resolves.toBe(true)
    expect(retry.pendingRevokes.value).toEqual([])
    expect(mocks.sendMigrationAuthorizationRevokes).toHaveBeenNthCalledWith(2, [revoke])
  })

  it('keeps only failed revokes pending after partial cleanup', async () => {
    const other = {
      ...revoke,
      transaction: { ...revoke.transaction, data: '0xabcd' as Hex },
    }
    mocks.sendMigrationAuthorizationRevokes.mockResolvedValue({
      restored: [other],
      failed: [revoke],
    })
    const flow = useMigrationAuthorizationFlow()

    await flow.revokeAfterSuccess([revoke, other])

    expect(flow.pendingRevokes.value).toEqual([revoke])
  })
})
