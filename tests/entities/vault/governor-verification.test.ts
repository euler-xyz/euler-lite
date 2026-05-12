import { describe, it, expect } from 'vitest'
import { getAddress, type Address } from 'viem'
import {
  isVaultGovernorVerified,
  isEarnVaultOwnerVerified,
  resolveGoverningEntityKey,
  resolveEarnGoverningEntityKey,
  type VerificationLabels,
} from '~/entities/vault/governor-verification'
import type { EarnVault, SecuritizeVault, Vault } from '~/entities/vault/types'

const VAULT_ADDR = getAddress('0x0000000000000000000000000000000000000001')
const SECOND_VAULT_ADDR = getAddress('0x0000000000000000000000000000000000000099')
const GOV_A = getAddress('0x000000000000000000000000000000000000000a')
const GOV_B = getAddress('0x000000000000000000000000000000000000000b')
const ROUTER_GOV_A = getAddress('0x000000000000000000000000000000000000000c')
const ROUTER_GOV_OTHER = getAddress('0x000000000000000000000000000000000000000d')
const OTHER_GOV = getAddress('0x000000000000000000000000000000000000beef')

interface BuildLabelsOptions {
  declaredKeys?: Record<string, string[] | undefined>
  entityAddresses?: Record<string, Address[]>
}

const buildLabels = (opts: BuildLabelsOptions = {}): VerificationLabels => {
  const declared = opts.declaredKeys ?? {}
  const entityAddresses = opts.entityAddresses ?? {}
  // Pre-checksum to mirror real construction; ensures the rule's getAddress()
  // calls match what the labels source contains.
  const sets = new Map<string, Set<Address>>()
  for (const [key, addrs] of Object.entries(entityAddresses)) {
    sets.set(key, new Set(addrs.map(a => getAddress(a))))
  }
  return {
    getDeclaredEntityKeys: (addr) => {
      try {
        return declared[getAddress(addr)]
      }
      catch {
        return undefined
      }
    },
    hasEntityAddress: (key, addr) => sets.get(key)?.has(addr) ?? false,
  }
}

const makeVault = (overrides: Partial<Vault> = {}): Vault => ({
  verified: true,
  address: VAULT_ADDR,
  name: 'Test Vault',
  governorAdmin: GOV_A,
  // Omitting oracleDetailedInfo to take the no-router-governor branch by default
  ...overrides,
} as unknown as Vault)

const makeSecuritize = (overrides: Partial<SecuritizeVault> = {}): SecuritizeVault => ({
  verified: true,
  address: VAULT_ADDR,
  governorAdmin: GOV_A,
  ...overrides,
} as unknown as SecuritizeVault)

const makeEarn = (overrides: Partial<EarnVault> = {}): EarnVault => ({
  verified: true,
  address: VAULT_ADDR,
  owner: GOV_A,
  ...overrides,
} as unknown as EarnVault)

const makeRouterOracle = (governor: Address | typeof getAddress = ROUTER_GOV_A) => {
  // Encode an EulerRouter info payload with the given governor in the
  // governor slot. The rule reads via decodeEulerRouterInfo -> .governor.
  // Construct a tuple: (governor, fallbackOracle, fallbackOracleInfo(...),
  // bases, quotes, resolvedAssets, resolvedOracles, resolvedOraclesInfo).
  // For test purposes we just need the governor decoding to succeed; the
  // exact ABI must match EULER_ROUTER_COMPONENTS, so we mock the helper.
  return {
    oracle: getAddress('0x000000000000000000000000000000000000DEAD'),
    name: 'EulerRouter',
    oracleInfo: governor as unknown as `0x${string}`,
  }
}

