import { nextTick, reactive, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const FIRST = '0x0000000000000000000000000000000000000001'
const SECOND = '0x0000000000000000000000000000000000000002'
const FIRST_OWNER = '0x0000000000000000000000000000000000000011'
const EVC = '0x00000000000000000000000000000000000000e0'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('useSpyMode', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('window', { location: { search: '' } })
    vi.stubGlobal('useRoute', () => ({ path: '/portfolio/activity', query: {}, hash: '' }))
    vi.stubGlobal('useRouter', () => ({ replace: vi.fn() }))
    vi.stubGlobal('useEulerAddresses', () => ({
      eulerCoreAddresses: ref({ evc: EVC }),
      chainId: ref(1),
    }))
    vi.stubGlobal('useRpcClient', () => ({ client: ref(null) }))
  })

  it('replaces the active spy address synchronously for internal account links', async () => {
    const { useSpyMode } = await import('~/composables/useSpyMode')
    const spy = useSpyMode()

    expect(spy.activateSpyMode(FIRST)).toBe(true)
    expect(spy.spyAddress.value.toLowerCase()).toBe(FIRST)

    expect(spy.activateSpyMode(SECOND)).toBe(true)
    expect(spy.spyAddress.value.toLowerCase()).toBe(SECOND)
  })

  it('follows valid spy query changes from browser history', async () => {
    const route = reactive({
      path: '/portfolio/activity',
      query: { spy: FIRST },
      hash: '',
    })
    vi.stubGlobal('window', { location: { search: `?spy=${FIRST}` } })
    vi.stubGlobal('useRoute', () => route)

    const { useSpyMode } = await import('~/composables/useSpyMode')
    const spy = useSpyMode()

    expect(spy.spyAddress.value.toLowerCase()).toBe(FIRST)

    route.query.spy = SECOND
    await nextTick()
    expect(spy.spyAddress.value.toLowerCase()).toBe(SECOND)

    route.query.spy = FIRST
    await nextTick()
    expect(spy.spyAddress.value.toLowerCase()).toBe(FIRST)
  })

  it('ignores an owner resolution for a superseded spy address', async () => {
    const firstOwner = deferred<string>()
    const replace = vi.fn()
    const readContract = vi.fn(({ args }: { args: [string] }) =>
      args[0].toLowerCase() === FIRST ? firstOwner.promise : Promise.resolve(SECOND),
    )
    vi.stubGlobal('useRouter', () => ({ replace }))
    vi.stubGlobal('useRpcClient', () => ({ client: ref({ readContract }) }))

    const { useSpyMode } = await import('~/composables/useSpyMode')
    const spy = useSpyMode()

    spy.activateSpyMode(FIRST)
    await nextTick()
    expect(readContract).toHaveBeenCalledTimes(1)

    spy.activateSpyMode(SECOND)
    firstOwner.resolve(FIRST_OWNER)
    await firstOwner.promise
    await nextTick()

    expect(spy.spyAddress.value.toLowerCase()).toBe(SECOND)
    expect(replace).not.toHaveBeenCalledWith(expect.objectContaining({
      query: expect.objectContaining({ spy: FIRST_OWNER }),
    }))
  })

  it('resolves the owner once the RPC client becomes available', async () => {
    const client = ref<null | { readContract: ReturnType<typeof vi.fn> }>(null)
    const readContract = vi.fn(async () => FIRST_OWNER)
    vi.stubGlobal('useRpcClient', () => ({ client }))

    const { useSpyMode } = await import('~/composables/useSpyMode')
    const spy = useSpyMode()

    spy.activateSpyMode(FIRST)
    await nextTick()
    // No client yet — nothing to resolve with, and nothing accepted.
    expect(readContract).not.toHaveBeenCalled()
    expect(spy.spyAddress.value.toLowerCase()).toBe(FIRST)

    client.value = { readContract }
    await nextTick()
    await vi.waitFor(() => expect(spy.spyAddress.value).toBe(FIRST_OWNER))
  })

  it('retries a rejected owner lookup instead of accepting the address', async () => {
    vi.useFakeTimers()
    try {
      const readContract = vi.fn()
        .mockRejectedValueOnce(new Error('rpc down'))
        .mockResolvedValue(FIRST_OWNER)
      vi.stubGlobal('useRpcClient', () => ({ client: ref({ readContract }) }))

      const { useSpyMode } = await import('~/composables/useSpyMode')
      const spy = useSpyMode()

      spy.activateSpyMode(FIRST)
      await vi.waitFor(() => expect(readContract).toHaveBeenCalledTimes(1))
      await Promise.resolve()
      // The failed lookup must not be accepted as a resolution.
      expect(spy.spyAddress.value.toLowerCase()).toBe(FIRST)

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.waitFor(() => expect(readContract).toHaveBeenCalledTimes(2))
      await vi.waitFor(() => expect(spy.spyAddress.value).toBe(FIRST_OWNER))
    }
    finally {
      vi.useRealTimers()
    }
  })
})
