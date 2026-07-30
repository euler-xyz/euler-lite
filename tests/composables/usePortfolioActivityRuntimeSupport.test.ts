import { ref } from 'vue'
import { describe, expect, it } from 'vitest'
import {
  buildPortfolioActivityContextKey,
  shouldLeavePortfolioActivityRoute,
  shouldShowPortfolioActivityTab,
  usePortfolioActivityRuntimeSupport,
} from '../../composables/usePortfolioActivityRuntimeSupport'

const OWNER = '0x1000000000000000000000000000000000000000'

describe('portfolio activity runtime support', () => {
  it('shares an authoritative result only within the active owner and chain', () => {
    const owner = ref<string | undefined>(OWNER)
    const chainId = ref(1)
    const writer = usePortfolioActivityRuntimeSupport(owner, chainId)
    const reader = usePortfolioActivityRuntimeSupport(owner, chainId)

    writer.setRuntimeUnsupported(false)
    expect(reader.isRuntimeUnsupported.value).toBe(false)

    writer.setRuntimeUnsupported(true)
    expect(reader.isRuntimeUnsupported.value).toBe(true)

    chainId.value = 8453
    expect(reader.isRuntimeUnsupported.value).toBe(false)

    chainId.value = 1
    expect(reader.isRuntimeUnsupported.value).toBe(true)

    owner.value = '0x2000000000000000000000000000000000000000'
    expect(reader.isRuntimeUnsupported.value).toBe(false)
  })

  it('normalizes the owner and rejects incomplete contexts', () => {
    expect(buildPortfolioActivityContextKey(OWNER.toUpperCase(), 1)).toBe(`${OWNER}:1`)
    expect(buildPortfolioActivityContextKey(undefined, 1)).toBeUndefined()
    expect(buildPortfolioActivityContextKey(OWNER, 0)).toBeUndefined()
  })

  it('keeps transient failures visible and redirects only after support settles', () => {
    expect(shouldShowPortfolioActivityTab(true, false)).toBe(true)
    expect(shouldShowPortfolioActivityTab(true, true)).toBe(false)
    expect(shouldShowPortfolioActivityTab(false, false)).toBe(false)

    expect(shouldLeavePortfolioActivityRoute({
      routeName: 'portfolio-activity',
      isChecking: true,
      shouldShow: false,
    })).toBe(false)
    expect(shouldLeavePortfolioActivityRoute({
      routeName: 'portfolio-activity',
      isChecking: false,
      shouldShow: false,
    })).toBe(true)
    expect(shouldLeavePortfolioActivityRoute({
      routeName: 'portfolio-rewards',
      isChecking: false,
      shouldShow: false,
    })).toBe(false)
  })
})
