import { describe, expect, it } from 'vitest'
import { getDisplayStepAmountLabel } from '~/utils/display-step-amount'

describe('getDisplayStepAmountLabel', () => {
  it('preserves sentinel and descriptive base-unit amounts', () => {
    expect(getDisplayStepAmountLabel('max')).toBe('max')
    expect(getDisplayStepAmountLabel('Unlimited')).toBe('Unlimited')
    expect(getDisplayStepAmountLabel('123 base units')).toBe('123 base units')
  })

  it('leaves numeric values to the amount formatter', () => {
    expect(getDisplayStepAmountLabel('123.45')).toBeUndefined()
    expect(getDisplayStepAmountLabel(123.45)).toBeUndefined()
  })
})
