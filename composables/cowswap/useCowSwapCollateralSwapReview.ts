import { onScopeDispose, toRaw } from 'vue'
import { erc20Abi, formatUnits, getAddress, type Address } from 'viem'
import { Account, type EVault, type IHasVaultAddress, type SwapQuote } from '@eulerxyz/euler-v2-sdk'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import { convertVaultSharesToAssets } from '~/utils/vault-utils'
import { trimTrailingZeros } from '~/utils/string-utils'
import type { DisplayStep } from '~/utils/stepDecoding'
import { COWSWAP_ORDER_DEADLINE_SECONDS, getCowSwapChainConfig, getCowSwapQuoteOrderAmounts } from '~/entities/cowswap'
import type { CowSwapCollateralSwapExecuteParams, useCowSwapCollateralSwapExecution } from './useCowSwapCollateralSwapExecution'
import type { useCowSwapOrderStatus } from './useCowSwapOrderStatus'
import { buildApprovalSignSteps, openCowSwapReviewModal } from './openCowSwapReviewModal'

interface CollateralSwapReviewInput {
  chainId: number
  owner: Address
  subAccount: Address
  account: Account<IHasVaultAddress> | undefined
  fromVault: Pick<EVault, 'address' | 'asset' | 'totalShares' | 'totalAssets'>
  toVault: Pick<EVault, 'address' | 'asset' | 'totalShares' | 'totalAssets'>
  quote: SwapQuote
  collateralShares: bigint
  collateralAssets: bigint
  slippage: number
  quoteFetchedAt: number | null
}

const STALE_REVIEW_MESSAGE = 'Collateral swap changed. Review the updated quote and try again.'

// Everything a review depends on besides the quote itself. Compared by value, so a
// refetch that swaps in an equal vault or account object does not count as a change.
const selectionKey = (input: CollateralSwapReviewInput) => [
  input.chainId, input.owner, input.subAccount, input.account?.owner, input.account?.chainId,
  input.fromVault.address, input.toVault.address, input.collateralShares, input.collateralAssets,
  input.slippage, input.quoteFetchedAt,
].join('|').toLowerCase()

/**
 * Opens the CoW review for a collateral swap. `getInput` returns what the form shows
 * right now, or undefined when a CoW collateral swap is not possible.
 *
 * The review rows and the order are both built from one copy of the input taken before
 * any await. The live form is only read again to ask "is this still what the user sees?",
 * once after the allowance read and once more at Confirm.
 */
