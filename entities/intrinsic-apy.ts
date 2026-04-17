export interface IntrinsicApyInfo {
  readonly apy: number
  readonly provider: string
  readonly source?: string
}

export const EMPTY_INTRINSIC_APY: IntrinsicApyInfo = { apy: 0, provider: '' }
