import { computed, ref } from 'vue'
import { useConfig } from '@wagmi/vue'
import { getAccount, watchAccount } from '@wagmi/vue/actions'
import { getSafeWalletProvider, type WalletConnectorLike } from '~/utils/safeWalletTransactions'
import { createRaceGuard } from '~/utils/race-guard'

const isSafeWalletRef = ref(false)
// False from the moment a connector change is observed until its detection
// probe lands. Consumers that must not act on a stale/unknown answer (e.g.
// permit2 gating) treat "unresolved" as fail-closed.
const isResolvedRef = ref(false)
const detectionGuard = createRaceGuard()
let watcherInitialized = false

const updateFromConnector = async (connector: WalletConnectorLike | undefined) => {
  const generation = detectionGuard.next()
  if (!connector) {
    isSafeWalletRef.value = false
    isResolvedRef.value = true
    return
  }
  // Fail closed on transition: a previous connector's Safe answer must not
  // survive into the new connector's pending window, or display consumers
  // would transiently treat an EOA as a Safe.
  isSafeWalletRef.value = false
  isResolvedRef.value = false
  // Detection needs the connector provider (WalletConnect identifies Safe
  // via peer metadata), so it resolves asynchronously; the guard discards
  // results that arrive after the connector changed again.
  const provider = await getSafeWalletProvider(connector).catch(() => undefined)
  if (!detectionGuard.isStale(generation)) {
    isSafeWalletRef.value = Boolean(provider)
    isResolvedRef.value = true
  }
}

/**
 * Reactive "the connected wallet is a Safe multisig" signal, shared
 * app-wide. Detection matches `getSafeWalletProvider`: the wagmi `safe`
 * iframe connector, a Safe-named connector, or a WalletConnect session with
 * Safe's official peer metadata.
 *
 * `isSafeWalletResolved` is false while detection for the current connector
 * is still pending — `isSafeWallet` is not an answer until it turns true.
 *
 * The wagmi subscription is created once, on the first client-side call
 * (which must happen in a setup context so `useConfig()` can inject), and
 * lives for the app's lifetime.
 */
export const useSafeWallet = () => {
  if (!import.meta.server && !watcherInitialized) {
    watcherInitialized = true
    const config = useConfig()
    void updateFromConnector(getAccount(config).connector)
    watchAccount(config, {
      onChange: (account) => {
        void updateFromConnector(account.connector)
      },
    })
  }

  return {
    isSafeWallet: computed(() => isSafeWalletRef.value),
    isSafeWalletResolved: computed(() => isResolvedRef.value),
  }
}
