import { describe, it, expect, beforeAll } from 'vitest'
import { installConsoleCapture, getRecentConsoleOutput } from '~/utils/console-capture'

describe('console-capture', () => {
  beforeAll(() => {
    installConsoleCapture()
  })

  it('captures console output with level and timestamp', () => {
    console.log('hello capture')
    const output = getRecentConsoleOutput()
    expect(output).toMatch(/\[log\] hello capture/)
    expect(output).toMatch(/\d{4}-\d{2}-\d{2}T/)
  })

  it('serializes non-string arguments', () => {
    console.warn('state', { chainId: 1, ok: true })
    expect(getRecentConsoleOutput()).toContain('[warn] state {"chainId":1,"ok":true}')
  })

  it('redacts query-string values so URL-borne API keys never reach a ticket', () => {
    console.error('rpc failed https://eth-mainnet.alchemy.com/v2/data?apiKey=supersecret123&x=1')
    const output = getRecentConsoleOutput()
    expect(output).not.toContain('supersecret123')
    expect(output).toContain('?apiKey=[redacted]')
  })

  it('survives circular structures without throwing', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => console.log(circular)).not.toThrow()
    expect(getRecentConsoleOutput()).toContain('[object Object]')
  })

  it('truncates individual entries', () => {
    console.log('x'.repeat(5000))
    const line = getRecentConsoleOutput().split('\n').find(l => l.includes('xxx'))
    expect(line).toBeDefined()
    expect(line!.length).toBeLessThan(500)
  })

  it('caps total output below the HelpScout session-data value limit', () => {
    for (let i = 0; i < 200; i++) {
      console.log(`filler line ${i} ${'y'.repeat(300)}`)
    }
    const output = getRecentConsoleOutput()
    expect(output.length).toBeLessThanOrEqual(9000)
    // newest entries win — the last line logged must be present
    expect(output).toContain('filler line 199')
  })
})
