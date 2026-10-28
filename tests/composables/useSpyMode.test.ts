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

const ZERO = '0x0000000000000000000000000000000000000000'

/** EVC answering "never registered" — the address is safe as itself. */
const selfOwnedClient = () => ({ readContract: vi.fn(async () => ZERO) })

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

  it('engages spy mode immediately but only consumes verified addresses', async () => {
    vi.stubGlobal('useRpcClient', () => ({ client: ref(selfOwnedClient()) }))
    const { useSpyMode } = await import('~/composables/useSpyMode')
    const spy = useSpyMode()

    expect(spy.activateSpyMode(FIRST)).toBe(true)
    // Spy context is active, but the unverified candidate is not consumable.
    expect(spy.isSpyMode.value).toBe(true)
    expect(spy.isSpyResolving.value).toBe(true)
    expect(spy.spyAddress.value).toBe('')
    await vi.waitFor(() => expect(spy.spyAddress.value.toLowerCase()).toBe(FIRST))
    expect(spy.isSpyResolving.value).toBe(false)

    expect(spy.activateSpyMode(SECOND)).toBe(true)
    expect(spy.spyAddress.value).toBe('')
    await vi.waitFor(() => expect(spy.spyAddress.value.toLowerCase()).toBe(SECOND))
  })

  it('follows valid spy query changes from browser history', async () => {
    const route = reactive({
      path: '/portfolio/activity',
      query: { spy: FIRST },
      hash: '',
    })
    vi.stubGlobal('window', { location: { search: `?spy=${FIRST}` } })
    vi.stubGlobal('useRoute', () => route)
    vi.stubGlobal('useRpcClient', () => ({ client: ref(selfOwnedClient()) }))

    const { useSpyMode } = await import('~/composables/useSpyMode')
    const spy = useSpyMode()

    await vi.waitFor(() => expect(spy.spyAddress.value.toLowerCase()).toBe(FIRST))

    route.query.spy = SECOND
    await nextTick()
    await vi.waitFor(() => expect(spy.spyAddress.value.toLowerCase()).toBe(SECOND))

    route.query.spy = FIRST
    await nextTick()
    await vi.waitFor(() => expect(spy.spyAddress.value.toLowerCase()).toBe(FIRST))
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
    await vi.waitFor(() => expect(spy.spyAddress.value.toLowerCase()).toBe(SECOND))
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
    // No client yet — nothing to resolve with, and nothing consumable.
    expect(readContract).not.toHaveBeenCalled()
    expect(spy.spyAddress.value).toBe('')
    expect(spy.isSpyResolving.value).toBe(true)

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
      // The failed lookup keeps the candidate pending — never consumable.
      expect(spy.spyAddress.value).toBe('')
      expect(spy.isSpyResolving.value).toBe(true)

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.waitFor(() => expect(readContract).toHaveBeenCalledTimes(2))
      await vi.waitFor(() => expect(spy.spyAddress.value).toBe(FIRST_OWNER))
    }
    finally {
      vi.useRealTimers()
    }
  })
  it('rewrites a sub-account candidate to its owner in state and URL', async () => {
    const replace = vi.fn()
    // EVC answers with a different owner — the candidate is a sub-account.
    const readContract = vi.fn(async () => FIRST_OWNER)
    vi.stubGlobal('useRouter', () => ({ replace }))
    vi.stubGlobal('useRpcClient', () => ({ client: ref({ readContract }) }))

    const { useSpyMode } = await import('~/composables/useSpyMode')
    const spy = useSpyMode()

    spy.activateSpyMode(FIRST)
    await vi.waitFor(() => expect(spy.spyAddress.value).toBe(FIRST_OWNER))
    expect(replace).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.objectContaining({ spy: FIRST_OWNER }),
    }))
  })

  it('never adopts a candidate cleared while resolution was pending', async () => {
    const pendingLookup = deferred<string>()
    const replace = vi.fn()
    const readContract = vi.fn(() => pendingLookup.promise)
    vi.stubGlobal('useRouter', () => ({ replace }))
    vi.stubGlobal('useRpcClient', () => ({ client: ref({ readContract }) }))

    const { useSpyMode } = await import('~/composables/useSpyMode')
    const spy = useSpyMode()

    spy.activateSpyMode(FIRST)
    await vi.waitFor(() => expect(readContract).toHaveBeenCalledTimes(1))
    await spy.clearSpyMode()
    expect(spy.isSpyMode.value).toBe(false)

    pendingLookup.resolve(FIRST_OWNER)
    await pendingLookup.promise
    await nextTick()
    expect(spy.spyAddress.value).toBe('')
    expect(spy.isSpyMode.value).toBe(false)
  })

  it('stays pending and unconsumed after exhausting every retry', async () => {
    vi.useFakeTimers()
    try {
      const readContract = vi.fn().mockRejectedValue(new Error('rpc down'))
      vi.stubGlobal('useRpcClient', () => ({ client: ref({ readContract }) }))

      const { useSpyMode } = await import('~/composables/useSpyMode')
      const spy = useSpyMode()

      spy.activateSpyMode(FIRST)
      // initial attempt + 5 retries, then no further scheduling
      for (let round = 0; round < 8; round++) {
        await vi.advanceTimersByTimeAsync(4_500)
      }
      expect(readContract.mock.calls.length).toBe(6)
      expect(spy.spyAddress.value).toBe('')
      expect(spy.isSpyMode.value).toBe(true)
      expect(spy.isSpyResolving.value).toBe(true)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('short-circuits re-activation of an already verified address', async () => {
    const readContract = vi.fn(async () => ZERO)
    vi.stubGlobal('useRpcClient', () => ({ client: ref({ readContract }) }))

    const { useSpyMode } = await import('~/composables/useSpyMode')
    const spy = useSpyMode()

    spy.activateSpyMode(FIRST)
    await vi.waitFor(() => expect(spy.spyAddress.value.toLowerCase()).toBe(FIRST))
    const callsAfterFirst = readContract.mock.calls.length

    expect(spy.activateSpyMode(FIRST)).toBe(true)
    await nextTick()
    // No blanking, no second verification round.
    expect(spy.spyAddress.value.toLowerCase()).toBe(FIRST)
    expect(spy.isSpyResolving.value).toBe(false)
    expect(readContract.mock.calls.length).toBe(callsAfterFirst)
  })

  it('keeps the in-flight resolution when the pending address is re-activated', async () => {
    const owner = deferred<string>()
    const readContract = vi.fn(() => owner.promise)
    vi.stubGlobal('useRpcClient', () => ({ client: ref({ readContract }) }))

    const { useSpyMode } = await import('~/composables/useSpyMode')
    const spy = useSpyMode()

    spy.activateSpyMode(FIRST)
    await nextTick()
    expect(readContract).toHaveBeenCalledTimes(1)

    // An Activity click activates spy mode, then another consumer re-reads
    // the same ?spy= value while the owner lookup is still in flight. The
    // same-value ref write cannot re-trigger the watcher, so invalidating
    // the request id here would discard the only pending result and strand
    // the candidate unresolved forever.
    expect(spy.activateSpyMode(FIRST)).toBe(true)
    await nextTick()
    expect(readContract).toHaveBeenCalledTimes(1)
    expect(spy.isSpyResolving.value).toBe(true)

    owner.resolve(FIRST_OWNER)
    await vi.waitFor(() => expect(spy.spyAddress.value).toBe(FIRST_OWNER))
    expect(spy.isSpyResolving.value).toBe(false)
  })

  it('rejects invalid input without touching spy state', async () => {
    vi.stubGlobal('useRpcClient', () => ({ client: ref(selfOwnedClient()) }))
    const { useSpyMode } = await import('~/composables/useSpyMode')
    const spy = useSpyMode()

    expect(spy.activateSpyMode('not-an-address')).toBe(false)
    expect(spy.activateSpyMode('0x1234')).toBe(false)
    expect(spy.isSpyMode.value).toBe(false)
    expect(spy.spyAddress.value).toBe('')
  })

  it('persists the unverified candidate in the URL via setSpyMode', async () => {
    const replace = vi.fn()
    const never = deferred<string>()
    const readContract = vi.fn(() => never.promise)
    vi.stubGlobal('useRouter', () => ({ replace }))
    vi.stubGlobal('useRpcClient', () => ({ client: ref({ readContract }) }))

    const { useSpyMode } = await import('~/composables/useSpyMode')
    const spy = useSpyMode()

    await spy.setSpyMode(FIRST)
    // The URL carries the user-supplied candidate while verification runs…
    expect(replace).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.objectContaining({ spy: expect.stringMatching(/^0x0{39}1$/i) }),
    }))
    // …but nothing consumable exists yet.
    expect(spy.spyAddress.value).toBe('')
    expect(spy.isSpyResolving.value).toBe(true)
  })
})
