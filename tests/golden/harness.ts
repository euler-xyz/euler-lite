import { type Address, getAddress, maxUint256, zeroAddress } from 'viem'
import { Account, ExecutionService, WalletService, type Deployment, type IDeploymentService, type IWalletAdapter } from '@eulerxyz/euler-v2-sdk'

import { loadDeploymentFixture } from './load-fixture'

export const CHAIN_ID = 1

const deployment = loadDeploymentFixture(CHAIN_ID)

// Checksummed because resolveRequiredApprovalsWithWallet looks up allowances by
// raw spender key. Tokens must be real mainnet ERC20s for the swap API; vaults
// are placeholders it does not validate.
const a = (raw: string) => getAddress(raw)
export const ADDR = {
  user: a('0x1111111111111111111111111111111111111111'),
  subAccount1: a('0x1111111111111111111111111111111111111101'),
  evc: deployment.evc,
  permit2: deployment.permit2,
  swapper: deployment.swapper,
  swapVerifier: deployment.swapVerifier,
  accountLens: deployment.accountLens,
  assetUsdc: a('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
  assetUsdt: a('0xdAC17F958D2ee523a2206206994597C13D831ec7'),
  assetDai: a('0x6B175474E89094C44Da98b954EedeAC495271d0F'),
  assetWeth: a('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
  vaultUsdc: a('0xa000000000000000000000000000000000000001'),
  vaultUsdt: a('0xa000000000000000000000000000000000000004'),
  vaultDai: a('0xa000000000000000000000000000000000000002'),
  vaultWeth: a('0xa000000000000000000000000000000000000003'),
} as const

export const HIGH_ALLOWANCE = maxUint256

// ---------------------------------------------------------------------------
// SDK side
// ---------------------------------------------------------------------------

const stubDeployment: Deployment = {
  chainId: CHAIN_ID,
  name: 'golden',
  status: 'production',
  addresses: {
    coreAddrs: {
      balanceTracker: zeroAddress as Address,
      eVaultFactory: zeroAddress as Address,
      eVaultImplementation: zeroAddress as Address,
      eulerEarnFactory: zeroAddress as Address,
      evc: ADDR.evc,
      permit2: ADDR.permit2,
      protocolConfig: zeroAddress as Address,
      sequenceRegistry: zeroAddress as Address,
    },
    lensAddrs: {
      accountLens: ADDR.accountLens,
      eulerEarnVaultLens: zeroAddress as Address,
      irmLens: zeroAddress as Address,
      oracleLens: zeroAddress as Address,
      utilsLens: zeroAddress as Address,
      vaultLens: zeroAddress as Address,
    },
    peripheryAddrs: {
      swapper: ADDR.swapper,
      swapVerifier: ADDR.swapVerifier,
    },
  },
}

class StubDeploymentService implements IDeploymentService {
  getDeploymentChainIds() { return [CHAIN_ID] }
  getDeployment(chainId: number) {
    if (chainId !== CHAIN_ID) throw new Error(`unexpected chain: ${chainId}`)
    return stubDeployment
  }

  addDeployment() { /* noop */ }
}

// Reports a sufficient balance and a maxUint256 allowance for every spender, so
// resolveRequiredApprovals takes the "already approved" path and plans contain
// no ERC20 approve (the canary asserts the EVC batch calldata, not approvals).
class HighAllowanceWalletAdapter implements IWalletAdapter {
  async fetchWallet(chainId: number, account: Address, assetsWithSpenders: { asset: Address, spenders?: Address[] }[]) {
    const assets = assetsWithSpenders.map(({ asset, spenders }) => ({
      account: getAddress(account),
      asset: getAddress(asset),
      balance: HIGH_ALLOWANCE,
      allowances: Object.fromEntries((spenders ?? []).map(spender => [
        getAddress(spender),
        {
          assetForVault: HIGH_ALLOWANCE,
          assetForPermit2: HIGH_ALLOWANCE,
          assetForVaultInPermit2: HIGH_ALLOWANCE,
          permit2ExpirationTime: 2 ** 31,
          permit2Nonce: 0,
        },
      ])),
    }))
    return {
      result: { chainId, account, assets },
      errors: [],
    }
  }
}

export function buildSdkExecutionService() {
  return new ExecutionService(new StubDeploymentService(), new WalletService(new HighAllowanceWalletAdapter()))
}

export interface SeedPosition {
  subAccount: Address
  vault: Address
  asset: Address
  borrowed?: bigint
  shares?: bigint
  assets?: bigint
  isController?: boolean
  isCollateral?: boolean
}

export interface SeedSubAccountState {
  subAccount: Address
  enabledControllers?: Address[]
  enabledCollaterals?: Address[]
}

/**
 * Returns an SDK `Account`. By default it's a "fresh wallet, no positions"
 * snapshot — pass `positions` to seed sub-account state the planners need
 * (e.g. `planRepayFromWallet` reads `position.asset` and `position.borrowed`
 * via `account.getPosition(...)`).
 */
export function buildSdkAccount(opts: {
  owner?: Address
  positions?: SeedPosition[]
  subAccounts?: SeedSubAccountState[]
} = {}) {
  const owner = opts.owner ?? ADDR.user
  const positions = opts.positions ?? []
  const subAccounts: Record<Address, {
    timestamp: number
    account: Address
    owner: Address
    lastAccountStatusCheckTimestamp: number
    enabledControllers: Address[]
    enabledCollaterals: Address[]
    positions: Array<{
      account: Address
      vaultAddress: Address
      asset: Address
      shares: bigint
      assets: bigint
      borrowed: bigint
      isController: boolean
      isCollateral: boolean
      balanceForwarderEnabled: boolean
    }>
  }> = {}
  for (const p of positions) {
    if (!subAccounts[p.subAccount]) {
      subAccounts[p.subAccount] = {
        timestamp: 0,
        account: p.subAccount,
        owner,
        lastAccountStatusCheckTimestamp: 0,
        enabledControllers: [],
        enabledCollaterals: [],
        positions: [],
      }
    }
    const sa = subAccounts[p.subAccount]
    sa.positions.push({
      account: p.subAccount,
      vaultAddress: p.vault,
      asset: p.asset,
      shares: p.shares ?? 0n,
      assets: p.assets ?? 0n,
      borrowed: p.borrowed ?? 0n,
      isController: p.isController ?? (p.borrowed !== undefined && p.borrowed > 0n),
      isCollateral: p.isCollateral ?? false,
      balanceForwarderEnabled: false,
    })
    if (p.isController ?? (p.borrowed !== undefined && p.borrowed > 0n)) {
      if (!sa.enabledControllers.includes(p.vault)) sa.enabledControllers.push(p.vault)
    }
    if (p.isCollateral) {
      if (!sa.enabledCollaterals.includes(p.vault)) sa.enabledCollaterals.push(p.vault)
    }
  }
  for (const state of opts.subAccounts ?? []) {
    if (!subAccounts[state.subAccount]) {
      subAccounts[state.subAccount] = {
        timestamp: 0,
        account: state.subAccount,
        owner,
        lastAccountStatusCheckTimestamp: 0,
        enabledControllers: [],
        enabledCollaterals: [],
        positions: [],
      }
    }
    const sa = subAccounts[state.subAccount]
    for (const controller of state.enabledControllers ?? []) {
      if (!sa.enabledControllers.includes(controller)) sa.enabledControllers.push(controller)
    }
    for (const collateral of state.enabledCollaterals ?? []) {
      if (!sa.enabledCollaterals.includes(collateral)) sa.enabledCollaterals.push(collateral)
    }
  }
  return new Account({
    chainId: CHAIN_ID,
    owner,
    subAccounts: subAccounts as never,
  })
}
