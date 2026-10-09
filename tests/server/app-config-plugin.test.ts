import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  get: vi.fn(() => ''),
  start: vi.fn(() => Promise.resolve()),
  stop: vi.fn(),
}))

vi.mock('~/server/utils/v3-images-base', () => ({
  createV3ImagesBaseSource: () => ({ get: mocks.get, start: mocks.start, stop: mocks.stop, refresh: vi.fn() }),
}))

const BASE = 'https://v3.example/v3/images'
const PRIVATE_V3 = 'https://v3-internal.example'

type Hook = (...args: unknown[]) => void

const bootPlugin = async () => {
  vi.resetModules()
  vi.stubEnv('V3_API_URL', PRIVATE_V3)
  const { default: plugin } = await import('~/server/plugins/app-config')
  const hooks = new Map<string, Hook>()
  plugin({ hooks: { hook: (name: string, fn: Hook) => hooks.set(name, fn) } } as never)
  const render = async () => {
    const html = { head: [] as string[] }
    await hooks.get('render:html')!(html)
    return html.head.join('')
  }
  return { hooks, render }
}

describe('app-config plugin images base', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    mocks.get.mockReset().mockReturnValue('')
    mocks.start.mockReset().mockImplementation(() => Promise.resolve())
    mocks.stop.mockReset()
  })

  it('starts reading the images base at boot and injects the current value on every render', async () => {
    const { render } = await bootPlugin()
    expect(mocks.start).toHaveBeenCalledTimes(1)

    expect(await render()).toContain('"v3ImagesUrl":""')
    mocks.get.mockReturnValue(BASE)
    expect(await render()).toContain(`"v3ImagesUrl":"${BASE}"`)
  })

  it('holds the first render until the boot read answers', async () => {
    let answer = () => {}
    mocks.start.mockImplementation(() => new Promise<void>((resolve) => {
      answer = () => {
        mocks.get.mockReturnValue(BASE)
        resolve()
      }
    }))
    const { render } = await bootPlugin()

    const html = render()
    answer()
    expect(await html).toContain(`"v3ImagesUrl":"${BASE}"`)
  })

  it('stops waiting for a slow boot read after a bounded time', async () => {
    vi.useFakeTimers()
    try {
      mocks.start.mockImplementation(() => new Promise<void>(() => {}))
      const { render } = await bootPlugin()

      const html = render()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await html).toContain('"v3ImagesUrl":""')
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('escapes the injected value inside the script element', async () => {
    mocks.get.mockReturnValue('https://x/</script><script>alert(1)')
    const { render } = await bootPlugin()

    const html = await render()
    expect(html).not.toContain('</script><script>alert(1)')
    expect(html).toContain('\\u003c/script>')
  })

  it('never sends the private V3 URL to the browser', async () => {
    mocks.get.mockReturnValue(BASE)
    const { render } = await bootPlugin()

    expect(await render()).not.toContain(PRIVATE_V3)
  })

  it('stops refreshing when Nitro closes', async () => {
    const { hooks } = await bootPlugin()
    hooks.get('close')!()

    expect(mocks.stop).toHaveBeenCalledTimes(1)
  })
})
