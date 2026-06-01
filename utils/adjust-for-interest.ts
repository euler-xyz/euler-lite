import { INTEREST_ADJUSTMENT_BPS, BPS_BASE } from '~/entities/tuning-constants'

/** Pad amount by 0.01% to cover interest accrual between plan build and tx execution. */
export const adjustForInterest = (amount: bigint) => (amount * INTEREST_ADJUSTMENT_BPS) / BPS_BASE
