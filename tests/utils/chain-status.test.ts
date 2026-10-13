import { describe, expect, it } from 'vitest'
import {
  applyChainRegistry,
  isChainShown,
  parseChainStatus,
  parseExplorerUrl,
  readChainRegistry,
} from '~/utils/chain-status'

const envConfig = (overrides: Partial<{
  enabledChainIds: number[]
  deprecatedChainIds: number[]
  onchainSdkChainIds: number[]
  eVaultFetchChunkChainIds: number[]
}> = {}) => ({
  enabledChainIds: [1, 137, 146, 8453],
  deprecatedChainIds: [],
  onchainSdkChainIds: [],
  eVaultFetchChunkChainIds: [],
  unsupportedChainIds: [],
  ...overrides,
})

describe('parseChainStatus', () => {
  it('keeps the four registry statuses', () => {
    for (const status of ['staging', 'production', 'unlisted', 'deprecated']) {
      expect(parseChainStatus(status)).toBe(status)
    }
  })

  it('reads the retired testing status as staging', () => {
    expect(parseChainStatus('testing')).toBe('staging')
  })

  it('reads any other value as unlisted', () => {
    for (const value of ['paused', 'Production', '', null, 1, {}]) {
      expect(parseChainStatus(value)).toBe('unlisted')
    }
  })

  it('reads a missing status as no registry signal', () => {
    expect(parseChainStatus(undefined)).toBeUndefined()
  })
})

describe('parseExplorerUrl', () => {
  it('accepts an https origin and strips trailing slashes', () => {
    expect(parseExplorerUrl('https://etherscan.io')).toBe('https://etherscan.io')
    expect(parseExplorerUrl('https://etherscan.io/')).toBe('https://etherscan.io')
    expect(parseExplorerUrl(' https://explorer.example/chain// ')).toBe('https://explorer.example/chain')
  })

  it('rejects anything that is not a plain https URL', () => {
    for (const value of [
      'http://etherscan.io',
      'javascript:alert(1)',
      'https://user:secret@etherscan.io',
      'https://etherscan.io?x=1',
      'https://etherscan.io#top',
      'not a url',
      '',
      42,
      null,
      undefined,
    ]) {
      expect(parseExplorerUrl(value)).toBeUndefined()
    }
  })
})

describe('readChainRegistry', () => {
  it('collects statuses and explorer URLs by chain id', () => {
    const registry = readChainRegistry([
      { chainId: 1, status: 'production', explorerUrl: 'https://etherscan.io/' },
      { chainId: 137, status: 'unlisted' },
      { chainId: 146, status: 'testing', explorerUrl: 'http://insecure.example' },
      { chainId: 8453 },
      { status: 'production' },
      'garbage',
    ])

    expect(registry).toEqual({
      statuses: { 1: 'production', 137: 'unlisted', 146: 'staging' },
      explorerUrls: { 1: 'https://etherscan.io' },
    })
  })

  it('is empty when no manifest is available', () => {
    expect(readChainRegistry(undefined)).toEqual({ statuses: {}, explorerUrls: {} })
  })
})

describe('isChainShown', () => {
  it('hides unlisted chains everywhere', () => {
    expect(isChainShown('unlisted', false)).toBe(false)
    expect(isChainShown('unlisted', true)).toBe(false)
  })

  it('shows staging chains only outside production', () => {
    expect(isChainShown('staging', false)).toBe(true)
    expect(isChainShown('staging', true)).toBe(false)
  })

  it('shows production, deprecated and unknown-to-the-registry chains', () => {
    for (const isProduction of [false, true]) {
      expect(isChainShown('production', isProduction)).toBe(true)
      expect(isChainShown('deprecated', isProduction)).toBe(true)
      expect(isChainShown(undefined, isProduction)).toBe(true)
    }
  })
})

describe('applyChainRegistry', () => {
  const registry = readChainRegistry([
    { chainId: 1, status: 'production', explorerUrl: 'https://etherscan.io' },
    { chainId: 137, status: 'unlisted', explorerUrl: 'https://polygonscan.com' },
    { chainId: 146, status: 'deprecated' },
    { chainId: 8453, status: 'staging', explorerUrl: 'https://basescan.org' },
  ])

  it('drops unlisted chains and keeps staging chains outside production', () => {
    const config = applyChainRegistry(envConfig(), registry, false)

    expect(config.enabledChainIds).toEqual([1, 146, 8453])
    expect(config.explorerUrls).toEqual({ 1: 'https://etherscan.io', 8453: 'https://basescan.org' })
  })

  it('drops staging chains in production', () => {
    const config = applyChainRegistry(envConfig(), registry, true)

    expect(config.enabledChainIds).toEqual([1, 146])
    expect(config.explorerUrls).toEqual({ 1: 'https://etherscan.io' })
  })

  it('marks a chain deprecated when either the env var or the registry says so', () => {
    const config = applyChainRegistry(envConfig({ deprecatedChainIds: [1] }), registry, false)

    expect(config.deprecatedChainIds).toEqual([1, 146])
  })

  it('removes hidden chains from every per-chain list', () => {
    const config = applyChainRegistry(envConfig({
      deprecatedChainIds: [137, 8453],
      onchainSdkChainIds: [1, 137, 8453],
      eVaultFetchChunkChainIds: [137, 146, 8453],
    }), registry, true)

    expect(config.deprecatedChainIds).toEqual([146])
    expect(config.onchainSdkChainIds).toEqual([1])
    expect(config.eVaultFetchChunkChainIds).toEqual([146])
  })

  it('keeps the env-derived config when the registry is unavailable', () => {
    const env = envConfig({ deprecatedChainIds: [146] })
    const config = applyChainRegistry(env, readChainRegistry(undefined), true)

    expect(config).toEqual({ ...env, explorerUrls: {} })
  })

  it('does not modify the config it is given', () => {
    const env = envConfig()
    const snapshot = structuredClone(env)
    applyChainRegistry(env, registry, true)

    expect(env).toEqual(snapshot)
  })
})
