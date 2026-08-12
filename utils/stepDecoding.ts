import { decodeAbiParameters, decodeFunctionData, formatUnits, getAddress, parseAbi, toFunctionSelector, zeroAddress, type Address, type Hex } from 'viem'
import { flattenBatchEntries, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { SwapperMode } from '@eulerxyz/euler-v2-sdk'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StepAssetInfo {
  symbol: string
  address?: string
  /** Optional address used only for the displayed asset logo. */
  iconAddress?: string
  amount?: number | string
  iconUrl?: string
  /** When true, the displayed amount is an estimate (rendered with a "~" prefix). */
  estimated?: boolean
}

export interface StepKnownAsset {
  symbol: string
  address: string
  decimals?: number | bigint
}

export interface StepKnownSwapOutput {
  tokenIn?: string
  tokenOut: string
  amountOut?: number | string
}

export interface DisplayStep {
  index: number
  label: string
  labelSuffix?: string
  isSeparateTx: boolean
  assetInfo?: StepAssetInfo
  toAssetInfo?: StepAssetInfo
  iconOnly?: boolean
  /**
   * Identity of the underlying encoded transaction, present when the step
   * maps 1:1 to a concrete transaction. Rows sharing a txKey ARE the same
   * transaction and may be consolidated in summaries; rows without one must
   * never be — labels are generic per authorization type, so two different
   * tokens can share a label while being distinct transactions.
   */
  txKey?: string
}

/** Structurally matches useVaultRegistry().getVault */
export type VaultLookup = (address: string) => {
  asset: { symbol: string, address: string, decimals: number | bigint }
} | undefined

export interface StepDecodingContext {
  type?: string
  asset: { symbol: string, address: string, decimals?: number | bigint }
  assetIconUrl?: string
  amount: number | string
  supplyingAssetForBorrow?: StepKnownAsset
  supplyingAmount?: number | string
  swapFromAsset?: { symbol: string, address: string, decimals?: number | bigint }
  swapFromAmount?: number | string
  swapToAsset?: { symbol: string, address: string, decimals: number | bigint }
  swapToAmount?: number | string
  swapMode?: SwapperMode
  swapEstimatedSide?: 'input' | 'output'
  transferAmounts?: Record<string, string>
  knownAssets?: StepKnownAsset[]
  swapQuoteOutputs?: StepKnownSwapOutput[]
  vaultAmounts?: Record<string, string>
  /**
   * Approvals are submitted in the same wallet submission as the batch
   * (Safe wallets bundle them via EIP-5792), so approve steps are not
   * separate transactions.
   */
  bundledApprovals?: boolean
}

type KnownAsset = StepKnownAsset

type KnownAssetMap = Record<string, KnownAsset>

type BatchDisplayAction = {
  targetContract: string
  onBehalfOfAccount: string
  value: bigint
  data: Hex
  label: string
  swapOutput?: {
    tokenIn?: Address
    token: Address
    amount?: bigint
  }
}

type SwapperSwapParams = {
  handler: Hex
  mode: bigint
  account: Address
  tokenIn: Address
  tokenOut: Address
  vaultIn: Address
  accountIn: Address
  receiver: Address
  amountOut: bigint
  data: Hex
}

type MorphoMarketParams = {
  loanToken: Address
  collateralToken: Address
  oracle: Address
  irm: Address
  lltv: bigint
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VERIFY_AMOUNT_MIN_AND_DEPOSIT_SELECTOR = toFunctionSelector('function verifyAmountMinAndDeposit(address,address,uint256,uint256)')
const VERIFY_AMOUNT_MIN_AND_SKIM_SELECTOR = toFunctionSelector('function verifyAmountMinAndSkim(address,address,uint256,uint256)')
const VERIFY_AMOUNT_MIN_AND_TRANSFER_SELECTOR = toFunctionSelector('function verifyAmountMinAndTransfer(address,address,uint256,uint256)')
const VERIFY_DEBT_MAX_SELECTOR = toFunctionSelector('function verifyDebtMax(address,address,uint256,uint256)')
const AAVE_BORROW_FOR_SENDER_SELECTOR = toFunctionSelector('function aaveBorrowForSender(address,address,uint256,address)')
const AAVE_DELEGATION_WITH_SIG_SELECTOR = toFunctionSelector('function delegationWithSig(address,address,uint256,uint256,uint8,bytes32,bytes32)')
const AAVE_PERMIT_SELECTOR = toFunctionSelector('function permit(address,address,uint256,uint256,uint8,bytes32,bytes32)')
const MERKL_CLAIM_SELECTOR = toFunctionSelector('function claim(address[],address[],uint256[],bytes32[][])')
const BREVIS_CLAIM_SELECTOR = toFunctionSelector('function claim(address,uint256[],uint64,bytes32[])')
const FUUL_CLAIM_SELECTOR = toFunctionSelector('function claim((address,address,address,uint8,uint256,uint8,uint256,uint256,bytes32,bytes[])[])')
const REUL_UNLOCK_SELECTOR = toFunctionSelector('function withdrawToByLockTimestamp(address,uint256,bool)')
const MORPHO_AUTHORIZATION_SELECTOR = toFunctionSelector('function setAuthorizationWithSig((address,address,bool,uint256,uint256),(uint8,bytes32,bytes32))')
const MORPHO_BORROW_FOR_SENDER_SELECTOR = toFunctionSelector('function morphoBorrowForSender(address,(address,address,address,address,uint256),uint256,address)')
const MORPHO_WITHDRAW_COLLATERAL_FOR_SENDER_SELECTOR = toFunctionSelector('function morphoWithdrawCollateralForSender(address,(address,address,address,address,uint256),uint256,address)')
const SWAPPER_DEPOSIT_SELECTOR = toFunctionSelector('function deposit(address,address,uint256,address)')
const SWAPPER_MULTICALL_SELECTOR = toFunctionSelector('function multicall(bytes[])')
const SWAPPER_REPAY_AND_DEPOSIT_SELECTOR = toFunctionSelector('function repayAndDeposit(address,address,uint256,address)')
const SWAPPER_REPAY_SELECTOR = toFunctionSelector('function repay(address,address,uint256,address)')
const SWAPPER_SWAP_SELECTOR = toFunctionSelector('function swap((bytes32,uint256,address,address,address,address,address,address,uint256,bytes))')
const SWAPPER_SWEEP_SELECTOR = toFunctionSelector('function sweep(address,uint256,address)')
const SWAPPER_TRANSFER_SELECTOR = toFunctionSelector('function transfer(address,uint256,address)')
const TRANSFER_BALANCE_FROM_SENDER_SELECTOR = toFunctionSelector('function transferBalanceFromSender(address,uint256,address)')
const TRANSFER_FROM_SENDER_SELECTOR = toFunctionSelector('function transferFromSender(address,uint256,address)')

const SWAPPER_ABI = parseAbi([
  'function deposit(address token,address vault,uint256 amountMin,address account)',
  'function multicall(bytes[] calls)',
  'function repay(address token,address vault,uint256 repayAmount,address account)',
  'function repayAndDeposit(address token,address vault,uint256 repayAmount,address account)',
  'function swap((bytes32 handler,uint256 mode,address account,address tokenIn,address tokenOut,address vaultIn,address accountIn,address receiver,uint256 amountOut,bytes data) params)',
  'function sweep(address token,uint256 amountMin,address to)',
  'function transfer(address token,uint256 amountMin,address receiver)',
])

const MORPHO_BLUE_ABI = parseAbi([
  'function repay((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,uint256 assets,uint256 shares,address onBehalf,bytes data)',
  'function setAuthorizationWithSig((address authorizer,address authorized,bool isAuthorized,uint256 nonce,uint256 deadline) authorization,(uint8 v,bytes32 r,bytes32 s) signature)',
  'function supplyCollateral((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,uint256 assets,address onBehalf,bytes data)',
])

const SWAP_VERIFIER_ABI = parseAbi([
  'function aaveBorrowForSender(address pool,address asset,uint256 amount,address to)',
  'function morphoBorrowForSender(address morpho,(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,uint256 amount,address to)',
  'function morphoWithdrawCollateralForSender(address morpho,(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,uint256 amount,address to)',
  'function transferBalanceFromSender(address token,uint256 maxAmount,address to)',
  'function transferFromSender(address token,uint256 amount,address to)',
  'function verifyAmountMinAndDeposit(address vault,address receiver,uint256 amountMin,uint256 deadline)',
])

const AAVE_POOL_ABI = parseAbi([
  'function repay(address asset,uint256 amount,uint256 interestRateMode,address onBehalfOf)',
  'function supply(address asset,uint256 amount,address onBehalfOf,uint16 referralCode)',
  'function withdraw(address asset,uint256 amount,address to)',
])

const AAVE_TOKEN_AUTH_ABI = parseAbi([
  'function delegationWithSig(address delegator,address delegatee,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
  'function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
])

const GENERIC_HANDLER_DATA_ABI = [
  { name: 'target', type: 'address' },
  { name: 'payload', type: 'bytes' },
] as const

const SELECTOR_LABELS: Record<string, string> = {
  [toFunctionSelector('function deposit(uint256,address)')]: 'Supply',
  [toFunctionSelector('function borrow(uint256,address)')]: 'Borrow',
  [toFunctionSelector('function repay(uint256,address)')]: 'Repay',
  [toFunctionSelector('function withdraw(uint256,address,address)')]: 'Withdraw',
  [toFunctionSelector('function redeem(uint256,address,address)')]: 'Withdraw',
  [toFunctionSelector('function enableController(address,address)')]: 'Enable controller',
  [toFunctionSelector('function enableCollateral(address,address)')]: 'Enable collateral',
  [toFunctionSelector('function disableController()')]: 'Disable controller',
  [toFunctionSelector('function disableCollateral(address,address)')]: 'Disable collateral',
  [toFunctionSelector('function transfer(address,uint256)')]: 'Transfer',
  [toFunctionSelector('function transferFromMax(address,address)')]: 'Transfer to account',
  [toFunctionSelector('function skim(uint256,address)')]: 'Deposit',
  [toFunctionSelector('function repayWithShares(uint256,address)')]: 'Repay',
  [toFunctionSelector('function signTermsOfUse(string,bytes32)')]: 'Sign terms of use',
  [SWAPPER_MULTICALL_SELECTOR]: 'Swap',
  [SWAPPER_SWAP_SELECTOR]: 'Swap',
  [SWAPPER_DEPOSIT_SELECTOR]: 'Swapper deposit',
  [SWAPPER_REPAY_SELECTOR]: 'Swapper repay',
  [SWAPPER_REPAY_AND_DEPOSIT_SELECTOR]: 'Swapper repay',
  [SWAPPER_SWEEP_SELECTOR]: 'Swapper sweep',
  [SWAPPER_TRANSFER_SELECTOR]: 'Swapper transfer',
  [VERIFY_AMOUNT_MIN_AND_DEPOSIT_SELECTOR]: 'Verify min received',
  [VERIFY_AMOUNT_MIN_AND_SKIM_SELECTOR]: 'Verify min received',
  [VERIFY_AMOUNT_MIN_AND_TRANSFER_SELECTOR]: 'Verify min received',
  [VERIFY_DEBT_MAX_SELECTOR]: 'Verify max debt',
  [toFunctionSelector('function updatePriceFeeds(bytes[])')]: 'Update price feeds',
  [TRANSFER_FROM_SENDER_SELECTOR]: 'Transfer from wallet',
  [TRANSFER_BALANCE_FROM_SENDER_SELECTOR]: 'Transfer from wallet',
  [AAVE_BORROW_FOR_SENDER_SELECTOR]: 'Borrow on Aave',
  [AAVE_DELEGATION_WITH_SIG_SELECTOR]: 'Apply Aave debt delegation',
  [AAVE_PERMIT_SELECTOR]: 'Apply Aave permit',
  [MORPHO_BORROW_FOR_SENDER_SELECTOR]: 'Borrow on Morpho',
  [MORPHO_WITHDRAW_COLLATERAL_FOR_SENDER_SELECTOR]: 'Withdraw Morpho collateral',
  [toFunctionSelector('function deposit()')]: 'Wrap native currency',
  [toFunctionSelector('function createCredential(address,uint256,uint256,uint256,uint256,bytes,bytes,bytes)')]: 'Identity verification',
  [MERKL_CLAIM_SELECTOR]: 'Claim',
  [BREVIS_CLAIM_SELECTOR]: 'Claim',
  [FUUL_CLAIM_SELECTOR]: 'Claim',
  [REUL_UNLOCK_SELECTOR]: 'Unlock',
}

const MAX_UINT256 = 2n ** 256n - 1n
const SHARES_AMOUNT_SELECTORS = new Set([
  toFunctionSelector('function redeem(uint256,address,address)'),
  toFunctionSelector('function repayWithShares(uint256,address)'),
])
const isSharesAmountSelector = (data: string) =>
  SHARES_AMOUNT_SELECTORS.has(data.slice(0, 10).toLowerCase() as `0x${string}`)
const SWAP_VERIFIER_AMOUNT_SELECTORS = new Set([
  VERIFY_AMOUNT_MIN_AND_DEPOSIT_SELECTOR,
  VERIFY_AMOUNT_MIN_AND_SKIM_SELECTOR,
  VERIFY_AMOUNT_MIN_AND_TRANSFER_SELECTOR,
  VERIFY_DEBT_MAX_SELECTOR,
])
const SWAPPER_CALL_SELECTORS = new Set([
  SWAPPER_MULTICALL_SELECTOR,
  SWAPPER_SWAP_SELECTOR,
  SWAPPER_DEPOSIT_SELECTOR,
  SWAPPER_REPAY_SELECTOR,
  SWAPPER_REPAY_AND_DEPOSIT_SELECTOR,
  SWAPPER_SWEEP_SELECTOR,
  SWAPPER_TRANSFER_SELECTOR,
])

export type SwapEstimatedSide = 'input' | 'output'

export const getDefaultSwapEstimatedSide = (swapMode: SwapperMode): SwapEstimatedSide => {
  switch (swapMode) {
    case SwapperMode.EXACT_IN:
      return 'output'
    case SwapperMode.EXACT_OUT:
    case SwapperMode.TARGET_DEBT:
      return 'input'
    default: {
      const exhaustive: never = swapMode
      return exhaustive
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const normalizeAddressKey = (address: string): string | undefined => {
  try {
    return getAddress(address).toLowerCase()
  }
  catch {
    return undefined
  }
}

const addKnownAsset = (assets: KnownAssetMap, asset: KnownAsset | undefined, aliasAddress?: string) => {
  if (!asset?.address) return
  const assetKey = normalizeAddressKey(asset.address)
  if (assetKey) assets[assetKey] = asset
  const aliasKey = aliasAddress ? normalizeAddressKey(aliasAddress) : undefined
  if (aliasKey) assets[aliasKey] = asset
}

const getKnownAsset = (
  address: string | undefined,
  ctx: StepDecodingContext,
  getVault: VaultLookup,
  assets: KnownAssetMap,
): KnownAsset | undefined => {
  const key = address ? normalizeAddressKey(address) : undefined
  if (!key) return undefined
  if (assets[key]) return assets[key]
  if (sameAddress(address, ctx.asset.address)) return ctx.asset
  if (ctx.swapToAsset && sameAddress(address, ctx.swapToAsset.address)) return ctx.swapToAsset
  try {
    const vault = getVault(getAddress(address))
    if (vault?.asset) return vault.asset
  }
  catch { /* ignore */ }
  return undefined
}

const decodeMorphoAuthorizationLabel = (data: string): string | undefined => {
  try {
    const decoded = decodeFunctionData({
      abi: MORPHO_BLUE_ABI,
      data: data as Hex,
    })
    if (decoded.functionName !== 'setAuthorizationWithSig') return undefined
    const [authorization] = decoded.args as unknown as [{ isAuthorized: boolean }]
    return authorization.isAuthorized ? 'Enable Morpho authorization' : 'Disable Morpho authorization'
  }
  catch {
    return undefined
  }
}

export const decodeBatchItemLabel = (data: string): string => {
  const selector = data.slice(0, 10).toLowerCase()
  if (selector === MORPHO_AUTHORIZATION_SELECTOR) {
    return decodeMorphoAuthorizationLabel(data) ?? 'Morpho authorization'
  }
  return SELECTOR_LABELS[selector] || 'Unknown operation'
}

// The vault(s) an operation's core action targets, read off its plan, resolved
// to their market (Euler label product) names. Mirrors the positions list's
// pair label: distinct markets are deduped in plan order and joined with " / ",
// so a borrow operation spanning vaults from several markets shows all of them.
const VAULT_ACTION_LABELS = new Set(['Supply', 'Deposit', 'Withdraw', 'Borrow', 'Repay'])

export const buildPlanMarketLabel = (
  plan: TransactionPlan | undefined,
  getMarketName: (vaultAddress: string) => string | undefined,
): string | undefined => {
  if (!plan) return undefined
  const names = new Set<string>()
  for (const item of plan) {
    if (item.type !== 'evcBatch') continue
    for (const bi of flattenBatchEntries(item.items)) {
      if (!VAULT_ACTION_LABELS.has(decodeBatchItemLabel(bi.data))) continue
      try {
        const name = getMarketName(getAddress(bi.targetContract))
        if (name) names.add(name)
      }
      catch { /* skip malformed address */ }
    }
  }
  return names.size ? [...names].join(' / ') : undefined
}

export const cleanStepLabel = (label: string): string => {
  const cleaned = label
    .replace(/\s*via EVC$/i, '')
    .replace(/^Permit2\s+/i, '')
  return cleaned ? `${cleaned[0].toUpperCase()}${cleaned.slice(1)}` : cleaned
}

export const decodeVaultAddressFromData = (data: string): string | undefined => {
  if (data.length < 138) return undefined
  try {
    return getAddress(`0x${data.slice(98, 138)}`)
  }
  catch {
    return undefined
  }
}

export const decodeSecondUint256 = (data: string): bigint | undefined => {
  if (data.length < 138) return undefined
  try {
    return BigInt(`0x${data.slice(74, 138)}`)
  }
  catch {
    return undefined
  }
}

const decodeThirdUint256 = (data: string): bigint | undefined => {
  if (data.length < 202) return undefined
  try {
    return BigInt(`0x${data.slice(138, 202)}`)
  }
  catch {
    return undefined
  }
}

export const decodeFirstUint256 = (data: string): bigint | undefined => {
  if (data.length < 74) return undefined
  try {
    return BigInt(`0x${data.slice(10, 74)}`)
  }
  catch {
    return undefined
  }
}

const resolveAmountFromCalldata = (
  data: string,
  targetContract: string,
  getVault: VaultLookup,
): { decoded: boolean, amount?: string, isMax?: boolean } => {
  const selector = data.slice(0, 10).toLowerCase() as `0x${string}`
  const raw = decodeFirstUint256(data)

  if (raw === undefined) return { decoded: false }
  if (raw === MAX_UINT256) return { decoded: true, isMax: true }
  if (raw === 0n) return { decoded: true }
  if (SHARES_AMOUNT_SELECTORS.has(selector)) return { decoded: false }

  try {
    const vault = getVault(getAddress(targetContract))
    if (vault?.asset?.decimals) {
      return { decoded: true, amount: formatUnits(raw, Number(vault.asset.decimals)) }
    }
  }
  catch { /* ignore */ }

  return { decoded: false }
}

const decodeFirstAddress = (data: string): string | undefined => {
  if (data.length < 74) return undefined
  try {
    return getAddress(`0x${data.slice(34, 74)}`)
  }
  catch {
    return undefined
  }
}

const sameAddress = (a?: string, b?: string) => {
  if (!a || !b) return false
  try {
    return getAddress(a) === getAddress(b)
  }
  catch {
    return false
  }
}

const resolveContextAssetByAddress = (
  address: string,
  ctx: StepDecodingContext,
): StepDecodingContext['asset'] | StepDecodingContext['swapToAsset'] | undefined => {
  if (sameAddress(address, ctx.asset.address)) return ctx.asset
  if (ctx.swapToAsset && sameAddress(address, ctx.swapToAsset.address)) return ctx.swapToAsset
  return undefined
}

const buildAssetInfo = (
  asset: { symbol: string, address: string, decimals?: number | bigint },
  rawAmount?: bigint,
): StepAssetInfo => ({
  symbol: asset.symbol,
  address: asset.address,
  amount: rawAmount !== undefined && asset.decimals !== undefined
    ? formatUnits(rawAmount, Number(asset.decimals))
    : undefined,
})

const getVaultAssetInfo = (
  data: string,
  targetContract: string,
  getVault: VaultLookup,
): StepAssetInfo | undefined => {
  const vaultAddress = decodeVaultAddressFromData(data)
  const vault = vaultAddress ? getVault(vaultAddress) : undefined
  if (vault?.asset) return { symbol: vault.asset.symbol, address: vault.asset.address }
  try {
    const targetVault = getVault(getAddress(targetContract))
    if (targetVault?.asset) return { symbol: targetVault.asset.symbol, address: targetVault.asset.address }
  }
  catch { /* ignore */ }
  return undefined
}

const getSwapVerifierAssetInfo = (
  data: string,
  ctx: StepDecodingContext,
  getVault: VaultLookup,
): StepAssetInfo | undefined => {
  const selector = data.slice(0, 10).toLowerCase() as `0x${string}`
  if (!SWAP_VERIFIER_AMOUNT_SELECTORS.has(selector)) return undefined

  const firstAddress = decodeFirstAddress(data)
  if (!firstAddress) return undefined

  const rawAmount = decodeThirdUint256(data)

  if (selector === VERIFY_AMOUNT_MIN_AND_TRANSFER_SELECTOR) {
    const asset = resolveContextAssetByAddress(firstAddress, ctx) ?? ctx.swapToAsset ?? ctx.asset
    return buildAssetInfo(asset, rawAmount)
  }

  const vault = getVault(firstAddress)
  const asset = vault?.asset ?? ctx.swapToAsset ?? ctx.asset
  return buildAssetInfo(asset, rawAmount)
}

const decodeSwapperFunction = (data: Hex) => {
  try {
    return decodeFunctionData({
      abi: SWAPPER_ABI,
      data,
    })
  }
  catch {
    return undefined
  }
}

const decodeGenericHandlerPayload = (params: SwapperSwapParams): { target: Address, payload: Hex } | undefined => {
  try {
    const [target, payload] = decodeAbiParameters(GENERIC_HANDLER_DATA_ABI, params.data)
    return { target, payload }
  }
  catch {
    return undefined
  }
}

// Selectors for the protocol actions the Euler Swapper performs inside a
// generic-handler `swap` during a migration. These are surfaced as their own
// steps; everything else (real token swaps) collapses to a single "Swap".
const PROTOCOL_ACTION_SELECTOR_LABELS: Record<string, string> = {
  [toFunctionSelector('function repay((address,address,address,address,uint256),uint256,uint256,address,bytes)')]: 'Repay Morpho debt',
  [toFunctionSelector('function supplyCollateral((address,address,address,address,uint256),uint256,address,bytes)')]: 'Supply collateral to Morpho',
  [toFunctionSelector('function repay(address,uint256,uint256,address)')]: 'Repay Aave debt',
  [toFunctionSelector('function supply(address,uint256,address,uint16)')]: 'Supply collateral to Aave',
  [toFunctionSelector('function withdraw(address,uint256,address)')]: 'Withdraw Aave collateral',
  // Metamorpho (Morpho vault) migrations redeem the source vault shares
  // through the generic handler; only that flow wraps redeem this way.
  [toFunctionSelector('function redeem(uint256,address,address)')]: 'Withdraw from Morpho vault',
}
const SWAP_OUTPUT_CONSUMER_LABELS = new Set([
  'Repay Morpho debt',
  'Supply collateral to Morpho',
  'Repay Aave debt',
  'Supply collateral to Aave',
])

// Classifies a single (non-multicall) Swapper call into the migration action it
// represents, with a priority tier (lower = higher priority) so a multicall's
// primary action wins over bundled token swaps and secondary cleanup calls.
type ClassifiedSwapperCall = {
  target: string
  data: Hex
  label: string
  tier: number
  swapOutput?: BatchDisplayAction['swapOutput']
}

const classifySwapperCall = (call: Hex, parentTarget: string): ClassifiedSwapperCall | undefined => {
  const decoded = decodeSwapperFunction(call)
  if (!decoded || decoded.functionName === 'multicall') return undefined
  if (decoded.functionName === 'swap') {
    const [params] = decoded.args as unknown as [SwapperSwapParams]
    const generic = decodeGenericHandlerPayload(params)
    const protocolLabel = generic
      ? PROTOCOL_ACTION_SELECTOR_LABELS[generic.payload.slice(0, 10).toLowerCase()]
      : undefined
    // A wrapped Morpho/Aave action is the meaningful operation, not a token swap.
    if (generic && protocolLabel) {
      return { target: generic.target, data: generic.payload, label: protocolLabel, tier: 1 }
    }
    // tokenIn == tokenOut isn't a real swap — it routes the token into the vault.
    let sameAsset = false
    try {
      sameAsset = getAddress(params.tokenIn) === getAddress(params.tokenOut)
    }
    catch { /* ignore */ }
    return {
      target: parentTarget,
      data: call,
      label: sameAsset ? 'Migration deposit' : 'Swap',
      tier: 2,
      swapOutput: sameAsset
        ? undefined
        : {
            tokenIn: params.tokenIn,
            token: params.tokenOut,
            amount: params.amountOut > 0n ? params.amountOut : undefined,
          },
    }
  }
  if (decoded.functionName === 'deposit') {
    return { target: parentTarget, data: call, label: 'Swapper deposit', tier: 2 }
  }
  if (decoded.functionName === 'repay' || decoded.functionName === 'repayAndDeposit') {
    return { target: parentTarget, data: call, label: 'Swapper repay', tier: 3 }
  }
  if (decoded.functionName === 'sweep') {
    return { target: parentTarget, data: call, label: 'Swapper sweep', tier: 4 }
  }
  if (decoded.functionName === 'transfer') {
    return { target: parentTarget, data: call, label: 'Swapper transfer', tier: 4 }
  }
  return undefined
}

const collectSwapperCallActions = (call: Hex, parentTarget: string): ClassifiedSwapperCall[] => {
  const decoded = decodeSwapperFunction(call)
  if (!decoded) return []
  if (decoded.functionName === 'multicall') {
    const [calls] = decoded.args as unknown as [Hex[]]
    return calls.flatMap(inner => collectSwapperCallActions(inner, parentTarget))
  }
  const classified = classifySwapperCall(call, parentTarget)
  return classified ? [classified] : []
}

const findPrimarySwapperAction = (actions: ClassifiedSwapperCall[]): ClassifiedSwapperCall | undefined => {
  let best: ClassifiedSwapperCall | undefined
  for (const action of actions) {
    if (!best || action.tier < best.tier) best = action
  }
  return best
}

const getVisibleSwapperMulticallActions = (call: Hex, parentTarget: string): ClassifiedSwapperCall[] => {
  const actions = collectSwapperCallActions(call, parentTarget)
  const primary = findPrimarySwapperAction(actions.filter(action => action.label !== 'Swap'))
  const hasTokenSwap = actions.some(action => action.label === 'Swap')
  const hasProtocolAction = actions.some(action => action.tier === 1)
  if (hasProtocolAction && !hasTokenSwap) {
    const visible = actions.filter(action => action.tier <= 3 && action.label !== 'Swap')
    if (visible.length) return visible
  }
  const visible = actions.filter(action =>
    action.label === 'Swap'
    || (primary === action && (!hasTokenSwap || primary.tier <= 1)),
  )
  return visible.length ? visible : primary ? [primary] : []
}

const asAction = (
  item: { targetContract: string, onBehalfOfAccount: string, value: bigint, data: Hex },
  label = decodeBatchItemLabel(item.data),
  extra?: Pick<BatchDisplayAction, 'swapOutput'>,
): BatchDisplayAction => ({
  targetContract: item.targetContract,
  onBehalfOfAccount: item.onBehalfOfAccount,
  value: item.value,
  data: item.data,
  label,
  ...(extra ?? {}),
})

const expandSwapperCallActions = (
  call: Hex,
  parent: BatchDisplayAction,
): BatchDisplayAction[] => {
  const decoded = decodeSwapperFunction(call)
  if (!decoded) {
    return [asAction({ ...parent, data: call, value: 0n }, 'Swap')]
  }

  if (decoded.functionName === 'multicall') {
    const visible = getVisibleSwapperMulticallActions(call, parent.targetContract)
    if (visible.length) {
      return visible.map(action => asAction({
        targetContract: action.target,
        onBehalfOfAccount: parent.onBehalfOfAccount,
        value: 0n,
        data: action.data,
      }, action.label, { swapOutput: action.swapOutput }))
    }
    return [asAction({ ...parent, data: call, value: 0n }, 'Swap')]
  }

  // A generic-handler `swap` wraps protocol actions during migrations. Surface
  // the wrapped action when present; otherwise it is a real token swap.
  if (decoded.functionName === 'swap') {
    const [primary] = collectSwapperCallActions(call, parent.targetContract)
    if (primary) {
      return [asAction({
        targetContract: primary.target,
        onBehalfOfAccount: parent.onBehalfOfAccount,
        value: 0n,
        data: primary.data,
      }, primary.label, { swapOutput: primary.swapOutput })]
    }
    return [asAction({ ...parent, data: call, value: 0n }, 'Swap')]
  }

  // Direct Swapper deposit/repay/sweep/transfer keep their own labels.
  return [asAction({ ...parent, data: call, value: 0n })]
}

const expandBatchItemActions = (item: {
  targetContract: string
  onBehalfOfAccount: string
  value: bigint
  data: Hex
}): BatchDisplayAction[] => {
  const action = asAction(item)
  const selector = item.data.slice(0, 10).toLowerCase() as Hex
  if (!SWAPPER_CALL_SELECTORS.has(selector)) {
    return [action]
  }
  return expandSwapperCallActions(item.data, action)
}

const decodeSwapperTokenVaultAmount = (
  data: Hex,
): { token: Address, vault?: Address, amount?: bigint } | undefined => {
  const decoded = decodeSwapperFunction(data)
  if (!decoded) return undefined
  if (decoded.functionName === 'deposit') {
    const [token, vault, amount] = decoded.args as unknown as [Address, Address, bigint, Address]
    return { token, vault, amount }
  }
  if (decoded.functionName === 'repay' || decoded.functionName === 'repayAndDeposit') {
    const [token, vault, amount] = decoded.args as unknown as [Address, Address, bigint, Address]
    return { token, vault, amount }
  }
  if (decoded.functionName === 'sweep' || decoded.functionName === 'transfer') {
    const [token, amount] = decoded.args as unknown as [Address, bigint, Address]
    return { token, amount }
  }
  return undefined
}

const getSwapOutputAssetInfo = (
  action: BatchDisplayAction,
  ctx: StepDecodingContext,
  getVault: VaultLookup,
  assets: KnownAssetMap,
): StepAssetInfo | undefined => {
  if (action.label !== 'Swap' || !action.swapOutput) return undefined
  const outputAsset = getKnownAsset(action.swapOutput.token, ctx, getVault, assets)
  if (!outputAsset) return undefined
  const quoteOutput = ctx.swapQuoteOutputs?.find(output =>
    sameAddress(output.tokenOut, action.swapOutput?.token)
    && (!output.tokenIn || !action.swapOutput?.tokenIn || sameAddress(output.tokenIn, action.swapOutput.tokenIn)),
  )
  const info = buildAssetInfo(outputAsset, action.swapOutput.amount)
  return quoteOutput?.amountOut !== undefined ? { ...info, amount: quoteOutput.amountOut } : info
}

const mergeSwapOutputAssetInfo = (
  current: StepAssetInfo | undefined,
  next: StepAssetInfo,
): StepAssetInfo => {
  if (!current) return { ...next }
  if (current.amount !== undefined || next.amount === undefined) return current
  return { ...current, amount: next.amount }
}

const sameAssetInfo = (a?: StepAssetInfo, b?: StepAssetInfo) => {
  if (!a || !b) return false
  if (a.address && b.address) return sameAddress(a.address, b.address)
  return a.symbol === b.symbol
}

const decodeAaveAssetAmount = (data: Hex): { asset: Address, amount?: bigint } | undefined => {
  try {
    const decoded = decodeFunctionData({ abi: AAVE_POOL_ABI, data })
    if (decoded.functionName === 'repay' || decoded.functionName === 'supply' || decoded.functionName === 'withdraw') {
      const [asset, amount] = decoded.args as unknown as [Address, bigint, ...unknown[]]
      return { asset, amount }
    }
  }
  catch { /* ignore */ }
  return undefined
}

const decodeMorphoAssetAmount = (data: Hex): { asset: Address, amount?: bigint, debtAsset?: Address } | undefined => {
  try {
    const decoded = decodeFunctionData({ abi: MORPHO_BLUE_ABI, data })
    if (decoded.functionName === 'repay') {
      const [marketParams, assets] = decoded.args as unknown as [MorphoMarketParams, bigint, bigint, Address, Hex]
      return { asset: marketParams.loanToken, amount: assets > 0n ? assets : undefined, debtAsset: marketParams.loanToken }
    }
    if (decoded.functionName === 'supplyCollateral') {
      const [marketParams, assets] = decoded.args as unknown as [MorphoMarketParams, bigint, Address, Hex]
      return { asset: marketParams.collateralToken, amount: assets }
    }
  }
  catch { /* ignore */ }
  return undefined
}

const decodeSwapVerifierAssetAmount = (data: Hex): { asset?: Address, amount?: bigint, collateralAsset?: Address, debtAsset?: Address } | undefined => {
  try {
    const decoded = decodeFunctionData({ abi: SWAP_VERIFIER_ABI, data })
    if (decoded.functionName === 'transferFromSender' || decoded.functionName === 'transferBalanceFromSender') {
      const [token, amount] = decoded.args as unknown as [Address, bigint, Address]
      return { asset: token, amount }
    }
    if (decoded.functionName === 'aaveBorrowForSender') {
      const [, asset, amount] = decoded.args as unknown as [Address, Address, bigint, Address]
      return { asset, amount, debtAsset: asset }
    }
    if (decoded.functionName === 'morphoBorrowForSender') {
      const [, marketParams, amount] = decoded.args as unknown as [Address, MorphoMarketParams, bigint, Address]
      return { asset: marketParams.loanToken, amount, debtAsset: marketParams.loanToken }
    }
    if (decoded.functionName === 'morphoWithdrawCollateralForSender') {
      const [, marketParams, amount] = decoded.args as unknown as [Address, MorphoMarketParams, bigint, Address]
      return { asset: marketParams.collateralToken, amount, collateralAsset: marketParams.collateralToken }
    }
  }
  catch { /* ignore */ }
  return undefined
}

const decodeAaveAuthorizationAmount = (data: Hex): bigint | undefined => {
  try {
    const decoded = decodeFunctionData({ abi: AAVE_TOKEN_AUTH_ABI, data })
    if (decoded.functionName === 'permit' || decoded.functionName === 'delegationWithSig') {
      const [, , value] = decoded.args as unknown as [Address, Address, bigint, ...unknown[]]
      return value
    }
  }
  catch { /* ignore */ }
  return undefined
}

const buildPlanAssetMap = (
  plan: TransactionPlan,
  ctx: StepDecodingContext,
  getVault: VaultLookup,
): KnownAssetMap => {
  const assets: KnownAssetMap = {}
  addKnownAsset(assets, ctx.asset)
  addKnownAsset(assets, ctx.swapToAsset)
  for (const asset of ctx.knownAssets ?? []) addKnownAsset(assets, asset)

  const aaveCollateralAuthTokens = new Set<string>()
  const aaveDebtAuthTokens = new Set<string>()
  const aaveCollateralAssets = new Set<string>()
  const aaveDebtAssets = new Set<string>()

  const rememberVault = (address: string | undefined, aliasAddress?: string) => {
    if (!address) return
    try {
      const vault = getVault(getAddress(address))
      addKnownAsset(assets, vault?.asset, aliasAddress)
    }
    catch { /* ignore */ }
  }

  const rememberAssetAddress = (address: string | undefined) => {
    const key = normalizeAddressKey(address ?? '')
    if (!key || assets[key]) return
    if (sameAddress(address, ctx.asset.address)) addKnownAsset(assets, ctx.asset, address)
    if (ctx.swapToAsset && sameAddress(address, ctx.swapToAsset.address)) addKnownAsset(assets, ctx.swapToAsset, address)
  }

  for (const item of plan) {
    if (item.type !== 'evcBatch') continue
    for (const batchItem of flattenBatchEntries(item.items)) {
      rememberVault(batchItem.targetContract)
      const vaultAddress = decodeVaultAddressFromData(batchItem.data)
      rememberVault(vaultAddress)

      for (const action of expandBatchItemActions(batchItem)) {
        rememberVault(action.targetContract)
        const actionVaultAddress = decodeVaultAddressFromData(action.data)
        rememberVault(actionVaultAddress)

        const swapperArgs = decodeSwapperTokenVaultAmount(action.data)
        if (swapperArgs?.vault) {
          rememberVault(swapperArgs.vault, swapperArgs.token)
        }
        if (action.swapOutput?.token) {
          rememberAssetAddress(action.swapOutput.token)
        }

        const aave = decodeAaveAssetAmount(action.data)
        if (aave?.asset) {
          rememberAssetAddress(aave.asset)
          if (action.label === 'Withdraw Aave collateral' || action.label === 'Supply collateral to Aave') {
            const key = normalizeAddressKey(aave.asset)
            if (key) aaveCollateralAssets.add(key)
          }
          if (action.label === 'Repay Aave debt') {
            const key = normalizeAddressKey(aave.asset)
            if (key) aaveDebtAssets.add(key)
          }
        }

        const morpho = decodeMorphoAssetAmount(action.data)
        if (morpho?.asset) rememberAssetAddress(morpho.asset)

        const verifier = decodeSwapVerifierAssetAmount(action.data)
        if (verifier?.asset) rememberAssetAddress(verifier.asset)
        if (verifier?.collateralAsset) {
          const key = normalizeAddressKey(verifier.collateralAsset)
          if (key) aaveCollateralAssets.add(key)
        }
        if (verifier?.debtAsset) {
          const key = normalizeAddressKey(verifier.debtAsset)
          if (key) aaveDebtAssets.add(key)
        }

        const selector = action.data.slice(0, 10).toLowerCase()
        if (selector === AAVE_PERMIT_SELECTOR || selector === TRANSFER_BALANCE_FROM_SENDER_SELECTOR || selector === TRANSFER_FROM_SENDER_SELECTOR) {
          const token = selector === AAVE_PERMIT_SELECTOR
            ? action.targetContract
            : decodeSwapVerifierAssetAmount(action.data)?.asset
          const key = normalizeAddressKey(token)
          if (key) aaveCollateralAuthTokens.add(key)
        }
        if (selector === AAVE_DELEGATION_WITH_SIG_SELECTOR) {
          const key = normalizeAddressKey(action.targetContract)
          if (key) aaveDebtAuthTokens.add(key)
        }
      }
    }
  }

  if (aaveCollateralAssets.size === 1) {
    const asset = assets[[...aaveCollateralAssets][0]!]
    if (asset) {
      for (const token of aaveCollateralAuthTokens) assets[token] = asset
    }
  }
  if (aaveDebtAssets.size === 1) {
    const asset = assets[[...aaveDebtAssets][0]!]
    if (asset) {
      for (const token of aaveDebtAuthTokens) assets[token] = asset
    }
  }

  return assets
}

const resolveBatchItemAssetInfo = (
  label: string,
  data: Hex,
  targetContract: string,
  value: bigint,
  ctx: StepDecodingContext,
  getVault: VaultLookup,
  assets: KnownAssetMap,
): StepAssetInfo | undefined => {
  const assetInfoForToken = (token: string | undefined, rawAmount?: bigint, fallback?: KnownAsset): StepAssetInfo | undefined => {
    const asset = getKnownAsset(token, ctx, getVault, assets) ?? fallback
    if (!asset) return undefined
    return buildAssetInfo(asset, rawAmount)
  }

  if (label === 'Enable Morpho authorization' || label === 'Disable Morpho authorization') {
    return undefined
  }

  if (label === 'Apply Aave permit' || label === 'Apply Aave debt delegation') {
    return assetInfoForToken(targetContract, decodeAaveAuthorizationAmount(data))
  }

  if (label === 'Transfer Aave collateral' || label === 'Transfer from wallet') {
    const decoded = decodeSwapVerifierAssetAmount(data)
    return assetInfoForToken(decoded?.asset, decoded?.amount)
  }

  if (label === 'Borrow on Aave' || label === 'Borrow on Morpho' || label === 'Withdraw Morpho collateral') {
    const decoded = decodeSwapVerifierAssetAmount(data)
    return assetInfoForToken(decoded?.asset, decoded?.amount)
  }

  if (label === 'Repay Morpho debt' || label === 'Supply collateral to Morpho') {
    const decoded = decodeMorphoAssetAmount(data)
    const usesContextDebtAsset = decoded?.debtAsset && sameAddress(decoded.debtAsset, ctx.asset.address)
    const info = assetInfoForToken(decoded?.asset, decoded?.amount, usesContextDebtAsset ? ctx.asset : undefined)
    return label === 'Repay Morpho debt' && info && info.amount === undefined && usesContextDebtAsset
      ? { ...info, amount: ctx.amount }
      : info
  }

  if (label === 'Repay Aave debt' || label === 'Supply collateral to Aave' || label === 'Withdraw Aave collateral') {
    const decoded = decodeAaveAssetAmount(data)
    return assetInfoForToken(decoded?.asset, decoded?.amount === MAX_UINT256 ? undefined : decoded?.amount)
  }

  if (label === 'Swapper deposit' || label === 'Swapper repay' || label === 'Swapper sweep' || label === 'Swapper transfer') {
    const decoded = decodeSwapperTokenVaultAmount(data)
    if (!decoded) return undefined
    // A type(uint256).max repay/deposit/sweep amount is the "use the full
    // balance/debt" sentinel, not a literal amount — drop it so repay/sweep
    // render as "remaining" and we never format maxUint256 as a number.
    const rawAmount = decoded.amount && decoded.amount > 0n && decoded.amount !== MAX_UINT256
      ? decoded.amount
      : undefined
    const applyImplicitRemaining = (info: StepAssetInfo): StepAssetInfo => {
      const showRemaining
        = !rawAmount && (label === 'Swapper repay' || label === 'Swapper sweep')
      return showRemaining ? { ...info, amount: 'remaining' } : info
    }
    if (decoded.vault) {
      const vaultAsset = getKnownAsset(decoded.vault, ctx, getVault, assets)
      const tokenAsset = getKnownAsset(decoded.token, ctx, getVault, assets)
      return applyImplicitRemaining(buildAssetInfo(vaultAsset ?? tokenAsset ?? ctx.asset, rawAmount))
    }
    const info = assetInfoForToken(decoded.token, rawAmount)
    return info ? applyImplicitRemaining(info) : undefined
  }

  if (label === 'Enable collateral' || label === 'Enable controller'
    || label === 'Disable collateral' || label === 'Disable controller') {
    return getVaultAssetInfo(data, targetContract, getVault)
  }

  if (label === 'Supply' || label === 'Deposit') {
    try {
      const targetVault = getVault(getAddress(targetContract))
      if (targetVault?.asset) {
        const resolved = resolveAmountFromCalldata(data, targetContract, getVault)
        const amount = resolved.isMax
          ? 'remaining'
          : resolved.decoded && resolved.amount
            ? resolved.amount
            : label === 'Deposit'
              ? ctx.swapToAmount ?? 'remaining'
              : ctx.amount
        return { symbol: targetVault.asset.symbol, address: targetVault.asset.address, amount }
      }
    }
    catch { /* ignore */ }
    return { symbol: ctx.asset.symbol, address: ctx.asset.address, amount: ctx.amount }
  }

  if (label === 'Withdraw') {
    const resolved = resolveAmountFromCalldata(data, targetContract, getVault)
    let vaultAsset: StepAssetInfo | undefined
    try {
      const targetVault = getVault(getAddress(targetContract))
      if (targetVault?.asset) {
        vaultAsset = {
          symbol: targetVault.asset.symbol,
          address: targetVault.asset.address,
        }
      }
    }
    catch { /* ignore */ }
    const amount = resolved.isMax
      ? 'remaining'
      : resolved.decoded && resolved.amount
        ? resolved.amount
        : ctx.vaultAmounts?.[normalizeAddressKey(targetContract)] ?? (isSharesAmountSelector(data)
          ? undefined
          : ctx.amount)
    return { symbol: vaultAsset?.symbol ?? ctx.asset.symbol, address: vaultAsset?.address ?? ctx.asset.address, amount }
  }

  if (label === 'Wrap native currency') {
    const nativeSymbol = ctx.asset.symbol.startsWith('W') ? ctx.asset.symbol.slice(1) : ctx.asset.symbol
    const wrapAmount = value > 0n ? formatUnits(value, 18) : undefined
    return { symbol: nativeSymbol, address: zeroAddress, amount: wrapAmount }
  }

  if (label === 'Verify min received' || label === 'Verify max debt') {
    return getSwapVerifierAssetInfo(data, ctx, getVault)
  }

  if (label === 'Transfer' || label === 'Transfer to account' || label === 'Transfer from wallet') {
    // transferFromMax(address,address) ("Transfer to account") has no amount
    // argument — its second calldata slot is the recipient address, not a
    // uint256. Decoding it as an amount would render a garbage number, so show
    // the known sweep amount (or "remaining") instead.
    const isMaxTransfer = label === 'Transfer to account'
    const fallbackAmount = isMaxTransfer
      ? ctx.transferAmounts?.[targetContract.toLowerCase()] ?? 'remaining'
      : undefined
    try {
      const targetVault = getVault(getAddress(targetContract))
      if (targetVault?.asset) {
        let amount = fallbackAmount
        if (!isMaxTransfer) {
          const raw = decodeSecondUint256(data)
          amount = raw !== undefined && raw > 0n
            ? formatUnits(raw, Number(targetVault.asset.decimals))
            : undefined
        }
        return { symbol: targetVault.asset.symbol, address: targetVault.asset.address, amount }
      }
    }
    catch { /* ignore */ }
    return { symbol: ctx.asset.symbol, address: ctx.asset.address, amount: fallbackAmount }
  }

  if (label === 'Borrow' || label === 'Repay') {
    const vaultAsset = getVaultAssetInfo(data, targetContract, getVault)
    const base = vaultAsset || { symbol: ctx.asset.symbol, address: ctx.asset.address }
    const resolved = resolveAmountFromCalldata(data, targetContract, getVault)
    const amount = resolved.isMax
      ? 'max'
      : resolved.decoded && resolved.amount
        ? resolved.amount
        : ctx.amount
    return { ...base, amount }
  }

  if (label === 'Swap') {
    return { symbol: ctx.asset.symbol, address: ctx.asset.address, amount: ctx.amount }
  }

  if (label === 'Update price feeds') {
    return { symbol: ctx.asset.symbol, address: ctx.asset.address }
  }

  if (label === 'Claim' || label === 'Unlock') {
    return { symbol: ctx.asset.symbol, address: ctx.asset.address, amount: ctx.amount }
  }

  return undefined
}

/**
 * Convert an SDK TransactionPlan into the UI-facing DisplayStep[] consumed by
 * OperationStepsList. Walks SDK plan items (`requiredApproval`, `evcBatch`,
 * `contractCall`) and applies display conventions for the review modal.
 */
/**
 * Share-token (vault) addresses of Morpho vaults redeemed within the plan.
 * Their presence identifies a Metamorpho migration, so the ERC-2612 permit
 * and wallet-transfer steps can be labeled for Morpho vault shares instead
 * of the Aave defaults.
 */
const collectMorphoVaultShareTokens = (plan: TransactionPlan): Set<string> => {
  const tokens = new Set<string>()
  for (const item of plan) {
    if (item.type !== 'evcBatch') continue
    for (const batchItem of flattenBatchEntries(item.items)) {
      for (const action of expandBatchItemActions(batchItem)) {
        if (action.label !== 'Withdraw from Morpho vault') continue
        const key = normalizeAddressKey(action.targetContract)
        if (key) tokens.add(key)
      }
    }
  }
  return tokens
}

export function buildTransactionPlanDisplaySteps(
  plan: TransactionPlan,
  ctx: StepDecodingContext,
  getVault: VaultLookup,
  getLogoUrl: (address: string, symbol: string) => string,
): DisplayStep[] {
  const steps: DisplayStep[] = []
  const knownAssets = buildPlanAssetMap(plan, ctx, getVault)
  const morphoVaultShareTokens = collectMorphoVaultShareTokens(plan)
  const isMorphoVaultShareToken = (address: string | undefined) => {
    const key = normalizeAddressKey(address ?? '')
    return !!key && morphoVaultShareTokens.has(key)
  }
  let index = 0
  let lastWithdrawAmount: string | undefined
  let previousLabel = ''
  let inferredSwapInput: StepAssetInfo | undefined
  let pendingSwapStep: DisplayStep | undefined
  let pendingShareWithdrawStep: DisplayStep | undefined
  let pendingAaveCollateralTransferStep: DisplayStep | undefined
  let hasMigrationEulerBorrow = false

  for (const item of plan) {
    if (item.type === 'requiredApproval') {
      const resolved = item.resolved ?? []
      for (const r of resolved) {
        index++
        if (r.type === 'approve') {
          steps.push({
            index,
            label: 'Approve',
            labelSuffix: 'for vault',
            isSeparateTx: !ctx.bundledApprovals,
            assetInfo: { symbol: ctx.asset.symbol, address: ctx.asset.address },
          })
        }
        else {
          // permit2 signature (no on-chain tx; embedded into the next batch)
          steps.push({
            index,
            label: 'Sign permit2 message',
            isSeparateTx: false,
            assetInfo: { symbol: ctx.asset.symbol, address: ctx.asset.address },
          })
        }
      }
      continue
    }

    if (item.type === 'evcBatch') {
      const batchItems = flattenBatchEntries(item.items)
      for (const batchItem of batchItems) {
        for (const action of expandBatchItemActions(batchItem)) {
          const label = action.label
          if (ctx.type === 'migration' && label === 'Swapper repay' && hasMigrationEulerBorrow) {
            continue
          }

          index++
          let assetInfo = resolveBatchItemAssetInfo(
            label,
            action.data,
            action.targetContract,
            action.value,
            ctx,
            getVault,
            knownAssets,
          )
          if ((label === 'Withdraw' || label === 'Withdraw Aave collateral' || label === 'Withdraw Morpho collateral')
            && assetInfo?.amount && assetInfo.amount !== 'remaining') {
            lastWithdrawAmount = String(assetInfo.amount)
          }
          let toAssetInfo: StepAssetInfo | undefined
          if (label === 'Wrap native currency') {
            toAssetInfo = { symbol: ctx.asset.symbol, address: ctx.asset.address }
          }
          else if (label === 'Swap' && ctx.swapToAsset && ctx.swapToAmount) {
            const swapFromAsset = ctx.swapFromAsset ?? ctx.asset
            assetInfo = {
              symbol: swapFromAsset.symbol,
              address: swapFromAsset.address,
              amount: ctx.swapFromAmount ?? lastWithdrawAmount ?? ctx.amount,
            }
            toAssetInfo = { symbol: ctx.swapToAsset.symbol, address: ctx.swapToAsset.address, amount: ctx.swapToAmount }
            const estimatedSide = ctx.swapEstimatedSide
              ?? (ctx.swapMode !== undefined ? getDefaultSwapEstimatedSide(ctx.swapMode) : undefined)
            if (estimatedSide === 'input') {
              assetInfo = { ...assetInfo, estimated: true }
            }
            else if (estimatedSide === 'output') {
              toAssetInfo = { ...toAssetInfo, estimated: true }
            }
          }
          else if (label === 'Swap') {
            toAssetInfo = getSwapOutputAssetInfo(action, ctx, getVault, knownAssets)
          }
          if ((label === 'Swap' || label === 'Migration deposit') && inferredSwapInput && !(label === 'Swap' && ctx.swapToAsset && ctx.swapToAmount)) {
            assetInfo = { ...inferredSwapInput }
          }
          let displayLabel = label
          if (label === 'Transfer to account') {
            displayLabel = 'Transfer'
          }
          // The generic-handler redeem mapping exists for Metamorpho
          // migrations; outside a migration a wrapped ERC4626 redeem is just a
          // withdrawal and must not claim to touch a Morpho vault.
          else if (ctx.type !== 'migration' && label === 'Withdraw from Morpho vault') {
            displayLabel = 'Withdraw'
          }
          else if (label === 'Wrap native currency') {
            displayLabel = 'Wrap'
          }
          else if (label === 'Swap' && ctx.swapMode === SwapperMode.TARGET_DEBT) {
            displayLabel = 'Swap to repay'
          }
          else if (ctx.type === 'migration' && label === 'Borrow') {
            displayLabel = 'Borrow on Euler'
          }
          else if (ctx.type === 'migration' && label === 'Withdraw') {
            displayLabel = 'Withdraw Euler collateral'
          }
          else if (ctx.type === 'migration' && label === 'Repay') {
            displayLabel = 'Repay Euler debt'
          }
          else if (ctx.type === 'migration' && label === 'Swapper deposit') {
            displayLabel = 'Supply collateral to Euler'
          }
          else if (ctx.type === 'migration' && label === 'Migration deposit') {
            displayLabel = 'Supply collateral to Euler'
          }
          else if (ctx.type === 'migration'
            && label === 'Verify min received'
            && action.data.slice(0, 10).toLowerCase() === VERIFY_AMOUNT_MIN_AND_DEPOSIT_SELECTOR) {
            // After a swap the deposit-verified amount is the quote's minimum,
            // not the expected output shown on the Swap row — say so instead
            // of presenting the minimum as the supplied amount.
            displayLabel = pendingSwapStep
              ? 'Verify min received and supply to Euler'
              : 'Supply collateral to Euler'
          }
          else if (label === 'Migration deposit') {
            displayLabel = 'Deposit'
          }
          else if (ctx.type === 'migration' && label === 'Swapper repay') {
            displayLabel = 'Repay Euler debt'
          }
          else if (label === 'Swapper deposit') {
            displayLabel = 'Deposit'
          }
          else if (label === 'Swapper repay') {
            displayLabel = 'Repay'
          }
          else if (label === 'Swapper sweep') {
            displayLabel = 'Sweep remaining'
          }
          else if (label === 'Swapper transfer') {
            displayLabel = 'Transfer'
          }
          else if (ctx.type === 'migration' && label === 'Transfer from wallet') {
            displayLabel = isMorphoVaultShareToken(decodeSwapVerifierAssetAmount(action.data)?.asset)
              ? 'Transfer Morpho vault shares'
              : 'Transfer Aave collateral'
          }
          else if (ctx.type === 'migration' && label === 'Apply Aave permit' && isMorphoVaultShareToken(action.targetContract)) {
            displayLabel = 'Apply Morpho vault permit'
          }
          else if (ctx.type === 'migration' && label === 'Disable controller') {
            displayLabel = 'Disable Euler controller'
          }
          else if (ctx.type === 'migration' && label === 'Disable collateral') {
            displayLabel = 'Disable Euler collateral'
          }
          if (displayLabel === 'Apply Morpho vault permit' || displayLabel === 'Transfer Morpho vault shares') {
            // Both amounts are denominated in Morpho vault shares, which the
            // vault registry cannot resolve to a displayable asset. Show the
            // migrated underlying amount as an estimate instead, matching the
            // signature step's convention.
            assetInfo = { symbol: ctx.asset.symbol, address: ctx.asset.address, amount: ctx.amount, estimated: true }
          }
          const isWrapTransfer = label === 'Transfer' && previousLabel === 'Wrap native currency'
          const labelSuffix = label === 'Transfer to account'
            ? 'to savings'
            : isWrapTransfer
              ? 'to wallet'
              : undefined
          const hideMigrationSourceCollateralStep = ctx.type === 'migration'
            && (label === 'Withdraw Aave collateral' || label === 'Withdraw from Morpho vault')
          if (hideMigrationSourceCollateralStep) {
            if (assetInfo && (assetInfo.amount !== undefined || !inferredSwapInput)) {
              inferredSwapInput = { ...assetInfo }
            }
            previousLabel = label
            index--
            continue
          }
          const step: DisplayStep = {
            index,
            label: displayLabel,
            labelSuffix,
            isSeparateTx: false,
            assetInfo,
            toAssetInfo,
            iconOnly: label === 'Update price feeds',
          }
          steps.push(step)
          if (ctx.type === 'migration' && label === 'Withdraw' && isSharesAmountSelector(action.data)) {
            pendingShareWithdrawStep = step
          }
          else if (ctx.type === 'migration' && label === 'Transfer from wallet'
            && (displayLabel === 'Transfer Aave collateral' || displayLabel === 'Transfer Morpho vault shares')) {
            pendingAaveCollateralTransferStep = step
          }
          else if ((label === 'Supply collateral to Aave' || label === 'Supply collateral to Morpho')
            && pendingShareWithdrawStep?.assetInfo && assetInfo?.amount !== undefined
            && sameAssetInfo(pendingShareWithdrawStep.assetInfo, assetInfo)) {
            pendingShareWithdrawStep.assetInfo.amount = assetInfo.amount
            lastWithdrawAmount = String(assetInfo.amount)
            pendingShareWithdrawStep = undefined
          }
          if (ctx.type === 'migration'
            && displayLabel === 'Supply collateral to Euler'
            && pendingAaveCollateralTransferStep?.assetInfo
            && assetInfo?.amount !== undefined
            && sameAssetInfo(pendingAaveCollateralTransferStep.assetInfo, assetInfo)) {
            pendingAaveCollateralTransferStep.assetInfo.amount = assetInfo.amount
            pendingAaveCollateralTransferStep = undefined
          }
          if (label === 'Withdraw' || label === 'Borrow'
            || label === 'Withdraw Aave collateral' || label === 'Withdraw Morpho collateral'
            || label === 'Withdraw from Morpho vault'
            || label === 'Borrow on Aave' || label === 'Borrow on Morpho'
            || label === 'Transfer from wallet') {
            inferredSwapInput = assetInfo ? { ...assetInfo } : undefined
            if (ctx.type === 'migration' && label === 'Borrow') {
              hasMigrationEulerBorrow = true
            }
          }
          else if (label === 'Swap') {
            pendingSwapStep = step
            inferredSwapInput = undefined
          }
          else if (label === 'Migration deposit') {
            inferredSwapInput = undefined
          }
          else if ((label === 'Verify min received' || label === 'Verify max debt') && pendingSwapStep && assetInfo) {
            if (ctx.type !== 'refinance' && !pendingSwapStep.toAssetInfo?.amount) {
              const verifiedOutput = label === 'Verify max debt'
                ? { symbol: assetInfo.symbol, address: assetInfo.address }
                : { ...assetInfo }
              pendingSwapStep.toAssetInfo = mergeSwapOutputAssetInfo(pendingSwapStep.toAssetInfo, verifiedOutput)
            }
            if (label === 'Verify max debt' && pendingSwapStep.label === 'Swap') {
              pendingSwapStep.label = 'Swap to repay'
            }
            pendingSwapStep = undefined
          }
          else if (SWAP_OUTPUT_CONSUMER_LABELS.has(label) && pendingSwapStep && assetInfo) {
            if (!pendingSwapStep.toAssetInfo?.amount) {
              pendingSwapStep.toAssetInfo = mergeSwapOutputAssetInfo(pendingSwapStep.toAssetInfo, assetInfo)
            }
            pendingSwapStep = undefined
          }
          previousLabel = label
        }
      }
      continue
    }

    if (item.type === 'contractCall') {
      index++
      const isRewardOrUnlock = ctx.type === 'reward'
        || ctx.type === 'brevis-reward'
        || ctx.type === 'fuul-reward'
        || ctx.type === 'turtle-reward'
        || ctx.type === 'reul-unlock'
      const rewardIconUrl = ['EUL', 'rEUL'].includes(ctx.asset.symbol)
        ? getLogoUrl(ctx.asset.address, 'EUL')
        : ctx.assetIconUrl
      steps.push({
        index,
        label: cleanStepLabel(item.functionName),
        isSeparateTx: true,
        assetInfo: isRewardOrUnlock
          ? {
              symbol: ctx.asset.symbol,
              address: ctx.asset.address,
              amount: ctx.amount,
              iconUrl: rewardIconUrl,
            }
          : undefined,
      })
      continue
    }

    // cowSwap items: skip silently; CoW flows surface their own UI.
  }

  return steps
}
