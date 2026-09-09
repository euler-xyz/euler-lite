import { describe, expect, it } from 'vitest'
import { getSubAccountAddress } from '@eulerxyz/euler-v2-sdk'
import { getSourcePositionTag } from '~/utils/positionTag'

const OWNER = '0x0000000000000000000000000000000000000001'
const POSITION_ONE = getSubAccountAddress(OWNER, 1)
const POSITION_TWO = getSubAccountAddress(OWNER, 2)

describe('position review tags', () => {
  it('identifies a distinct supplying position', () => {
    expect(getSourcePositionTag(OWNER, POSITION_TWO, POSITION_ONE)).toBe('From Position 2')
  })

  it('identifies deposits used to fund another position', () => {
    expect(getSourcePositionTag(OWNER, OWNER, POSITION_ONE)).toBe('From Deposits')
  })

  it('omits a source label when the operation uses its target position', () => {
    expect(getSourcePositionTag(OWNER, POSITION_ONE, POSITION_ONE)).toBeUndefined()
  })
})