export const useCowSwapCollateralSwapReview = (options: {
  getInput: () => CollateralSwapReviewInput | undefined
  execution: ReturnType<typeof useCowSwapCollateralSwapExecution>
  orderStatus: ReturnType<typeof useCowSwapOrderStatus>
}) => {
  const modal = useModal()
  const { error: showError } = useToast()
  const { client: rpcClient } = useRpcClient()

  let disposed = false
  onScopeDispose(() => {
    disposed = true
  })

  const submit = async () => {
    const input = options.getInput()
    if (!input) return

    // Quotes are replaced, never edited, so the same object means the same quote.
    const reviewedQuote = toRaw(input.quote)
    const reviewedKey = selectionKey(input)
    const isCurrent = () => {
      if (disposed) return false
      const live = options.getInput()
      return !!live && toRaw(live.quote) === reviewedQuote && selectionKey(live) === reviewedKey
    }

    try {
      const { chainId, owner, subAccount, slippage, quoteFetchedAt } = input
      const chainConfig = getCowSwapChainConfig(chainId)
      if (!chainConfig) throw new Error('CoW is not available on this network')
      if (input.collateralShares <= 0n) throw new Error('Collateral share balance is unavailable')
      if (!input.account) throw new Error('Account not ready')

      // Copy the quote and the account identity; the SDK derives the order and wrapper
      // destination from this quote, never from the live form after an await.
      const quote = structuredClone(reviewedQuote)
      const account = new Account(input.account)
      const fromVault = { ...input.fromVault, asset: { ...input.fromVault.asset } }
      const toVault = { ...input.toVault, asset: { ...input.toVault.asset } }
      // The quote must have been fetched for exactly this form state. Whether it is a
      // CoW quote is the caller's call (`getInput`); the SDK planner checks it again.
      if (getAddress(quote.vaultIn) !== getAddress(fromVault.address)
        || getAddress(quote.receiver) !== getAddress(toVault.address)
        || getAddress(quote.accountIn) !== getAddress(subAccount)
        || getAddress(quote.accountOut) !== getAddress(subAccount)
        || getAddress(account.owner) !== getAddress(owner)
        || account.chainId !== chainId
        || quote.slippage !== slippage) {
        throw new Error(STALE_REVIEW_MESSAGE)
      }

      const orderAmounts = getCowSwapQuoteOrderAmounts(quote, { slippage, slippageTarget: 'buyAmount' })
      if (!orderAmounts) throw new Error('Invalid CoW quote: missing order amounts')
      const { sellAmount, buyAmount } = orderAmounts
      if (sellAmount !== input.collateralShares) throw new Error(STALE_REVIEW_MESSAGE)

      options.execution.reset()
      const cowParams: CowSwapCollateralSwapExecuteParams = {
        chainId,
        account,
        swapQuote: quote,
        slippage,
        validTo: Math.floor(Date.now() / 1000) + COWSWAP_ORDER_DEADLINE_SECONDS,
        disableSourceCollateral: true,
      }
      const fromAsset = fromVault.asset
      const toAsset = toVault.asset
      const fromShareAmount = trimTrailingZeros(formatUnits(sellAmount, Number(fromAsset.decimals)))
      const fromAssetAmount = trimTrailingZeros(formatUnits(convertVaultSharesToAssets(fromVault, sellAmount), Number(fromAsset.decimals)))
      const quotedBuyAmount = BigInt(quote.providerData!.buyAmount!)
      const toAssetAmount = trimTrailingZeros(formatUnits(convertVaultSharesToAssets(toVault, quotedBuyAmount), Number(toAsset.decimals)))
      const toAssetMinAmount = trimTrailingZeros(formatUnits(convertVaultSharesToAssets(toVault, buyAmount), Number(toAsset.decimals)))

      let currentAllowance = 0n
      try {
        const client = rpcClient.value
        if (client) {
          currentAllowance = await client.readContract({
            address: fromVault.address as Address,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [owner, chainConfig.vaultRelayer],
            authorizationList: undefined,
          }) as bigint
        }
      }
      catch {
        // Allowance failures only affect approval display; selection changes still abort.
      }
      if (!isCurrent()) throw new Error(STALE_REVIEW_MESSAGE)

      const signSteps: DisplayStep[] = []
      let signIdx = 1
      const approval = buildApprovalSignSteps({
        chainId,
        tokenAddress: fromVault.address as Address,
        currentAllowance,
        requiredAmount: sellAmount,
        label: 'Approve for swap',
        assetInfo: {
          symbol: fromAsset.symbol,
          address: fromVault.address,
          iconAddress: fromAsset.address,
          amount: fromShareAmount,
        },
        startIndex: signIdx,
      })
      signSteps.push(...approval.steps)
      signIdx = approval.nextIndex
      signSteps.push({ index: signIdx++, label: 'Sign EVC permit', isSeparateTx: false })
      signSteps.push({ index: signIdx++, label: 'Sign CoW order', isSeparateTx: false })

      let wrapperIdx = 1
      const wrapperSteps: DisplayStep[] = [
        { index: wrapperIdx++, label: 'Enable collateral', labelSuffix: toAsset.symbol, isSeparateTx: false },
        { index: wrapperIdx++, label: 'Disable source collateral', labelSuffix: fromAsset.symbol, isSeparateTx: false },
        {
          index: wrapperIdx++,
          label: 'Transfer to wallet',
          isSeparateTx: false,
          assetInfo: {
            symbol: fromAsset.symbol,
            address: fromVault.address,
            iconAddress: fromAsset.address,
            amount: fromShareAmount,
          },
        },
        {
          index: wrapperIdx++,
          label: 'Swap',
          isSeparateTx: false,
          assetInfo: { symbol: fromAsset.symbol, address: fromAsset.address, amount: fromAssetAmount },
          toAssetInfo: { symbol: toAsset.symbol, address: toAsset.address, amount: toAssetAmount },
        },
        {
          index: wrapperIdx++,
          label: 'Verify min received',
          isSeparateTx: false,
          assetInfo: { symbol: toAsset.symbol, address: toAsset.address, amount: toAssetMinAmount },
        },
      ]

      const walletWarningsDescription
        = 'The CoW order and transfer steps use vault-share amounts. Swap and received amounts are shown in underlying assets. '
          + 'The CoW order receiver is your sub-account, not your main wallet - your wallet may flag this as a mismatch. '
          + 'You can verify the first 19 bytes (38 hex chars after "0x") of the receiver match your wallet address.'

      const modalId = openCowSwapReviewModal(modal, {
        signSteps,
        wrapperSteps,
        walletWarningsDescription,
        execution: options.execution,
        orderStatus: options.orderStatus,
        executeParams: cowParams,
        quoteFetchedAt,
        // A review that no longer matches the form can never be confirmed, so close it
        // and send the user back to the form instead of leaving a dead Confirm button.
        beforeConfirm: () => {
          if (isCurrent()) return true
          modal.close(modalId)
          showError(STALE_REVIEW_MESSAGE)
          return false
        },
        logPrefix: 'refinance/collateral-cowswap',
      })
    }
    catch (error) {
      // The user has left the page; a toast on the next one would only confuse.
      if (disposed) return
      showError(error instanceof Error ? error.message : 'Failed to prepare collateral swap')
    }
  }

  return { submit }
}
