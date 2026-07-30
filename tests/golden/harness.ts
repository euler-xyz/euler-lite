import { type Address, getAddress, maxUint256, zeroAddress } from 'viem'
import { Account, ExecutionService, WalletService, type Deployment, type IDeploymentService, type IWalletAdapter } from '@eulerxyz/euler-v2-sdk'

// Addresses used by golden scenarios.
//   - Chain core (evc, permit2, swapper, swapVerifier, accountLens) are the
//     real Ethereum mainnet deployment from
//     https://raw.githubusercontent.com/euler-xyz/euler-interfaces/refs/heads/master/EulerChains.json
//     The swap-quote tests need real values here so the quotes fetched from
//     swap-dev.euler.finance pass the SDK's verifier-address check.
//   - Tokens (assetUsdc, assetDai, assetWeth, assetUsdt) are real mainnet
//     ERC20s. The swap API requires real tokenIn/tokenOut.
//   - Vaults are placeholder addresses — the swap API doesn't validate them,
//     and the test only asserts they're encoded into batch items consistently
//     between legacy and SDK.
//
// We checksum at module load so the same form is used everywhere; some SDK
// internals (resolveRequiredApprovalsWithWallet) look up allowances by raw
// spender key, so feeding non-checksum addresses there would miss.
const a = (raw: string) => getAddress(raw)
export const ADDR = {
  user: a('0x1111111111111111111111111111111111111111'),
  subAccount1: a('0x1111111111111111111111111111111111111101'),
  // Real Ethereum mainnet (chainId 1) Euler deployment.
  evc: a('0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383'),
  permit2: a('0x000000000022D473030F116dDEE9F6B43aC78BA3'),
  swapper: a('0x719F8b330CcA71cb6195D032A43194C7D3F9Fb45'),
  swapVerifier: a('0x786c900d7D348662703C38B46f24c1cda2C582AB'),
  accountLens: a('0xA60c4257c809353039A71527dfe701B577e34bc7'),
  // Real mainnet ERC20s (needed for swap API quotes).
  assetUsdc: a('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
  assetUsdt: a('0xdAC17F958D2ee523a2206206994597C13D831ec7'),
  assetDai: a('0x6B175474E89094C44Da98b954EedeAC495271d0F'),
  assetWeth: a('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
  // Placeholder vaults: swap API doesn't validate them. We use distinguishable
  // prefixes (0xa00...) so they're easy to spot in calldata diffs.
  vaultUsdc: a('0xa000000000000000000000000000000000000001'),
  vaultUsdt: a('0xa000000000000000000000000000000000000004'),
  vaultDai: a('0xa000000000000000000000000000000000000002'),
  vaultWeth: a('0xa000000000000000000000000000000000000003'),
} as const

export const CHAIN_ID = 1
export const HIGH_ALLOWANCE = maxUint256

// ---------------------------------------------------------------------------
// SDK side
// ---------------------------------------------------------------------------

const stubDeployment: Deployment = {
  chainId: CHAIN_ID,
  name: 'golden',
  status: 'active',
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
