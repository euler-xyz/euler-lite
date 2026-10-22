import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../../scripts/csp-page-probe.mjs', import.meta.url))
const run = (args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 5000 })
// An unsupported channel stops valid arguments at browser launch without opening a browser.
const target = ['--url', 'https://example.invalid', '--channel', 'invalid-test-channel']

describe('CSP page probe arguments', () => {
  it.each(['0', '-1', 'NaN', 'Infinity', 'abc', '', '0.5', '2147483648'])('rejects an unsafe wait duration: %s', (wait) => {
    const result = run([...target, `--wait=${wait}`])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--wait must be an integer between 1 and 2147483647 milliseconds')
    expect(result.stderr).not.toContain('Unsupported chromium channel')
  })

  it.each(['url', 'wait', 'channel'])('rejects a missing operand for --%s', (flag) => {
    const result = run([...target, `--${flag}`])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`Option '--${flag} <value>' argument missing`)
  })

  it('rejects another flag in place of a wait value', () => {
    const result = run([...target, '--wait', '--url', 'https://example.invalid'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Option \'--wait\' argument is ambiguous')
  })

  it.each([
    { name: 'default', args: [] },
    { name: 'explicit', args: ['--wait', '1000'] },
  ])('accepts a $name wait duration', ({ args }) => {
    const result = run([...target, ...args])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Unsupported chromium channel')
  })
})
