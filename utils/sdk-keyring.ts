import { getAddress, zeroAddress, type Address, type Hex } from 'viem'
import type { CredentialData } from '@keyringnetwork/keyring-connect-sdk'
import type { KeyringCredentialData, KeyringPluginConfig } from '@eulerxyz/euler-v2-sdk'
import { isVaultKeyring } from '~/utils/eulerLabelsUtils'
import { getVaultHookTarget } from '~/utils/vault-hooks'
import { getPublicClient } from '~/utils/public-client'
import { resolveKeyringContractAddress } from '~/utils/keyring-hook-target'

type CredentialKey = `${number}:${string}:${string}:${number}`

interface CachedCredential {
  credential: KeyringCredentialData
  keyringContractAddress: Address
  rpcUrl: string
}

const credentials = new Map<CredentialKey, CachedCredential>()

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
  keyringContractAddress: Address
  rpcUrl: string
  credential: CredentialData
}) => {
  credentials.set(keyFor(args.chainId, args.account, args.hookTarget, args.policyId), {
    credential: toSdkCredential(args.credential),
    keyringContractAddress: getAddress(args.keyringContractAddress),
    rpcUrl: args.rpcUrl,
  })
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
}) => {
  const cached = credentials.get(keyFor(chainId, account, hookTarget, policyId))
  if (!cached || cached.credential.validUntil <= Math.floor(Date.now() / 1000)) return null

  try {
    const currentKeyringAddress = await resolveKeyringContractAddress(
      getPublicClient(cached.rpcUrl),
      hookTarget,
    )
    if (currentKeyringAddress !== cached.keyringContractAddress) return null
    return cached.credential
  }
  catch {
    return null
  }
}

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
