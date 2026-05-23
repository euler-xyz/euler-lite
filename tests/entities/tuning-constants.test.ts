import { describe, expect, it } from 'vitest'
import {
  BATCH_SIZE_VAULT_FETCH,
  BATCH_SIZE_VAULT_FETCH_HYPEREVM,
  getVaultFetchBatchSize,
} from '~/entities/tuning-constants'

describe('getVaultFetchBatchSize', () => {
  it('uses a smaller VaultLens batch on HyperEVM', () => {
    expect(getVaultFetchBatchSize(999)).toBe(BATCH_SIZE_VAULT_FETCH_HYPEREVM)
    expect(getVaultFetchBatchSize(999)).toBe(15)
  })

  it('keeps the default VaultLens batch size on other chains', () => {
    expect(getVaultFetchBatchSize(1)).toBe(BATCH_SIZE_VAULT_FETCH)
    expect(getVaultFetchBatchSize(8453)).toBe(BATCH_SIZE_VAULT_FETCH)
  })
})
