import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { H3Event } from 'h3'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { reserveTenderlyCapacity } from '~/server/utils/tenderly-budget'
import type { TenderlyConfig } from '~/server/utils/tenderly'

vi.mock('~/server/utils/logger', () => ({ logger: { warn: vi.fn() } }))

// Opt in with a local Redis installation. This suite starts its own Redis with
// TCP disabled and a fresh Unix socket; it never connects to an existing store.
const binary = process.env.REDIS_SERVER_BINARY
const run = promisify(execFile)
describe.skipIf(!binary)('Tenderly EVAL against disposable local Redis', () => {
  let directory: string
  let redis: ChildProcess
  let rest: Server
  let config: TenderlyConfig
  const commands: string[][] = []
  const event = () => ({ node: { res: { setHeader: vi.fn() } } }) as unknown as H3Event
  const command = async (...args: string[]): Promise<unknown> => {
    const { stdout } = await run(join(dirname(binary!), 'redis-cli'), ['-s', join(directory, 'redis.sock'), '--json', ...args])
    return JSON.parse(stdout)
  }

  beforeAll(async () => {
    // A short socket path also works within macOS's Unix socket length limit.
    directory = await mkdtemp('/tmp/tenderly-redis-')
    redis = spawn(binary!, ['--port', '0', '--unixsocket', join(directory, 'redis.sock'),
      '--unixsocketperm', '700', '--save', '', '--appendonly', 'no', '--dir', directory], { stdio: ['ignore', 'pipe', 'pipe'] })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Disposable Redis startup timed out')), 5000)
      redis.once('error', reject)
      redis.once('exit', code => reject(new Error(`Disposable Redis exited: ${code}`)))
      redis.stdout!.on('data', (chunk) => {
        if (String(chunk).includes('Ready to accept connections')) {
          clearTimeout(timer)
          resolve()
        }
      })
    })
    rest = createServer(async (request, response) => {
      try {
        expect(request.headers.authorization).toBe('Bearer local-synthetic-token')
        let body = ''
        for await (const chunk of request) body += chunk
        const args = JSON.parse(body) as string[]
        expect(args.every(arg => typeof arg === 'string')).toBe(true)
        commands.push(args)
        const result = await command(...args)
        response.end(JSON.stringify({ result }))
      }
      catch {
        response.writeHead(400).end(JSON.stringify({ error: 'local-command-failed' }))
      }
    })
    await new Promise<void>(resolve => rest.listen(0, '127.0.0.1', resolve))
    const address = rest.address()
    if (!address || typeof address === 'string') throw new Error('Missing local REST address')
    // Production URL validation remains HTTPS-only. Only this owned loopback fixture uses HTTP.
    config = { accessKey: 'unused', accountSlug: 'local-account', projectSlug: 'local-project',
      budget: { url: `http://127.0.0.1:${address.port}`, token: 'local-synthetic-token', dailyLimit: 3, maxConcurrent: 2 } }
  })

  beforeEach(async () => {
    await command('FLUSHDB')
    commands.length = 0
  })

  afterAll(async () => {
    if (rest) await new Promise<void>((resolve, reject) => rest.close(error => error ? reject(error) : resolve()))
    if (redis?.exitCode === null) {
      const exited = once(redis, 'exit')
      redis.kill('SIGTERM')
      await exited
    }
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it('atomically caps concurrent attempts, charges the day, and prioritizes daily exhaustion', async () => {
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => reserveTenderlyCapacity(config, event())))
    const accepted = attempts.filter(attempt => attempt.status === 'fulfilled')
    expect(accepted).toHaveLength(2)
    expect(attempts.filter(attempt => attempt.status === 'rejected').every(attempt => attempt.reason.statusCode === 429)).toBe(true)
    const first = commands.find(args => args[0] === 'EVAL')!
    expect(await command('HGET', first[3], 'count')).toBe('2')
    expect(await command('ZCARD', first[4])).toBe(2)
    const ttl = await command('PTTL', first[3]) as number
    expect(ttl).toBeGreaterThan(172_790_000)
    expect(ttl).toBeLessThanOrEqual(172_800_000)
    await accepted[0].value()
    const third = await reserveTenderlyCapacity(config, event())
    expect(await command('ZCARD', first[4])).toBe(2)
    // Releasing the same lease again cannot remove another request's lease.
    await accepted[0].value()
    expect(await command('ZCARD', first[4])).toBe(2)
    const rejectedEvent = event()
    await expect(reserveTenderlyCapacity(config, rejectedEvent)).rejects.toMatchObject({ statusCode: 429, statusMessage: 'Tenderly daily capacity reached' })
    const [seconds] = await command('TIME') as string[]
    const retry = vi.mocked(rejectedEvent.node.res.setHeader).mock.calls[0][1] as number
    expect(retry).toBeGreaterThanOrEqual(86400 - Number(seconds) % 86400 - 1)
    expect(retry).toBeLessThanOrEqual(86400 - Number(seconds) % 86400 + 1)
    expect(await command('HGET', first[3], 'count')).toBe('3')
    await accepted[1].value()
    await third()
    expect(await command('ZCARD', first[4])).toBe(0)
  })

  it('uses Redis lease time for busy retries and recovers expired leases and the next UTC day', async () => {
    const limited = { ...config, budget: { ...config.budget, dailyLimit: 10, maxConcurrent: 1 } }
    await reserveTenderlyCapacity(limited, event())
    const first = commands[0]
    const busyEvent = event()
    await expect(reserveTenderlyCapacity(limited, busyEvent)).rejects.toMatchObject({ statusCode: 429, statusMessage: expect.stringContaining('busy') })
    expect(busyEvent.node.res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(Number))
    const retry = vi.mocked(busyEvent.node.res.setHeader).mock.calls[0][1] as number
    expect(retry).toBeGreaterThan(0)
    expect(retry).toBeLessThanOrEqual(45)
    const [seconds] = await command('TIME') as string[]
    await command('ZADD', first[4], String(Number(seconds) * 1000 - 1), first[7])
    const release = await reserveTenderlyCapacity(limited, event())
    expect(await command('HGET', first[3], 'count')).toBe('2')
    await release()
    await command('HSET', first[3], 'day', String(Math.floor(Number(seconds) / 86400) - 1), 'count', '10')
    const nextDay = await reserveTenderlyCapacity(limited, event())
    expect(await command('HGET', first[3], 'count')).toBe('1')
    expect(await command('HGET', first[3], 'day')).toBe(String(Math.floor(Number(seconds) / 86400)))
    await nextDay()
  })
})
