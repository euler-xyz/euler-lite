import { getAddress, zeroAddress, type Address, type Hex } from 'viem'
import type { CredentialData } from '@keyringnetwork/keyring-connect-sdk'
import type { KeyringCredentialData, KeyringPluginConfig } from '@eulerxyz/euler-v2-sdk'
import { isVaultKeyring } from '~/utils/eulerLabelsUtils'
import { getVaultHookTarget } from '~/utils/vault-hooks'

type CredentialKey = `${number}:${string}:${string}:${number}`

const credentials = new Map<CredentialKey, KeyringCredentialData>()

const keyFor = (chainId: number, account: Address, hookTarget: Address, policyId: number): CredentialKey =>
  `${chainId}:${getAddress(account).toLowerCase()}:${getAddress(hookTarget).toLowerCase()}:${policyId}`

const toSdkCredential = (credential: CredentialData): KeyringCredentialData => ({
  trader: credential.trader as Address,
  policyId: Number(credential.policyId),
  chainId: Number(credential.chainId),
  validUntil: Number(credential.validUntil),
  cost: Number(credential.cost),
  key: credential.key as Hex,
  signature: credential.signature as Hex,
  backdoor: credential.backdoor as Hex,
})

export const setSdkKeyringCredential = (args: {
  chainId: number
  account: Address
  hookTarget: Address
  policyId: number
  credential: CredentialData
}) => {
  credentials.set(keyFor(args.chainId, args.account, args.hookTarget, args.policyId), toSdkCredential(args.credential))
}

export const clearSdkKeyringCredential = (args: {
  chainId: number
  account: Address
  hookTarget: Address
  policyId: number
}) => {
  credentials.delete(keyFor(args.chainId, args.account, args.hookTarget, args.policyId))
}

export const getSdkKeyringCredential: KeyringPluginConfig['getCredentialData'] = async ({
  chainId,
  account,
  hookTarget,
  policyId,
}) => credentials.get(keyFor(chainId, account, hookTarget, policyId)) ?? null

export const buildSdkKeyringHookTargets = (): Record<number, Address[]> => {
  const { chainId } = useEulerAddresses()
  const { getAll } = useVaultRegistry()
  const targets = new Set<Address>()

  for (const entry of getAll()) {
    if (!isVaultKeyring(entry.vault.address)) continue
    const hookTarget = getVaultHookTarget(entry.vault as never)
    if (!hookTarget || getAddress(hookTarget as Address) === zeroAddress) continue
    targets.add(getAddress(hookTarget as Address) as Address)
  }

  if (!targets.size) return {}
  const sorted = [...targets].sort((a, b) => a.localeCompare(b))
  return { [chainId.value]: sorted }
}