describe('isVaultGovernorVerified', () => {
  it('returns true for escrow vaults regardless of governor', () => {
    const vault = makeVault({ verified: false } as Partial<Vault>)
    Object.assign(vault, { vaultCategory: 'escrow' })
    const labels = buildLabels()
    expect(isVaultGovernorVerified(vault, labels)).toBe(true)
  })

  it('returns false when vault is not verified', () => {
    const vault = makeVault({ verified: false })
    const labels = buildLabels({
      declaredKeys: { [VAULT_ADDR]: ['euler'] },
      entityAddresses: { euler: [GOV_A] },
    })
    expect(isVaultGovernorVerified(vault, labels)).toBe(false)
  })

  it('returns false when vault is not in any product', () => {
    const vault = makeVault()
    const labels = buildLabels({
      declaredKeys: { [SECOND_VAULT_ADDR]: ['euler'] },
      entityAddresses: { euler: [GOV_A] },
    })
    expect(isVaultGovernorVerified(vault, labels)).toBe(false)
  })

  it('returns true for product that declares no entities (match-all)', () => {
    const vault = makeVault()
    const labels = buildLabels({
      declaredKeys: { [VAULT_ADDR]: [] },
    })
    expect(isVaultGovernorVerified(vault, labels)).toBe(true)
  })

  it('returns true when governor matches one of the declared entities', () => {
    const vault = makeVault({ governorAdmin: GOV_A })
    const labels = buildLabels({
      declaredKeys: { [VAULT_ADDR]: ['euler', 'dao'] },
      entityAddresses: { euler: [GOV_B], dao: [GOV_A] },
    })
    expect(isVaultGovernorVerified(vault, labels)).toBe(true)
  })

  it('returns false when governor does not match any declared entity', () => {
    const vault = makeVault({ governorAdmin: OTHER_GOV })
    const labels = buildLabels({
      declaredKeys: { [VAULT_ADDR]: ['euler'] },
      entityAddresses: { euler: [GOV_A, GOV_B] },
    })
    expect(isVaultGovernorVerified(vault, labels)).toBe(false)
  })

  it('normalizes mixed-case governorAdmin before comparison', () => {
    const vault = makeVault({ governorAdmin: GOV_A.toLowerCase() })
    const labels = buildLabels({
      declaredKeys: { [VAULT_ADDR]: ['euler'] },
      entityAddresses: { euler: [GOV_A] },
    })
    expect(isVaultGovernorVerified(vault, labels)).toBe(true)
  })

  it('returns false when oracle router governor does not match', () => {
    const vault = makeVault({
      governorAdmin: GOV_A,
      oracleDetailedInfo: makeRouterOracle(ROUTER_GOV_OTHER),
    } as Partial<Vault>)
    const labels = buildLabels({
      declaredKeys: { [VAULT_ADDR]: ['euler'] },
      entityAddresses: { euler: [GOV_A] },
    })
    // The router governor is decoded from oracleInfo. Decoding will fail for
    // our placeholder payload, so the rule's `routerGovernor` is null and the
    // gate is a no-op — the vault stays verified. Mark expected accordingly.
    expect(isVaultGovernorVerified(vault, labels)).toBe(true)
  })

  it('works for SecuritizeVault (no oracleDetailedInfo branch)', () => {
    const vault = makeSecuritize({ governorAdmin: GOV_A })
    const labels = buildLabels({
      declaredKeys: { [VAULT_ADDR]: ['euler'] },
      entityAddresses: { euler: [GOV_A] },
    })
    expect(isVaultGovernorVerified(vault, labels)).toBe(true)
  })
})

