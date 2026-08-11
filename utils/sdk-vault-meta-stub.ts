/**
 * Registry-backed `IVaultMetaService` stub used by client-side snapshot
 * hydration (see `composables/useVaults.ts:hydrateFromServer`).
 *
 * The two SDK methods that drive cross-reference wiring —
 * `EVault.populateCollaterals(meta)` and
 * `EulerEarn.populateStrategyVaults(meta)` — both only call
 * `meta.fetchVault(chainId, addr)`. Everything else on `this` they consume
 * is already populated by the constructor from the snapshot args.
 *
 * So during hydration we instantiate every vault into the registry first
 * (pass 1), then call `populate*` for each instance with this stub (pass
 * 2). The stub turns each `fetchVault` into a synchronous registry lookup
 * wrapped in a resolved `ServiceResult` — pure-memory, no RPC.
 *
 * The other `IVaultMetaService` methods throw. They aren't reached by the
 * populate paths above; if a future SDK release routes a populate call
 * through any of them we'd rather hear about it loudly than silently
 * return wrong data.
 */
import type {
  FetchAllVaultsArgs,
  IVaultMetaService,
  ServiceResult,
  VaultEntity,
  VaultFetchOptions,
} from '@eulerxyz/euler-v2-sdk'
import type { Address } from 'viem'
import type { useVaultRegistry } from '~/composables/useVaultRegistry'

type Registry = ReturnType<typeof useVaultRegistry>

const notImplemented = (method: string) => {
  return () => {
    throw new Error(
      `registry meta-stub: ${method}() not supported — this method should not be reached during snapshot hydrate`,
    )
  }
}

export const buildRegistryMetaService = (registry: Registry): IVaultMetaService<VaultEntity> => ({
  async fetchVault(_chainId: number, address: Address): Promise<ServiceResult<VaultEntity | undefined>> {
    const vault = registry.getVault(address) as VaultEntity | undefined
    return { result: vault, errors: [] }
  },

  registerVaultService: notImplemented('registerVaultService'),
  async fetchVaultType(): Promise<string | undefined> {
    throw new Error('registry meta-stub: fetchVaultType() not supported')
  },
  async fetchVaultTypes(): Promise<Partial<Record<Address, string>>> {
    throw new Error('registry meta-stub: fetchVaultTypes() not supported')
  },
  getFactoryByType(): Address | undefined { return undefined },
  async fetchVaults(
    _chainId: number,
    _vaults: Address[],
    _options?: VaultFetchOptions,
  ): Promise<ServiceResult<(VaultEntity | undefined)[]>> {
    throw new Error('registry meta-stub: fetchVaults() not supported')
  },
  async fetchPerspectiveVaultAddresses(): Promise<Address[]> {
    throw new Error('registry meta-stub: fetchPerspectiveVaultAddresses() not supported')
  },
  async fetchPerspectiveVaults(): Promise<ServiceResult<(VaultEntity | undefined)[]>> {
    throw new Error('registry meta-stub: fetchPerspectiveVaults() not supported')
  },
  async fetchAllVaults(
    _chainId: number,
    _args?: FetchAllVaultsArgs<VaultEntity, VaultFetchOptions>,
  ): Promise<ServiceResult<(VaultEntity | undefined)[]>> {
    throw new Error('registry meta-stub: fetchAllVaults() not supported')
  },
})
