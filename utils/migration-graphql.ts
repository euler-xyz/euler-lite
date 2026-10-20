// Documents shared by the browser and the migration proxy policy. The market
// documents match the pinned SDK; a compatibility test detects SDK changes.
export const AAVE_MARKETS_QUERY = `
\tquery AaveMigrationMarkets($request: MarketsRequest!) {
\t\tmarkets(request: $request) {
\t\t\tname
\t\t\taddress
\t\t\tchain { chainId }
\t\t\ttotalAvailableLiquidity
\t\t\ttotalMarketSize
\t\t\treserves {
\t\t\t\tunderlyingToken { address symbol decimals }
\t\t\t\taToken { address symbol decimals }
\t\t\t\tvToken { address symbol decimals }
\t\t\t\tisFrozen
\t\t\t\tisPaused
\t\t\t\tsupplyInfo {
\t\t\t\t\tcanBeCollateral
\t\t\t\t\tmaxLTV { raw decimals value }
\t\t\t\t\ttotal { raw decimals value }
\t\t\t\t}
\t\t\t\tborrowInfo {
\t\t\t\t\tborrowingState
\t\t\t\t\tavailableLiquidity { amount { raw decimals value } }
\t\t\t\t\ttotal { amount { raw decimals value } }
\t\t\t\t}
\t\t\t}
\t\t}
\t}
`

export const MORPHO_MARKETS_QUERY = `#graphql
query EulerMigrationMorphoMarkets($chainIds: [Int!], $loanAssets: [String!], $collateralAssets: [String!]) {
  markets(
    first: 100
    where: {
      chainId_in: $chainIds
      loanAssetAddress_in: $loanAssets
      collateralAssetAddress_in: $collateralAssets
      listed: true
    }
  ) {
    items {
      marketId
      listed
      lltv
      irmAddress
      oracle { address }
      loanAsset { address symbol decimals }
      collateralAsset { address symbol decimals }
      state {
        borrowApy
        netBorrowApy
        supplyApy
        liquidityAssets
        liquidityAssetsUsd
      }
    }
  }
}
`

export const MORPHO_USER_POSITIONS_QUERY = `#graphql
query LiteMorphoMigrationPositions($chainId: Int!, $address: String!) {
  userByAddress(chainId: $chainId, address: $address) {
    address
    marketPositions {
      market {
        marketId
        lltv
        irmAddress
        oracle { address }
        loanAsset { address symbol decimals }
        collateralAsset { address symbol decimals }
        state { borrowApy }
      }
      state {
        collateral
        collateralUsd
        borrowAssets
        borrowAssetsUsd
      }
    }
    vaultPositions {
      vault {
        address
        name
        symbol
        asset { address symbol decimals }
      }
      state {
        shares
        assets
        assetsUsd
      }
    }
    vaultV2Positions {
      vault {
        address
        name
        symbol
        asset { address symbol decimals }
      }
      shares
      assets
      assetsUsd
    }
  }
}
`
