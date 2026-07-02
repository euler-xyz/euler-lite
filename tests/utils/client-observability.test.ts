import { describe, expect, it } from 'vitest'
import {
  isUserRejectedError,
  normalizeClientObservabilityPayload,
  routeTemplate,
  sanitizeClientObservabilityInput,
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
    }, new Error('HTTP request failed. URL: /api/rpc/42161 Request body: 0xdeadbeef'))

    expect(payload).toMatchObject({
      source: 'client',
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
    expect(sanitizeClientObservabilityInput({ source: 'client', event: 'tx_execute_failed', fingerprint: 'abc123', message: 'User rejected the request' })).toBeNull()
    expect(shouldSampleClientPayload({ ...failed!, fingerprint: '00000000' })).toBe(true)
    expect(shouldSampleClientPayload({ ...failed!, fingerprint: 'ff000000' })).toBe(false)
  })

  it('sanitizes server input and route templates', () => {
    const payload = sanitizeClientObservabilityInput({
      source: 'client',
      event: 'client_invariant_missing',
      fingerprint: 'abc123',
      message: 'boom',
      routeTemplate: '/position/1/multiply',
      walletAddress: VAULT,
      rawConsoleError: { args: ['secret'] },
      error: { kind: 'rpc-http', name: 'HttpRequestError', shortMessage: 'HTTP request failed', isTransport: true, url: 'https://private-rpc.example/key' },
    })

    expect(payload).toMatchObject({
      source: 'client',
      event: 'client_invariant_missing',
      routeTemplate: '/position/1/multiply',
      error: { kind: 'rpc-http', name: 'HttpRequestError', isTransport: true },
    })
    expect(payload?.fingerprint).toMatch(/^[0-9a-f]{8}$/)
    expect(routeTemplate(`/lend/${VAULT}/42`)).toBe('/lend/:address/:number')
    expect(JSON.stringify(payload)).not.toContain('walletAddress')
    expect(JSON.stringify(payload)).not.toContain('private-rpc')
  })

  it('fingerprints sanitized server input after preserving error details', () => {
    const first = sanitizeClientObservabilityInput({
      source: 'client',
      event: 'tx_execute_failed',
      fingerprint: 'client-sampled',
      message: 'first rpc failure',
      error: { kind: 'rpc-http', name: 'HttpRequestError', shortMessage: 'HTTP request failed', isTransport: true },
    })
    const second = sanitizeClientObservabilityInput({
      source: 'client',
      event: 'tx_execute_failed',
      fingerprint: 'client-sampled',
      message: 'second rpc failure',
      error: { kind: 'rpc-timeout', name: 'TimeoutError', shortMessage: 'Timed out', isTransport: true },
    })

    expect(first?.fingerprint).toMatch(/^[0-9a-f]{8}$/)
    expect(second?.fingerprint).toMatch(/^[0-9a-f]{8}$/)
    expect(first?.fingerprint).not.toBe(second?.fingerprint)
  })

  it('rejects forged error kind values from client input', () => {
    const payload = sanitizeClientObservabilityInput({
      source: 'client',
      event: 'client_invariant_missing',
      fingerprint: 'abc123',
      error: { kind: 'not-real', name: 'Error', shortMessage: 'boom', isTransport: true },
    })

    expect(payload?.error?.kind).toBe('unknown')
  })
})
