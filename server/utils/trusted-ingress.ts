import type { H3Event } from 'h3'

export const TRUSTED_INGRESS_SECRET_HEADER = 'x-euler-edge-origin-secret'

function getTrustedIngressSecret(): string | undefined {
  return process.env.EDGE_ORIGIN_SECRET?.trim() || undefined
}

export function isTrustedIngressRequest(event: H3Event): boolean {
  const expected = getTrustedIngressSecret()
  if (!expected) return false

  return event.node.req.headers[TRUSTED_INGRESS_SECRET_HEADER] === expected
}
