import { computed, ref } from 'vue'
import { useConfig } from '@wagmi/vue'
import { getAccount, watchAccount } from '@wagmi/vue/actions'
import { getSafeWalletProvider, type WalletConnectorLike } from '~/utils/safeWalletTransactions'
import { createRaceGuard } from '~/utils/race-guard'

const isSafeWalletRef = ref(false)
const detectionGuard = createRaceGuard()
let watcherInitialized = false

const updateFromConnector = async (connector: WalletConnectorLike | undefined) => {
  const generation = detectionGuard.next()
  if (!connector) {
    isSafeWalletRef.value = false
    return
  }
  // Detection needs the connector provider (WalletConnect identifies Safe
  // via peer metadata), so it resolves asynchronously; the guard discards
  // results that arrive after the connector changed again.
  const provider = await getSafeWalletProvider(connector).catch(() => undefined)
  if (!detectionGuard.isStale(generation)) {
    isSafeWalletRef.value = Boolean(provider)
  }
}

/**
 * Reactive "the connected wallet is a Safe multisig" signal, shared
 * app-wide. Detection matches `getSafeWalletProvider`: the wagmi `safe`
 * iframe connector, a Safe-named connector, or a WalletConnect session with
 * Safe's official peer metadata.
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
  }
}