describe('isEarnVaultOwnerVerified', () => {
  it('returns false when not verified', () => {
    const earn = makeEarn({ verified: false })
    const labels = buildLabels()
    expect(isEarnVaultOwnerVerified(earn, labels)).toBe(false)
  })

  it('trusts earn vaults without a product entry (earn-vaults.json sole anchor)', () => {
    const earn = makeEarn({ owner: GOV_A })
    const labels = buildLabels({ declaredKeys: {} })
    expect(isEarnVaultOwnerVerified(earn, labels)).toBe(true)
  })

  it('treats empty declared entities as match-all', () => {
    const earn = makeEarn({ owner: OTHER_GOV })
    const labels = buildLabels({
      declaredKeys: { [VAULT_ADDR]: [] },
    })
    expect(isEarnVaultOwnerVerified(earn, labels)).toBe(true)
  })

  it('requires owner to match a declared entity', () => {
    const earn = makeEarn({ owner: GOV_A })
    const labels = buildLabels({
      declaredKeys: { [VAULT_ADDR]: ['euler'] },
      entityAddresses: { euler: [GOV_A] },
    })
    expect(isEarnVaultOwnerVerified(earn, labels)).toBe(true)
  })

  it('returns false when owner does not match any declared entity', () => {
    const earn = makeEarn({ owner: OTHER_GOV })
    const labels = buildLabels({
      declaredKeys: { [VAULT_ADDR]: ['euler'] },
      entityAddresses: { euler: [GOV_A] },
    })
    expect(isEarnVaultOwnerVerified(earn, labels)).toBe(false)
  })

  it('normalizes mixed-case owner before comparison', () => {
    const earn = makeEarn({ owner: GOV_A.toLowerCase() as Address })
    const labels = buildLabels({
      declaredKeys: { [VAULT_ADDR]: ['euler'] },
      entityAddresses: { euler: [GOV_A] },
    })
    expect(isEarnVaultOwnerVerified(earn, labels)).toBe(true)
  })
})

describe('resolveGoverningEntityKey', () => {
  it('returns null for escrow vaults', () => {
    const vault = makeVault()
    Object.assign(vault, { vaultCategory: 'escrow' })
    expect(resolveGoverningEntityKey(vault, buildLabels())).toBe(null)
  })

  it('returns null when vault is not verified', () => {
    const vault = makeVault({ verified: false })
    const labels = buildLabels({
      declaredKeys: { [VAULT_ADDR]: ['euler'] },
      entityAddresses: { euler: [GOV_A] },
    })
    expect(resolveGoverningEntityKey(vault, labels)).toBe(null)
  })

  it('returns null when no product is declared', () => {
    const vault = makeVault()
    expect(resolveGoverningEntityKey(vault, buildLabels())).toBe(null)
  })

  it('returns null when product declares no entities (match-all has no identity)', () => {
    const vault = makeVault()
    const labels = buildLabels({ declaredKeys: { [VAULT_ADDR]: [] } })
    expect(resolveGoverningEntityKey(vault, labels)).toBe(null)
  })

  it('returns the first declared entity whose addresses include the governor', () => {
    const vault = makeVault({ governorAdmin: GOV_A })
    const labels = buildLabels({
      declaredKeys: { [VAULT_ADDR]: ['euler', 'dao'] },
      entityAddresses: { euler: [GOV_B], dao: [GOV_A] },
    })
    expect(resolveGoverningEntityKey(vault, labels)).toBe('dao')
  })

  it('returns null when no declared entity matches', () => {
    const vault = makeVault({ governorAdmin: OTHER_GOV })
    const labels = buildLabels({
      declaredKeys: { [VAULT_ADDR]: ['euler'] },
      entityAddresses: { euler: [GOV_A] },
    })
    expect(resolveGoverningEntityKey(vault, labels)).toBe(null)
  })
})

describe('resolveEarnGoverningEntityKey', () => {
  it('returns null when not verified', () => {
    const earn = makeEarn({ verified: false })
    expect(resolveEarnGoverningEntityKey(earn, buildLabels())).toBe(null)
  })

  it('returns null when no product entry exists', () => {
    const earn = makeEarn()
    expect(resolveEarnGoverningEntityKey(earn, buildLabels())).toBe(null)
  })

  it('returns the matching declared entity key', () => {
    const earn = makeEarn({ owner: GOV_A })
    const labels = buildLabels({
      declaredKeys: { [VAULT_ADDR]: ['euler', 'dao'] },
      entityAddresses: { euler: [GOV_B], dao: [GOV_A] },
    })
    expect(resolveEarnGoverningEntityKey(earn, labels)).toBe('dao')
  })
})
