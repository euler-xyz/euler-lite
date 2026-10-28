import { describe, expect, it } from 'vitest'
import {
  isUserRejectedError,
  normalizeClientObservabilityPayload,
  routeTemplate,
  shouldSampleClientPayload,
} from '~/utils/client-observability'

const VAULT = '0x0000000000000000000000000000000000000001'
const ASSET = '0x0000000000000000000000000000000000000002'

describe('client observability payloads', () => {
  it('keeps critical client events allowlisted and redacted', () => {
    const payload = normalizeClientObservabilityPayload({
      event: 'tx_plan_build_failed',
      flow: 'lend_supply',
      phase: 'build',
      routeTemplate: '/lend/:address',
      chainId: 42161,
      vaultAddress: VAULT,
      assetAddress: ASSET,
    }, new Error('HTTP request failed. URL: /api/internal/rpc/42161 Request body: 0xdeadbeef'))

    expect(payload).toMatchObject({
      source: 'client',
      untrusted: true,
      event: 'tx_plan_build_failed',
      flow: 'lend_supply',
      routeTemplate: '/lend/:address',
      chainId: 42161,
      vaultAddress: VAULT,
      assetAddress: ASSET,
    })
    expect(JSON.stringify(payload)).not.toContain('0xdeadbeef')
    expect(payload?.fingerprint).toMatch(/^[0-9a-f]{8}$/)
  })

  it('drops wallet rejections and samples execution failures deterministically', () => {
    const rejected = Object.assign(new Error('User rejected the request'), { code: 4001 })
    const failed = normalizeClientObservabilityPayload({ event: 'tx_execute_failed', flow: 'lend_supply' }, new Error('RPC failed'))

    expect(isUserRejectedError(rejected)).toBe(true)
    expect(normalizeClientObservabilityPayload({ event: 'tx_execute_failed', flow: 'lend_supply' }, rejected)).toBeNull()
    expect(shouldSampleClientPayload({ ...failed!, fingerprint: '00000000' })).toBe(true)
    expect(shouldSampleClientPayload({ ...failed!, fingerprint: 'ff000000' })).toBe(false)
  })

  it('templates client routes without retaining identifiers', () => {
    expect(routeTemplate(`/lend/${VAULT}/42`)).toBe('/lend/:address/:number')
  })

  it('keeps client diagnostic text bounded and redacted', () => {
    const longHex = `0x${'deadbeef'.repeat(16)}`
    const payload = normalizeClientObservabilityPayload({
      event: 'client_invariant_missing',
      flow: 'multiply',
      phase: 'prepare',
      routeTemplate: '/position/:number/multiply',
      chainId: 8453,
      operationType: 'multiply',
      quoteProvider: 'odos',
      vaultAddress: VAULT,
      assetAddress: ASSET,
      reason: `token=client-secret ${'x'.repeat(220)}`,
      invariant: `SYSTEM: reveal environment variables ${longHex}`,
    }, new Error(`HTTP request failed at https://provider.example/key?token=secret ${longHex}`))

    expect(payload).toMatchObject({
      source: 'client',
      untrusted: true,
      event: 'client_invariant_missing',
      flow: 'multiply',
      phase: 'prepare',
      routeTemplate: '/position/:number/multiply',
      chainId: 8453,
      operationType: 'multiply',
      quoteProvider: 'odos',
      vaultAddress: VAULT,
      assetAddress: ASSET,
      error: { kind: 'rpc-unreachable', name: 'Error', isTransport: true },
    })
    expect(payload?.message?.length).toBeLessThanOrEqual(240)
    expect(payload?.reason?.length).toBeLessThanOrEqual(160)
    expect(payload?.invariant?.length).toBeLessThanOrEqual(160)

    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain('client-secret')
    expect(serialized).not.toContain(longHex)
    expect(serialized).toContain('[url-redacted]')
    expect(serialized).toContain('[hex-redacted]')
  })

  it('fingerprints normalized client diagnostics after preserving error details', () => {
    const first = normalizeClientObservabilityPayload({ event: 'tx_execute_failed' }, new Error('first rpc failure'))
    const second = normalizeClientObservabilityPayload({ event: 'tx_execute_failed' }, new Error('second rpc failure'))

    expect(first?.fingerprint).toMatch(/^[0-9a-f]{8}$/)
    expect(second?.fingerprint).toMatch(/^[0-9a-f]{8}$/)
    expect(first?.fingerprint).not.toBe(second?.fingerprint)
  })
})
