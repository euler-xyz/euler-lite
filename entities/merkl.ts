export interface Opportunity {
  chainId: number
  chain?: { name: string }
  type: string
  identifier: string
  name: string
  description: string
  howToSteps: string[]
  status: 'LIVE' | 'PAST'
  action: string
  tvl: number
  apr: number
  dailyRewards: number
  tags: string[]
  id: string
  depositUrl: string
  explorerAddress: string
  lastCampaignCreatedAt: number
  tokens: {
    id: string
    name: string
    chainId: number
    address: string
    decimals: number
    icon: string
    verified: boolean
    isTest: boolean
    type: string
    isNative: boolean
    price: number
    symbol: string
  }[]
  aprRecord: {
    cumulated: number
    timestamp: string
    breakdowns: {
      distributionType: string
      identifier: string
      type: string
      value: number
      timestamp: string
    }[]
  }
  tvlRecord: {
    id: string
    total: number
    timestamp: string
    breakdowns: {
      identifier: string
      type: string
      value: number
    }[]
  }
  rewardsRecord: {
    id: string
    total: number
    timestamp: string
    breakdowns: {
      token: {
        id: string
        name: string
        chainId: number
        address: string
        decimals: number
        symbol: string
        displaySymbol: string
        icon: string
        verified: boolean
        isTest: boolean
        type: string
        isNative: boolean
        price: number
      }
      amount: string
      value: number
      distributionType: string
      id: string
      timestamp: string
      campaignId: string
      dailyRewardsRecordId: string
    }[]
  }
  campaigns: {
    id: string
    computeChainId: number
    distributionChainId: number
    campaignId: string
    type: string
    distributionType: string
    subType: number
    rewardTokenId: string
    amount: string
    opportunityId: string
    startTimestamp: number
    endTimestamp: number
    dailyRewards: number
    apr: number
    creatorAddress: string
    rewardToken: {
      id: string
      name: string
      chainId: number
      address: string
      decimals: number
      icon: string
      verified: boolean
      isTest: boolean
      type: string
      isNative: boolean
      price: number
      symbol: string
    }
    campaignStatus: {
      campaignId: string
      computedUntil: number
      processingStarted: number
      status: string
      error: string
    }
    params?: {
      evkAddress?: string
      targetToken?: string
      collateralAddress?: string
      markets?: {
        campaignParameters: {
          evkAddress?: string
          targetToken: string
        }
      }[]
    }
    createdAt: string
  }[]
}

export interface Reward {
  root: string
  recipient: string
  amount: string
  claimed: string
  pending: string
  proofs: string[]
  token: {
    address: string
    chainId: number
    symbol: string
    decimals: number
    price: number
  }
  breakdowns: {
    reason: string
    amount: string
    claimed: string
    pending: string
    campaignId: string
  }[]
}
export interface RewardsResponseItem {
  chain: {
    id: number
    name: string
    icon: string
    Explorer: {
      id: string
      type: string
      url: string
      chainId: number
    }[]
  }
  rewards: Reward[]
}

export interface RewardToken {
  id: string
  name: string
  chainId: number
  address: string
  decimals: number
  symbol: string
  displaySymbol: string
  icon: string
  verified: boolean
  isTest: boolean
  type: string
  isNative: boolean
  price: number | null
  minimumAmountPerHour: string
}
