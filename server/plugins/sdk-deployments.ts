/**
 * Routes every server-side SDK build's deployment-manifest fetch through
 * the /api/internal/euler-chains resolution chain (fresh cache → upstream →
 * stale → build-time snapshot) instead of the SDK's default direct
 * raw.githubusercontent.com fetch.
 *
 * `setQueryDeployments` is a static hook, so one installation at boot
 * covers every `buildEulerSDK` call in this process: `getServerSdk`
 * (vault snapshots, labels view), the token-list SDK build, and SSR-side
 * `getEulerSdk` instances — which also skip an HTTP round-trip to our own
 * origin this way. Browser bundles run in their own realm and keep the
 * `deploymentsUrl` proxy configured in composables/useEulerSdk.ts.
 */
import type { Deployment } from '@eulerxyz/euler-v2-sdk'
import { DeploymentService } from '@eulerxyz/euler-v2-sdk'
import { loadEulerChains } from '../api/internal/euler-chains.get'

export default defineNitroPlugin(() => {
  DeploymentService.setQueryDeployments(
    () => loadEulerChains() as Promise<Deployment[]>,
  )
})
